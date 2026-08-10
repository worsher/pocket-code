// ── Message Handler ───────────────────────────────────────
// Transport-agnostic message processing logic extracted from index.ts.
// Used by both the direct WebSocket server (index.ts) and the relay daemon.

import { createSession, runAgent, type AgentSession } from "./agent.js";
import { getWorkspaceRoot } from "./tools.js";
import { buildToolRegistry } from "@pocket-code/agent-core";
import { createNodeBackend } from "./nodeBackend.js";
import { setupGitCredentials } from "./gitCredentials.js";
import { verifyToken, registerAnonymous, type AuthPayload } from "./auth.js";
import { isDockerEnabled, getContainer } from "./docker.js";
import { initDb, listUserSessions, deleteSession, saveSessionGoal } from "./db.js";
import { createGoal, goalUpdatedEvent, clearedEvent, type GoalState } from "./goal/types.js";
import { runGoalDriver } from "./goal/driver.js";
import { checkQuota, incrementUsage, getUserQuota } from "./resourceLimits.js";
import { WsMessage, type ServerOutboundType } from "@pocket-code/wire";
import { handleSyncPull, handleSyncFile } from "./sync/syncHandler.js";
import { getSessionStream, type SessionEventStream } from "./eventBuffer.js";
import { rm } from "fs/promises";

// Shared session store — the same Map is used for all handlers
const sessions = new Map<string, AgentSession>();

// TTL cleanup: remove sessions idle for more than 30 minutes
const SESSION_TTL_MS = 30 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [id, sess] of sessions) {
    if (now - (sess.lastActivity || 0) > SESSION_TTL_MS) {
      sessions.delete(id);
      console.log(`[Session] Cleaned up stale session: ${id}`);
    }
  }
}, 5 * 60 * 1000).unref();

export interface MessageHandler {
  onMessage(raw: string | Buffer): Promise<void>;
  onClose(): void;
}

export interface MessageHandlerOptions {
  /** Pre-injected auth (used by Daemon relay mode to bypass token verification) */
  preAuth?: AuthPayload;
}

/**
 * Create a transport-agnostic message handler.
 *
 * @param send - Callback to send a response back to the client.
 *               The handler doesn't care if this goes to a direct WS or through a relay.
 *               Typed as ServerOutboundType so every construction site is checked
 *               against the wire contract at compile time.
 * @param options - Optional configuration including pre-injected auth.
 */
export function createMessageHandler(
  send: (data: ServerOutboundType) => void,
  options?: MessageHandlerOptions
): MessageHandler {
  let session: AgentSession | null = null;
  let auth: AuthPayload | null = options?.preAuth || null;
  let activeSessionId: string | null = null;
  // P14:本连接订阅的 session 事件流(publish 分配 seq + fan-out;abort 移到 session 级)
  let stream: SessionEventStream | null = null;
  let unsubscribe: (() => void) | null = null;

  return {
    async onMessage(raw: string | Buffer) {
      try {
        const raw_msg = JSON.parse(raw.toString());
        const parsed = WsMessage.safeParse(raw_msg);
        if (!parsed.success) {
          const errMsg = parsed.error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; ");
          console.log(
            "[Handler] Validation failed for type:",
            raw_msg?.type,
            "errors:",
            errMsg
          );
          send({ type: "error", error: `Invalid message: ${errMsg}` });
          return;
        }
        const msg = parsed.data;
        console.log("[Handler] Received:", msg.type);

        switch (msg.type) {
          // ── Anonymous registration ─────────────────────
          case "register": {
            console.log(
              "[Handler] Processing register, deviceId:",
              msg.deviceId
            );
            const deviceId = msg.deviceId;
            if (!deviceId) {
              send({ type: "error", error: "deviceId is required" });
              return;
            }
            const result = registerAnonymous(deviceId);
            if ("error" in result) {
              send({ type: "error", error: result.error });
              return;
            }
            console.log("[Handler] Register success, userId:", result.userId);
            send({
              type: "auth",
              token: result.token,
              userId: result.userId,
            } satisfies ServerOutboundType);
            break;
          }

          // ── Session init (requires auth) ───────────────
          case "init": {
            console.log(
              "[Handler] Processing init, token present:",
              !!msg.token,
              "sessionId:",
              msg.sessionId,
              "preAuth:",
              !!auth
            );
            // Only verify token if auth is not already pre-injected
            if (msg.token && !auth) {
              auth = verifyToken(msg.token);
            }
            if (!auth) {
              console.log("[Handler] Init failed: invalid or missing token");
              send({
                type: "error",
                error: "Invalid or missing token. Send register first.",
              });
              return;
            }
            console.log("[Handler] Auth verified, userId:", auth.userId);

            const sessionId = msg.sessionId || crypto.randomUUID();
            const projectId: string = msg.projectId || "";
            if (sessions.has(sessionId)) {
              session = sessions.get(sessionId)!;
              if (session.userId !== auth.userId) {
                send({
                  type: "error",
                  error: "Session does not belong to this user.",
                });
                session = null;
                return;
              }
            } else {
              session = await createSession(sessionId, auth.userId, projectId);
              sessions.set(sessionId, session);
            }
            activeSessionId = sessionId;
            session.lastActivity = Date.now();

            // Docker isolation
            if (isDockerEnabled() && !session.containerId) {
              try {
                session.containerId = await getContainer(
                  auth.userId,
                  session.workspace
                );
                console.log(
                  `[Handler] Docker container: ${session.containerId.slice(0, 12)}`
                );
              } catch (err: any) {
                console.error(
                  "[Handler] Failed to create Docker container:",
                  err.message
                );
              }
            }
            if (msg.model) {
              session.modelKey = msg.model;
            }
            if (msg.customPrompt !== undefined) {
              session.customPrompt = msg.customPrompt || undefined;
            }
            if (msg.gitCredentials && msg.gitCredentials.length > 0) {
              try {
                await setupGitCredentials(
                  session.workspace,
                  msg.gitCredentials as any
                );
              } catch (err: any) {
                console.error(
                  "[Handler] Failed to setup git credentials:",
                  err.message
                );
              }
            }
            // ── P14:订阅事件流 + 发 ack(带游标)+ 补发协商 ──
            // 先订阅后补发(D-P14-5):避免"ack 后、订阅前"的事件真空;
            // 交错产生的重复由客户端 (epoch, seq) 去重兜底(C14-3)。
            stream = getSessionStream(session.sessionId);
            unsubscribe?.();
            unsubscribe = stream.subscribe(send);
            send({
              type: "session",
              sessionId: session.sessionId,
              projectId: session.projectId,
              workspace: session.workspace,
              eventEpoch: stream.epoch,
              currentSeq: stream.seq,
            } satisfies ServerOutboundType);
            if (msg.lastSeq !== undefined) {
              if (msg.eventEpoch !== stream.epoch) {
                send({
                  type: "resync-required",
                  reason: "epoch-changed",
                  eventEpoch: stream.epoch,
                  currentSeq: stream.seq,
                } satisfies ServerOutboundType);
              } else {
                const backlog = stream.readSince(msg.lastSeq);
                if (backlog === null) {
                  send({
                    type: "resync-required",
                    reason: "buffer-overflow",
                    eventEpoch: stream.epoch,
                    currentSeq: stream.seq,
                  } satisfies ServerOutboundType);
                } else {
                  for (const ev of backlog) send(ev); // C14-5:ack 后按 seq 升序补齐
                }
              }
            }
            break;
          }

          case "message": {
            if (!session) {
              send({ type: "error", error: "No session. Send init first." });
              return;
            }
            session.lastActivity = Date.now();
            if (auth) {
              const quotaCheck = checkQuota(auth.userId, "api_call");
              if (!quotaCheck.allowed) {
                send({ type: "error", error: quotaCheck.reason || "Quota exceeded." });
                send({ type: "done" });
                return;
              }
              incrementUsage(auth.userId, "api_call");
            }
            if (msg.model) {
              session.modelKey = msg.model;
            }
            if (msg.customPrompt !== undefined) {
              session.customPrompt = msg.customPrompt || undefined;
            }

            // Conversation branching
            if (typeof msg.rewindTo === "number" && msg.rewindTo >= 0) {
              session.messages = session.messages.slice(0, msg.rewindTo);
            }

            // P14:事件经 stream.publish(分配 seq + 广播给全部订阅者,含本连接)——
            // 不得再直接 send,否则本连接收到双份。abort 挂 session(D-P14-3)。
            const abort = new AbortController();
            const sess = session;
            const sessStream = stream ?? getSessionStream(sess.sessionId);
            sess.currentAbort = abort;
            await runAgent(
              sess,
              msg.content,
              (event) => {
                sessStream.publish(event);
              },
              abort.signal,
              msg.images
            );
            sess.currentAbort = undefined;
            break;
          }

          case "get-quota": {
            if (!auth) {
              send({ type: "error", error: "Not authenticated." });
              return;
            }
            const quota = getUserQuota(auth.userId);
            send({
              type: "quota",
              userId: quota.userId,
              tier: quota.tier,
              limits: quota.limits as unknown as Record<string, unknown>,
              usage: quota.usage as unknown as Record<string, unknown>,
            });
            break;
          }

          // ── Geek mode: execute a single tool on demand ──
          case "tool-exec": {
            if (!session) {
              send({ type: "error", error: "No session. Send init first." });
              return;
            }
            const { toolName, args } = msg;
            const callId = msg.callId ?? "";
            const registry = buildToolRegistry(
              createNodeBackend(session.workspace, session.containerId),
              session.workspace
            );
            if (!registry.has(toolName)) {
              send({ type: "tool-result", callId, result: { success: false, error: `Unknown tool: ${toolName}` } } satisfies ServerOutboundType);
              break;
            }
            try {
              const result = await registry.run(toolName, args);
              send({ type: "tool-result", callId, result } satisfies ServerOutboundType);
            } catch (err: any) {
              send({ type: "tool-result", callId, result: { success: false, error: err.message } } satisfies ServerOutboundType);
            }
            break;
          }

          // ── File operations ──
          case "list-files": {
            if (!session) {
              send({ type: "error", error: "No session. Send init first." });
              return;
            }
            const listRegistry = buildToolRegistry(
              createNodeBackend(session.workspace, session.containerId),
              session.workspace
            );
            try {
              const result = await listRegistry.run("listFiles", {
                path: msg.path || ".",
              });
              send({
                type: "file-list",
                path: msg.path || ".",
                _reqId: msg._reqId,
                ...(result as Record<string, unknown>),
              } as ServerOutboundType);
            } catch (err: any) {
              send({
                type: "file-list",
                path: msg.path || ".",
                _reqId: msg._reqId,
                success: false,
                error: err.message,
              });
            }
            break;
          }

          case "read-file": {
            if (!session) {
              send({ type: "error", error: "No session. Send init first." });
              return;
            }
            const readRegistry = buildToolRegistry(
              createNodeBackend(session.workspace, session.containerId),
              session.workspace
            );
            try {
              const result = await readRegistry.run("readFile", {
                path: msg.path,
              });
              send({
                type: "file-content",
                path: msg.path,
                _reqId: msg._reqId,
                ...(result as Record<string, unknown>),
              } as ServerOutboundType);
            } catch (err: any) {
              send({
                type: "file-content",
                path: msg.path,
                _reqId: msg._reqId,
                success: false,
                error: err.message,
              });
            }
            break;
          }

          // ── Code sync (shadow snapshot) ──
          case "sync-pull": {
            if (!session) {
              send({ type: "error", error: "No session. Send init first." });
              return;
            }
            try {
              await handleSyncPull(session.workspace, msg.sinceCommit ?? null, send, msg._reqId);
            } catch (err: any) {
              send({ type: "error", error: `sync-pull failed: ${err.message}` });
            }
            break;
          }

          case "sync-file": {
            if (!session) {
              send({ type: "error", error: "No session. Send init first." });
              return;
            }
            try {
              await handleSyncFile(session.workspace, msg.commit, msg.path, send, msg._reqId);
            } catch (err: any) {
              send({ type: "error", error: `sync-file failed: ${err.message}` });
            }
            break;
          }

          // ── Session management ──
          case "list-sessions": {
            if (!auth) {
              send({ type: "error", error: "Not authenticated." });
              return;
            }
            const projectFilter: string | undefined =
              msg.projectId || undefined;
            const userSessions = listUserSessions(
              auth.userId,
              msg.limit || 50,
              projectFilter
            );
            send({
              type: "sessions-list",
              sessions: userSessions as unknown as Record<string, unknown>[],
            });
            break;
          }

          case "delete-session": {
            if (!auth) {
              send({ type: "error", error: "Not authenticated." });
              return;
            }
            const deleted = deleteSession(msg.sessionId, auth.userId);
            send({
              type: "session-deleted",
              sessionId: msg.sessionId,
              success: deleted,
            } satisfies ServerOutboundType);
            break;
          }

          case "delete-project-workspace": {
            if (!auth) {
              send({ type: "error", error: "Not authenticated." });
              return;
            }
            const { projectId: delProjectId } = msg;
            if (!delProjectId) {
              send({ type: "error", error: "projectId is required." });
              return;
            }
            const projectSessions = listUserSessions(
              auth.userId,
              1,
              delProjectId
            );
            if (projectSessions.length === 0) {
              send({
                type: "project-workspace-deleted",
                projectId: delProjectId,
                success: false,
                error: "No sessions found for this project.",
              } satisfies ServerOutboundType);
              return;
            }
            const workspacePath = getWorkspaceRoot({
              sessionId: "",
              projectId: delProjectId,
              userId: auth.userId,
            });
            try {
              await rm(workspacePath, { recursive: true, force: true });
              send({
                type: "project-workspace-deleted",
                projectId: delProjectId,
                success: true,
              } satisfies ServerOutboundType);
            } catch (err: any) {
              send({
                type: "project-workspace-deleted",
                projectId: delProjectId,
                success: false,
                error: err.message,
              } satisfies ServerOutboundType);
            }
            break;
          }

          // ── P16:Goal 模式 ──
          case "goal-create": {
            if (!session) {
              send({ type: "error", error: "No session. Send init first." });
              return;
            }
            if (session.goal && !msg.replace) {
              send({ type: "error", error: "已有进行中的目标,重复创建需 replace" });
              return;
            }
            session.lastActivity = Date.now();
            session.goal = createGoal(msg.content, msg.acceptance, msg.maxTurns);
            saveSessionGoal(session.sessionId, JSON.stringify(session.goal));
            const goalStream = stream ?? getSessionStream(session.sessionId);
            goalStream.publish(goalUpdatedEvent(session.goal, "lifecycle"));
            await runGoalDriver(session, {
              runAgent,
              persistGoal: (sid: string, g: GoalState | null) =>
                saveSessionGoal(sid, g ? JSON.stringify(g) : null),
              publish: (ev) => {
                goalStream.publish(ev);
              },
            });
            break;
          }

          case "goal-control": {
            if (!session) {
              send({ type: "error", error: "No session. Send init first." });
              return;
            }
            const g = session.goal;
            const ctlStream = stream ?? getSessionStream(session.sessionId);
            switch (msg.action) {
              case "pause":
                // 先置态后 abort:driver 在 turn 返回后读到 paused 停车并发通告(单一事件源)
                if (g && g.status === "active") {
                  g.status = "paused";
                  g.stopReason = "用户暂停";
                  g.updatedAt = Date.now();
                  saveSessionGoal(session.sessionId, JSON.stringify(g));
                  session.currentAbort?.abort();
                }
                break;
              case "resume":
                if (g && (g.status === "paused" || g.status === "blocked")) {
                  g.status = "active";
                  g.stopReason = undefined; // C16-5:resume 清 stopReason,新的尝试
                  g.updatedAt = Date.now();
                  saveSessionGoal(session.sessionId, JSON.stringify(g));
                  ctlStream.publish(goalUpdatedEvent(g, "lifecycle"));
                  await runGoalDriver(session, {
                    runAgent,
                    persistGoal: (sid: string, gg: GoalState | null) =>
                      saveSessionGoal(sid, gg ? JSON.stringify(gg) : null),
                    publish: (ev) => {
                      ctlStream.publish(ev);
                    },
                  });
                }
                break;
              case "cancel":
                if (g) {
                  session.currentAbort?.abort();
                  ctlStream.publish(clearedEvent(g.stats));
                  session.goal = undefined;
                  saveSessionGoal(session.sessionId, null);
                }
                break;
            }
            break;
          }

          case "abort": {
            // session 级 abort:断线前启动的 turn 也能被重连后的新连接停止(D-P14-3)
            if (session?.currentAbort) {
              session.currentAbort.abort();
              session.currentAbort = undefined;
            }
            break;
          }

          default: {
            send({
              type: "error",
              error: `Unknown message type: ${(msg as any).type}`,
            });
          }
        }
      } catch (err: any) {
        console.error("[Handler] Error:", err.message);
        send({ type: "error", error: `Server error: ${err.message}` });
      }
    },

    onClose() {
      // P14 C14-6:transport 断开不再 abort 进行中的 turn——事件继续产出进
      // eventBuffer,重连后经 init 协商补发。abort 仅由显式 abort 消息触发。
      unsubscribe?.();
      unsubscribe = null;
      stream = null;
      session = null;
      auth = null;
      activeSessionId = null;
    },
  };
}
