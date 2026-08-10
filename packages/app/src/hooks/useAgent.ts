// ── useAgent:瘦组合层 ─────────────────────────────────────
// P6b:传输交给 ServerConnection,UI 更新交给 chatReducer(applyAgentEvent
// /phaseFor)。云端与 geek 共用同一 reducer,对外 API 面保持不变。
import { useState, useRef, useCallback, useEffect } from "react";
import { AppState } from "react-native";
import { randomUUID } from "expo-crypto";
import {
  createWorkspaceScope,
  isSameWorkspaceScope,
  parseLegacyProjectId,
  type WorkspaceHandle,
  type WorkspaceScope,
} from "@pocket-code/workspace-core";
import { WORKSPACE_FEATURE_FLAGS } from "../services/workspaceFeatureFlags";
import { recordWorkspaceMetric } from "../services/workspaceTelemetry";
import { getModelConfig, getApiKeyField, MODELS } from "../services/modelConfig";
import { updateSettings, type AppSettings } from "../store/settings";
import { saveChatHistory, loadChatHistory } from "../store/chatHistory";
import { deleteLocalFile, executeLocalTool, writeLocalFile } from "../services/localFileSystem";
import {
  enqueueMessage,
  getQueueForScope,
  dequeueMessage,
  rebindProvisionalQueue,
} from "../services/offlineQueue";
import { getWorkspaceConnectionKey, usesRemoteWorkspace } from "../services/workspaceConnection";
import type { RemoteReplicaCatalogEntry } from "../store/projectCatalog";
import { sendLocalNotification } from "../services/notifications";
import {
  ServerConnection,
  applyAgentEvent,
  phaseFor,
  truncateCoreHistory,
  storedToCoreMessages,
} from "@pocket-code/client-core";
import type {
  ConnectionConfig,
  ConnectionHandlers,
  StreamingPhase,
  StoredMessage,
  Message,
  ImageAttachment,
} from "@pocket-code/client-core";
import { createRnModelClient } from "../services/rnModelClient";
import { createDeviceBackend } from "../services/deviceBackend";
import {
  runAgentLoop,
  compactHistory,
  buildSystemPrompt,
  type CoreMessage,
  type LoopStopReason,
} from "@pocket-code/agent-core";
import type {
  AgentEventType,
  WorkspaceImportSourceType,
  WorkspaceProjectCatalogEntryType,
  WorkspaceSessionScopeType,
} from "@pocket-code/wire";

// ── Public Types(re-export) ───────────────────────────────
export type { StreamingPhase, Message, ToolCall, ImageAttachment } from "@pocket-code/client-core";

export interface ModelInfo {
  key: string;
  label: string;
  description: string;
}
export const AVAILABLE_MODELS: ModelInfo[] = MODELS.map((m) => ({
  key: m.key,
  label: m.label,
  description: m.description,
}));

// ── Hook Options ───────────────────────────────────────
interface UseAgentOptions {
  settings: AppSettings;
  model?: string;
  customPrompt?: string;
  projectId?: string;
  legacyProjectId?: string;
  projectName?: string;
  workspaceReplicaId?: string;
  workspaceGeneration?: number;
  remoteReplicas?: RemoteReplicaCatalogEntry[];
  workspaceHandle?: WorkspaceHandle | null;
  workspaceRoot?: string;
  /** Called when AI modifies a file (writeFile/editFile). Used by WorkspaceContext for auto-refresh. */
  onFileChanged?: (path: string, action: "created" | "modified" | "deleted") => void;
  /** Persist a server-authoritative replica into the current project catalog. */
  onRemoteReplica?: (
    projectId: string,
    replica: RemoteReplicaCatalogEntry,
    displayName?: string,
    importSource?: WorkspaceImportSourceType
  ) => void;
}

// ── Sync filtering ────────────────────────────────────────
const SYNC_IGNORE_DIRS = [
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".cache",
  "__pycache__",
  ".tox",
  "vendor",
];
const SYNC_IGNORE_EXTENSIONS = [".lock", ".log"];
const SYNC_IGNORE_FILES = [".gitconfig", ".git-credentials"];
const MAX_SYNC_FILE_SIZE = 512 * 1024; // 512KB

function migrationSafeLegacyProjectId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return parseLegacyProjectId(value);
  } catch {
    return undefined;
  }
}

function shouldSyncFile(filePath: string): boolean {
  const parts = filePath.split("/");
  if (parts.some((p) => SYNC_IGNORE_DIRS.includes(p))) return false;
  if (SYNC_IGNORE_EXTENSIONS.some((ext) => filePath.endsWith(ext))) return false;
  const fileName = parts[parts.length - 1] || "";
  if (SYNC_IGNORE_FILES.includes(fileName)) return false;
  return true;
}

/** 后台(App 非 active)runCommand 完成通知 */
function notifyRunCommand(result: unknown) {
  if (AppState.currentState === "active") return;
  const res = result as { success?: boolean; stdout?: string; stderr?: string; error?: string };
  const ok = res?.success !== false;
  const firstLine = (res?.stdout || res?.stderr || res?.error || "")
    .trim()
    .split("\n")[0]
    .slice(0, 80);
  sendLocalNotification(
    ok ? "命令执行完成 ✓" : "命令执行失败 ✗",
    firstLine || (ok ? "命令已完成" : "命令执行失败")
  );
}

const mkUserMsg = (content: string, images?: ImageAttachment[]): Message => ({
  id: Date.now().toString(),
  role: "user",
  content,
  images,
  timestamp: Date.now(),
});
const mkAssistantMsg = (): Message => ({
  id: (Date.now() + 1).toString(),
  role: "assistant",
  content: "",
  toolCalls: [],
  timestamp: Date.now(),
});

// ── Main Hook ──────────────────────────────────────────
export function useAgent({
  settings,
  model = "deepseek-v4-flash",
  customPrompt,
  projectId,
  legacyProjectId,
  projectName,
  workspaceReplicaId,
  workspaceGeneration,
  remoteReplicas,
  workspaceHandle,
  workspaceRoot,
  onFileChanged,
  onRemoteReplica,
}: UseAgentOptions) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [streamingPhase, setStreamingPhase] = useState<StreamingPhase>("idle");
  const [currentToolName, setCurrentToolName] = useState<string | undefined>();
  // 设备授权失效(token 被 daemon 拒绝):非空表示需要重新配对
  const [authError, setAuthError] = useState<string | null>(null);
  // 上一轮 done 的 stopReason(max_steps → UI 提示"点击继续");发新消息时清空
  const [lastStopReason, setLastStopReason] = useState<LoopStopReason | null>(null);
  // 流式过程中的瞬时提醒(重试中/媒体降级);text-delta/done/error 即清
  const [streamNotice, setStreamNotice] = useState<string | null>(null);
  // P15:压缩提示(发新消息时清)与编辑重发保护下标(本会话内持续,D-P15-3)
  const [compactionNotice, setCompactionNotice] = useState<string | null>(null);
  const [editCutoff, setEditCutoff] = useState(0);
  // P16:goal 卡片状态(completion/cleared 后为 null)
  const [goalState, setGoalState] = useState<{
    status: "active" | "paused" | "blocked" | "complete";
    goal?: string;
    stopReason?: string;
    stats: { turns: number; inputTokens: number; outputTokens: number };
    maxTurns?: number;
  } | null>(null);
  // 最新值 refs(避免 handler/闭包中的 stale closure)
  const abortRef = useRef<AbortController | null>(null);
  const modelRef = useRef(model);
  modelRef.current = model;
  const customPromptRef = useRef(customPrompt);
  customPromptRef.current = customPrompt;
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;
  const legacyProjectIdRef = useRef(legacyProjectId);
  legacyProjectIdRef.current = legacyProjectId;
  const projectNameRef = useRef(projectName);
  projectNameRef.current = projectName;
  const workspaceReplicaIdRef = useRef(workspaceReplicaId);
  workspaceReplicaIdRef.current = workspaceReplicaId;
  const workspaceGenerationRef = useRef(workspaceGeneration);
  workspaceGenerationRef.current = workspaceGeneration;
  const remoteReplicasRef = useRef(remoteReplicas);
  remoteReplicasRef.current = remoteReplicas;
  const workspaceHandleRef = useRef(workspaceHandle);
  workspaceHandleRef.current = workspaceHandle;
  const workspaceRootRef = useRef(workspaceRoot);
  workspaceRootRef.current = workspaceRoot;
  const onFileChangedRef = useRef(onFileChanged);
  onFileChangedRef.current = onFileChanged;
  const onRemoteReplicaRef = useRef(onRemoteReplica);
  onRemoteReplicaRef.current = onRemoteReplica;
  const workspaceModeRef = useRef(settings.workspaceMode);
  workspaceModeRef.current = settings.workspaceMode;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const gitCredentialsRef = useRef(settings.gitCredentials);
  gitCredentialsRef.current = settings.gitCredentials;
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const isStreamingRef = useRef(isStreaming);
  isStreamingRef.current = isStreaming;
  const goalStateRef = useRef(goalState);
  goalStateRef.current = goalState;
  // loadSession 定义在 handlers 单例块之后 → handlers 内经 ref 间接引用(P14 resync)
  const loadSessionRef = useRef<((sid: string) => Promise<void>) | null>(null);
  const modeRef = useRef(settings.mode);
  modeRef.current = settings.mode;
  const authTokenRef = useRef(settings.authToken);
  authTokenRef.current = settings.authToken;
  const deviceIdRef = useRef(settings.deviceId);
  deviceIdRef.current = settings.deviceId;

  const activeRemoteReplicaRef = useRef<{
    connectionKey: string;
    entry: RemoteReplicaCatalogEntry;
  } | null>(null);

  const getRetainedRemoteReplica = (): RemoteReplicaCatalogEntry | null => {
    const connectionKey = getWorkspaceConnectionKey(settingsRef.current);
    if (!connectionKey) return null;
    const active = activeRemoteReplicaRef.current;
    if (active?.connectionKey === connectionKey) return active.entry;
    return (
      remoteReplicasRef.current
        ?.filter((entry) => entry.connectionKey === connectionKey)
        .sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null
    );
  };

  const getCurrentWorkspaceScope = (): WorkspaceScope | null => {
    const currentProjectId = projectIdRef.current;
    const remoteReplica = usesRemoteWorkspace(settingsRef.current)
      ? getRetainedRemoteReplica()
      : null;
    const currentReplicaId = remoteReplica?.id ?? workspaceReplicaIdRef.current;
    const currentSessionId = sessionIdRef.current;
    const currentGeneration = remoteReplica?.generation ?? workspaceGenerationRef.current;
    if (
      !currentProjectId ||
      !currentReplicaId ||
      !currentSessionId ||
      currentGeneration === undefined
    ) {
      return null;
    }
    try {
      return createWorkspaceScope({
        projectId: currentProjectId,
        replicaId: currentReplicaId,
        sessionId: currentSessionId,
        workspaceGeneration: currentGeneration,
      });
    } catch {
      return null;
    }
  };
  // callId → toolName(runCommand 后台通知需知道工具名)
  const callNamesRef = useRef(new Map<string, string>());
  // geek 会话的 CoreMessage 史(与 UI messages 并行维护,供 runAgentLoop 使用)。
  // 重置点与 setMessages([]) 同点:newSession、项目切换 effect ——重置为 []。
  // loadSession 是例外(I1 修复):从存档的 StoredMessage[] 用
  // storedToCoreMessages(...) 重建 CoreMessage[] 历史,而不是重置为空,
  // 这样 load 一个旧会话后立即在 geek 模式续聊,模型仍能看到之前的对话上下文。
  const coreHistoryRef = useRef<CoreMessage[]>([]);

  const serverUrl =
    settings.mode === "geek"
      ? settings.toolServerUrl
      : settings.workspaceMode === "relay"
        ? settings.relayServerUrl || "wss://relay.your-vps.com"
        : settings.cloudServerUrl;
  const serverUrlRef = useRef(serverUrl);
  serverUrlRef.current = serverUrl;

  // 需自动连接:cloud 恒真;geek+server(Termux)恒真;geek+local 否(runCommand 惰性回退)
  const needsAutoConnect = settings.mode === "cloud" || settings.workspaceMode === "server";

  /** Generate or retrieve a persistent deviceId */
  const getDeviceId = useCallback((): string => {
    if (deviceIdRef.current) return deviceIdRef.current;
    const id = `dev_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    updateSettings({ deviceId: id }); // Persist (fire-and-forget)
    deviceIdRef.current = id;
    return id;
  }, []);

  const saveMessages = useCallback((msgs: Message[], sid: string | null) => {
    if (!sid || msgs.length === 0) return;
    saveChatHistory(sid, msgs as StoredMessage[], projectIdRef.current || "").catch(() => {});
  }, []);

  // ── done 收敛(云端 & geek 共用) ─────────────────────
  const finalizeStreaming = useCallback(() => {
    setIsStreaming(false);
    setStreamingPhase("idle");
    setCurrentToolName(undefined);
    saveMessages(messagesRef.current, sessionIdRef.current);
    if (AppState.currentState !== "active") {
      const lastMsg = messagesRef.current[messagesRef.current.length - 1];
      const summary = lastMsg?.content?.slice(0, 100) || "任务已完成";
      sendLocalNotification("Pocket Code", summary);
    }
  }, [saveMessages]);

  // ── 重试/降级瞬时提醒(cloud & geek 共用,P13)─────────────
  const applyStreamNotice = useCallback(
    (ev: AgentEventType) => {
      switch (ev.type) {
        case "step-retrying":
          setStreamNotice(`网络波动,正在重试(第 ${ev.nextAttempt}/${ev.maxAttempts} 次)…`);
          break;
        case "media-degraded":
          setStreamNotice(
            ev.level === "degraded"
              ? "请求过大:已临时省略较早的图片(保留最近一张)"
              : "请求过大:本轮已临时省略全部图片"
          );
          break;
        case "history-compacted":
          setCompactionNotice(
            `已压缩 ${ev.compactedMessages} 条早期消息以释放上下文(约 ${ev.tokensBefore}→${ev.tokensAfter} tokens)`
          );
          setEditCutoff(messagesRef.current.length); // 压缩点之前禁用编辑重发(D-P15-3)
          break;
        case "goal-updated": {
          if (ev.change === "completion") {
            sendLocalNotification("目标已完成 ✓", ev.goal ?? "");
            setGoalState(null);
          } else if (ev.change === "cleared") {
            setGoalState(null);
          } else {
            setGoalState({
              status: ev.status,
              goal: ev.goal,
              stopReason: ev.stopReason,
              stats: ev.stats,
              maxTurns: ev.maxTurns,
            });
            if (ev.status === "blocked") {
              sendLocalNotification("目标受阻", ev.stopReason ?? ev.goal ?? "");
            }
          }
          // goal 终局/停车:收敛 streaming 态(done 在 goal active 时被跳过收敛,D-P16-7),
          // 顺带修剪 done 处预插的尾部空占位气泡。
          if (ev.change !== "lifecycle" || ev.status !== "active") {
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              return last && last.role === "assistant" && !last.content && !last.toolCalls?.length
                ? prev.slice(0, -1)
                : prev;
            });
            finalizeStreaming();
          }
          break;
        }
        case "text-delta": // 恢复输出即清提醒(setState 同值时 React 自动跳过)
        case "error":
        case "done":
          setStreamNotice(null);
          break;
      }
    },
    [finalizeStreaming]
  );

  // ── 单例 ServerConnection(惰性创建) ───────────────────
  const connRef = useRef<ServerConnection | null>(null);
  if (!connRef.current) {
    const config: ConnectionConfig = {
      getServerUrl: () => serverUrlRef.current,
      isRelayMode: () => workspaceModeRef.current === "relay",
      getRelayOptions: () => ({
        machineId: settingsRef.current.relayMachineId || "",
        deviceId: getDeviceId(),
        token: settingsRef.current.relayToken,
      }),
      getAuthToken: () => authTokenRef.current,
      getDeviceId,
      buildInitPayload: () => ({
        ...(WORKSPACE_FEATURE_FLAGS.protocolV2 ? { workspaceProtocolVersion: 2 as const } : {}),
        sessionId: sessionIdRef.current,
        projectId: projectIdRef.current || undefined,
        legacyProjectId: migrationSafeLegacyProjectId(legacyProjectIdRef.current),
        projectName: projectNameRef.current || undefined,
        model: modelRef.current,
        gitCredentials: gitCredentialsRef.current?.filter((c) => c.token) || [],
      }),
      isRelayPaired: () => !!(settingsRef.current.relayToken && settingsRef.current.relayMachineId),
      onTokenPersist: (token, machineId) =>
        updateSettings({ relayToken: token, relayMachineId: machineId }),
    };

    const handlers: ConnectionHandlers = {
      onAgentEvent: (ev: AgentEventType) => {
        // geek 模式的事件由本地适配层 emitGeek 产生,忽略来自服务器的流式事件
        if (modeRef.current === "geek") return;

        setMessages((prev) => applyAgentEvent(prev, ev));
        const p = phaseFor(ev);
        if (p) setStreamingPhase(p);
        applyStreamNotice(ev);

        switch (ev.type) {
          case "tool-call":
            setCurrentToolName(ev.name);
            callNamesRef.current.set(ev.callId, ev.name);
            // cloud 模式既有延迟转换:tool-call 后短暂进入 tool-running
            setTimeout(() => setStreamingPhase("tool-running"), 100);
            break;
          case "tool-result": {
            setCurrentToolName(undefined);
            const name = callNamesRef.current.get(ev.callId);
            if (name === "runCommand") notifyRunCommand(ev.result);
            callNamesRef.current.delete(ev.callId);
            break;
          }
          case "done":
            callNamesRef.current.clear();
            // CLI 委托路径缺省 stopReason,按 end_turn 解释(spec C12-4)
            setLastStopReason(ev.stopReason ?? "end_turn");
            // P16 D-P16-7:goal 续跑的多轮输出用新气泡分隔,否则全堆进同一 assistant
            if (goalStateRef.current?.status === "active") {
              setMessages((prev) => [...prev, mkAssistantMsg()]);
              setIsStreaming(true); // goal 仍在续跑,不收敛 streaming 态
              break;
            }
            finalizeStreaming();
            break;
          case "error":
            // reducer 已追加错误文案,这里只收敛 streaming 状态
            setIsStreaming(false);
            setStreamingPhase("idle");
            setCurrentToolName(undefined);
            break;
        }
      },
      onAuth: (token: string, userId: string) => {
        updateSettings({ authToken: token, userId });
        authTokenRef.current = token;
      },
      onSession: (
        sid: string,
        workspaceScope?: WorkspaceSessionScopeType,
        workspaceCatalog?: WorkspaceProjectCatalogEntryType[]
      ) => {
        sessionIdRef.current = sid;
        setSessionId(sid);
        const previousScope = getCurrentWorkspaceScope();
        const connectionKey = getWorkspaceConnectionKey(settingsRef.current);
        if (connectionKey && workspaceCatalog) {
          for (const project of workspaceCatalog) {
            onRemoteReplicaRef.current?.(
              project.projectId,
              {
                id: project.replicaId,
                generation: project.workspaceGeneration,
                kind: project.replicaKind,
                authorityId: project.authorityId,
                connectionKey,
                updatedAt: Date.now(),
              },
              project.displayName,
              project.importSource
            );
          }
        }
        if (workspaceScope) {
          if (connectionKey) {
            const entry: RemoteReplicaCatalogEntry = {
              id: workspaceScope.replicaId,
              generation: workspaceScope.workspaceGeneration,
              kind: workspaceScope.replicaKind,
              authorityId: workspaceScope.authorityId,
              connectionKey,
              updatedAt: Date.now(),
            };
            activeRemoteReplicaRef.current = { connectionKey, entry };
            onRemoteReplicaRef.current?.(workspaceScope.projectId, entry, projectNameRef.current);
            const authoritativeScope = createWorkspaceScope(workspaceScope);
            void (async () => {
              if (previousScope && !isSameWorkspaceScope(previousScope, authoritativeScope)) {
                await rebindProvisionalQueue(previousScope, authoritativeScope);
              }
              await replayOfflineQueue();
            })();
            return;
          }
        }
        void replayOfflineQueue();
      },
      onConnected: () => {
        setIsConnected(true);
        setAuthError(null);
        setStreamNotice(null);
      },
      onDisconnected: () => {
        setIsConnected(false);
        // P14:断开不中断 turn——agent 仍在开发机跑,重连后经 seq 补发接续
        if (isStreamingRef.current) {
          setStreamNotice("连接已断开,agent 仍在开发机继续运行,恢复后自动补齐");
        }
      },
      onAuthError: (msg: string) => setAuthError(msg),
      // P14:server 无法补发(epoch 变化/缓冲不足/连续缺口)→ 全量重建
      onResyncRequired: (reason: string) => {
        console.log("[Agent] resync required:", reason);
        const sid = sessionIdRef.current;
        if (sid) loadSessionRef.current?.(sid);
      },
      onWorkspaceEventDropped: () => {
        void recordWorkspaceMetric("stale-event").catch(() => undefined);
      },
      onFileChanged: (path: string, changeType: "created" | "modified" | "deleted") => {
        onFileChangedRef.current?.(path, changeType);
        // local 模式:自动同步到本地(读取失败非致命,文件仍在远端)
        if (workspaceModeRef.current === "local" && projectIdRef.current && shouldSyncFile(path)) {
          const localTarget = workspaceHandleRef.current ?? workspaceRootRef.current;
          if (!localTarget) return;
          if (changeType === "deleted") {
            void deleteLocalFile(path, localTarget);
            return;
          }
          connRef.current
            ?.readFile(path)
            .then((result: any) => {
              if (
                result?.success &&
                result.content != null &&
                result.content.length <= MAX_SYNC_FILE_SIZE
              ) {
                void writeLocalFile(path, result.content, localTarget);
              }
            })
            .catch(() => {
              /* non-critical */
            });
        }
      },
    };

    connRef.current = new ServerConnection(config, handlers);
  }
  const conn = connRef.current;

  // ── Offline queue replay(连接建立后) ─────────────────
  const replayOfflineQueue = useCallback(async () => {
    const replayScope = getCurrentWorkspaceScope();
    if (!replayScope) return;
    const queue = await getQueueForScope(replayScope);
    for (const msg of queue) {
      if (!conn.isOpen) break;
      const currentScope = getCurrentWorkspaceScope();
      if (!currentScope || !isSameWorkspaceScope(replayScope, currentScope)) break;
      conn.sendRaw({ type: "message", content: msg.content, model: modelRef.current });
      await dequeueMessage(msg.id);
      await new Promise((r) => setTimeout(r, 500));
    }
  }, [conn]);

  // ── 连接控制 ──────────────────────────────────────────
  const connect = useCallback(() => conn.connect(), [conn]);

  const disconnect = useCallback(() => {
    abortRef.current?.abort();
    conn.disconnect();
  }, [conn]);

  const stopStreaming = useCallback(() => {
    abortRef.current?.abort(); // geek:中断 AI 流
    abortRef.current = null;
    if (settings.mode === "cloud") conn.sendRaw({ type: "abort" }); // cloud:通知服务器
    setIsStreaming(false);
    setStreamingPhase("idle");
    setCurrentToolName(undefined);
  }, [settings.mode, conn]);

  // ── Execute a tool (geek mode) ──────────────────────
  // server: 全部走 WS(Termux);local: 文件工具本地执行,runCommand 回退 WS
  const executeTool = useCallback(
    async (toolName: string, args: Record<string, unknown>): Promise<unknown> => {
      if (workspaceModeRef.current !== "server") {
        const localWorkspace = workspaceHandleRef.current ?? workspaceRootRef.current;
        if (!localWorkspace) throw new Error("No catalog-resolved local workspace is available");
        const localResult = await executeLocalTool(
          toolName,
          args,
          settingsRef.current,
          localWorkspace
        );
        if (localResult !== null) return localResult;
      }
      const result = await conn.execTool(toolName, args); // Termux 或 runCommand 回退
      if (toolName === "runCommand") notifyRunCommand(result);
      return result;
    },
    [conn]
  );

  // ── File / sync RPC(透传 ServerConnection) ────────────
  const requestFileList = useCallback((path: string = ".") => conn.listFiles(path), [conn]);
  const requestFileContent = useCallback((path: string) => conn.readFile(path), [conn]);
  const requestSyncPull = useCallback((sinceCommit?: string) => conn.syncPull(sinceCommit), [conn]);
  const requestSyncFile = useCallback(
    (commit: string, path: string) => conn.syncFile(commit, path),
    [conn]
  );
  const releaseWorkspaceWriter = useCallback(
    (args: { projectId: string; replicaId: string; workspaceGeneration: number }) =>
      conn.releaseWorkspaceWriter(args),
    [conn]
  );
  const inspectWorkspaceSource = useCallback(
    (projectId: string) => conn.inspectWorkspaceSource(projectId),
    [conn]
  );
  const cleanupLegacyWorkspace = useCallback(
    (projectId: string, legacyProjectId: string) =>
      conn.cleanupLegacyWorkspace(projectId, legacyProjectId),
    [conn]
  );
  const bindLinkedWorkspace = useCallback(
    (args: {
      projectId: string;
      displayName?: string;
      path: string;
      allowWeakDuplicate?: boolean;
    }) => conn.bindLinkedWorkspace(args),
    [conn]
  );

  const deleteProjectWorkspace = useCallback(
    (pid: string) => {
      conn.sendRaw({ type: "delete-project-workspace", projectId: pid });
    },
    [conn]
  );

  // ── 云端发送 ──────────────────────────────────────────
  const sendCloudMessage = useCallback(
    (content: string, images?: ImageAttachment[]) => {
      setMessages((prev) => [...prev, mkUserMsg(content, images), mkAssistantMsg()]);
      setIsStreaming(true);
      setStreamingPhase("connecting");
      setLastStopReason(null);
      setStreamNotice(null);
      setCompactionNotice(null);

      const payload: Record<string, unknown> = {
        type: "message",
        content,
        model: modelRef.current,
      };
      if (images?.length) {
        payload.images = images.map((img) => ({ base64: img.base64, mimeType: img.mimeType }));
      }
      if (customPromptRef.current) payload.customPrompt = customPromptRef.current;
      conn.sendRaw(payload);
    },
    [conn]
  );

  // ── geek 模式:reducer 喂事件 ──────────────────────────
  const emitGeek = useCallback(
    (ev: AgentEventType) => {
      setMessages((prev) => applyAgentEvent(prev, ev));
      const p = phaseFor(ev);
      if (p) setStreamingPhase(p);
      applyStreamNotice(ev);
    },
    [applyStreamNotice]
  );

  // ── Geek mode: App drives the agent loop(agent-core runAgentLoop) ────
  const sendGeekMessage = useCallback(
    async (content: string, images?: ImageAttachment[]) => {
      // Ensure sessionId exists for saving (geek mode may not have server connection)
      if (!sessionIdRef.current) {
        const clientId = `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        setSessionId(clientId);
        sessionIdRef.current = clientId;
      }

      const modelConfig = getModelConfig(modelRef.current);
      const apiKeyField = getApiKeyField(modelConfig.provider);
      const apiKey = apiKeyField ? settings.apiKeys[apiKeyField] || "" : "";

      const userMsg = mkUserMsg(content, images);
      setMessages((prev) => [...prev, userMsg, mkAssistantMsg()]);
      setIsStreaming(true);
      setStreamingPhase("connecting");
      setLastStopReason(null);
      setStreamNotice(null);
      setCompactionNotice(null);

      // 复审修复:workspace 改传真实设备工作区根,不再用字面量 "/" 或 sentinel
      // ("/workspace")。与 createDeviceBackend 内部解析真实路径用的是同一个值
      // (单一真相),避免该值经 runCommand/git 工具的 cwd、以及 searchFiles 拼进
      // grep 命令字符串后,泄漏一个真实 shell 不认识的虚拟路径(详见
      // deviceBackend.ts 顶部注释)。
      const geekWorkspaceRoot =
        workspaceHandleRef.current?.worktreeRoot ?? workspaceRootRef.current;
      if (!geekWorkspaceRoot) {
        throw new Error("No catalog-resolved local workspace is available");
      }

      const abortController = new AbortController();
      abortRef.current = abortController;
      try {
        // P15:turn 边界压缩(与 server 侧同函数;失败静默跳过);modelClient 提升复用(D-P15-2)
        const modelClient = createRnModelClient({ modelConfig, apiKey });
        const { history: compactedHistory, result: compaction } = await compactHistory({
          history: coreHistoryRef.current,
          modelClient,
          signal: abortController.signal,
        });
        if (compaction) {
          coreHistoryRef.current = compactedHistory;
          emitGeek({ type: "history-compacted", ...compaction });
        }

        const result = await runAgentLoop({
          modelClient,
          backend: createDeviceBackend({
            projectId: projectIdRef.current,
            execTool: executeTool,
            workspaceRoot: geekWorkspaceRoot,
          }),
          workspace: geekWorkspaceRoot,
          system: buildSystemPrompt({ customPrompt: customPromptRef.current }),
          history: coreHistoryRef.current, // newSession/项目切换处重置为 [];loadSession 重建自存档(I1)
          userMessage: content,
          images: images?.map((i) => ({ base64: i.base64, mimeType: i.mimeType })),
          onEvent: emitGeek,
          signal: abortController.signal,
          maxSteps: 10, // 保持 geek 现值
        });
        coreHistoryRef.current = result.messages;
        setLastStopReason(result.stopReason);
      } catch (err: any) {
        // P12 后 loop 不再抛错(错误收敛为返回值);此 catch 仅防御构造期异常
        // (createRnModelClient/createDeviceBackend 等),不会再对 loop 错误二次发 error 事件。
        if (err.name !== "AbortError") emitGeek({ type: "error", message: String(err.message) });
      } finally {
        abortRef.current = null;
        finalizeStreaming();
      }
    },
    [settings, executeTool, emitGeek, finalizeStreaming]
  );

  // ── Send message ──────────────────────────────────────
  const sendMessage = useCallback(
    async (content: string, images?: ImageAttachment[]) => {
      // P16 D-P16-3:/goal 前缀 → 下发目标(仅 cloud 路径;goal driver 生在 daemon)
      if (settings.mode === "cloud" && content.startsWith("/goal ") && conn.isOpen) {
        const goalContent = content.slice(6).trim();
        if (!goalContent) return;
        setMessages((prev) => [...prev, mkUserMsg(content, images), mkAssistantMsg()]);
        setIsStreaming(true);
        setStreamingPhase("connecting");
        setLastStopReason(null);
        setStreamNotice(null);
        setCompactionNotice(null);
        conn.sendRaw({ type: "goal-create", content: goalContent });
        return;
      }
      if (settings.mode === "cloud") {
        if (!conn.isOpen) {
          // 未连接:入队待重放,并本地插入 pending 用户消息以可见
          if (!sessionIdRef.current) {
            const offlineSessionId = `offline_session_${randomUUID()}`;
            sessionIdRef.current = offlineSessionId;
            setSessionId(offlineSessionId);
          }
          const scope = getCurrentWorkspaceScope();
          if (!scope) throw new Error("Current workspace scope is unavailable");
          const provisional =
            usesRemoteWorkspace(settingsRef.current) && !getRetainedRemoteReplica();
          await enqueueMessage(scope, content, { provisional });
          setMessages((prev) => [...prev, { ...mkUserMsg(content, images), pending: true }]);
          return;
        }
        sendCloudMessage(content, images);
      } else {
        sendGeekMessage(content, images);
      }
    },
    [settings.mode, conn, sendCloudMessage, sendGeekMessage]
  );

  // ── P16:goal 控制(不经模型 turn) ─────────────────────
  const goalControl = useCallback(
    (action: "pause" | "resume" | "cancel") => {
      conn.sendRaw({ type: "goal-control", action });
      if (action === "resume") {
        setIsStreaming(true);
        setStreamingPhase("connecting");
        setMessages((prev) => [...prev, mkAssistantMsg()]);
      }
    },
    [conn]
  );

  // ── Edit & Resend (conversation branching) ────────────
  const editAndResend = useCallback(
    async (messageId: string, newContent: string) => {
      const idx = messagesRef.current.findIndex((m) => m.id === messageId);
      if (idx === -1) return;

      // 截断到目标消息之前;立即更新 ref 供后续构建历史使用
      const truncated = messagesRef.current.slice(0, idx);
      setMessages(truncated);
      messagesRef.current = truncated;
      // geek 模式:coreHistoryRef 与 UI messages 并行维护,同步截断到相同的
      // user 轮次数,否则重发时仍会把已被分支丢弃的旧轮次带给模型(见
      // truncateCoreHistory 注释)。
      const keepUserTurns = truncated.filter((m) => m.role === "user").length;
      coreHistoryRef.current = truncateCoreHistory(coreHistoryRef.current, keepUserTurns);

      if (settings.mode === "cloud") {
        await new Promise((r) => setTimeout(r, 50));
        if (!conn.isOpen) return;
        setMessages((prev) => [...prev, mkUserMsg(newContent), mkAssistantMsg()]);
        setIsStreaming(true);
        setStreamingPhase("connecting");

        const payload: Record<string, unknown> = {
          type: "message",
          content: newContent,
          model: modelRef.current,
          rewindTo: idx,
        };
        if (customPromptRef.current) payload.customPrompt = customPromptRef.current;
        conn.sendRaw(payload);
      } else {
        await new Promise((r) => setTimeout(r, 50));
        sendGeekMessage(newContent);
      }
    },
    [settings.mode, conn, sendGeekMessage]
  );

  // ── Session management ────────────────────────────────
  /** Load a previous session's messages and reconnect */
  const loadSession = useCallback(
    async (targetSessionId: string) => {
      abortRef.current?.abort();
      conn.disconnect();
      setIsConnected(false);
      const loaded = await loadChatHistory(targetSessionId);
      setMessages(loaded as Message[]);
      // I1 修复:从存档重建 CoreMessage 历史(而非重置为 []),使 loadSession 后
      // geek 续聊仍能看到之前对话的上下文。
      coreHistoryRef.current = storedToCoreMessages(loaded);
      setSessionId(targetSessionId);
      sessionIdRef.current = targetSessionId; // 立即更新,供 connect() 使用
      setIsStreaming(false);
      setLastStopReason(null);
      setStreamNotice(null);
      setCompactionNotice(null);
      setEditCutoff(0);
      setGoalState(null);
      if (needsAutoConnect) setTimeout(() => connect(), 50); // loadSession 断开后延迟重连
    },
    [conn, connect, needsAutoConnect]
  );
  loadSessionRef.current = loadSession;

  /** Start a new empty session */
  const newSession = useCallback(() => {
    abortRef.current?.abort();
    conn.disconnect();
    setMessages([]);
    coreHistoryRef.current = [];
    setSessionId(null);
    sessionIdRef.current = null;
    setIsStreaming(false);
    setLastStopReason(null);
    setStreamNotice(null);
    setCompactionNotice(null);
    setEditCutoff(0);
    setGoalState(null);
  }, [conn]);

  // ── Reset session when project changes ───────────────
  useEffect(() => {
    if (!projectId) return;
    abortRef.current?.abort();
    conn.disconnect();
    setMessages([]);
    coreHistoryRef.current = [];
    setSessionId(null);
    sessionIdRef.current = null;
    setIsStreaming(false);
    setIsConnected(false);
    setLastStopReason(null);
    setStreamNotice(null);
    setCompactionNotice(null);
    setEditCutoff(0);
    setGoalState(null);
    activeRemoteReplicaRef.current = null;
  }, [projectId, workspaceHandle?.generation, workspaceRoot, conn]);

  // ── Cleanup ───────────────────────────────────────────
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      conn.disconnect();
    };
  }, [conn]);

  return {
    messages,
    setMessages,
    isConnected,
    isStreaming,
    streamingPhase,
    currentToolName,
    sessionId,
    authError,
    lastStopReason,
    streamNotice,
    compactionNotice,
    editCutoff,
    goalState,
    goalControl,
    needsAutoConnect,
    connect,
    disconnect,
    stopStreaming,
    sendMessage,
    editAndResend,
    loadSession,
    newSession,
    requestFileList,
    requestFileContent,
    requestSyncPull,
    requestSyncFile,
    releaseWorkspaceWriter,
    inspectWorkspaceSource,
    cleanupLegacyWorkspace,
    bindLinkedWorkspace,
    deleteProjectWorkspace,
  };
}
