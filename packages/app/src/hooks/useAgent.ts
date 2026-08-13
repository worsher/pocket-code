// ── useAgent:瘦组合层 ─────────────────────────────────────
// P6b:传输交给 ServerConnection,UI 更新交给 chatReducer(applyAgentEvent
// /phaseFor)。云端与 geek 共用同一 reducer,对外 API 面保持不变。
import { useState, useRef, useCallback, useEffect } from "react";
import { AppState } from "react-native";
import { getRandomBytes, randomUUID } from "expo-crypto";
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
import { updateSettings, type AppSettings, type GitCredentialProfile } from "../store/settings";
import { saveChatHistory, loadChatHistoryStrict } from "../store/chatHistory";
import { deleteLocalFile, executeLocalTool, writeLocalFile } from "../services/localFileSystem";
import {
  enqueueMessage,
  getQueueForReplay,
  getResumeScopeForProject,
  dequeueMessage,
  markRetried,
  markUncertain,
  rebindProvisionalQueue,
} from "../services/offlineQueue";
import { prepareQueuedTurnMessages } from "./queuedTurnMessages";
export { prepareQueuedTurnMessages } from "./queuedTurnMessages";
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
  GitCredentialResponse,
  GitOperationResponse,
  LinkedWorkspaceImportResponse,
} from "@pocket-code/client-core";
import {
  normalizeGitRemoteHttpsUrl,
  toGitCredentialWireProfile,
} from "../services/gitCredentialProfiles";
import { readGitCredentialSecret } from "../services/gitCredentialVault";
import { isSensitiveGitContentPath } from "../services/gitSensitivePath";
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
  gitCredentialProfileId?: string;
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
const SYNC_IGNORE_FILES = [".gitconfig", ".git-credentials", ".netrc"];
const MAX_SYNC_FILE_SIZE = 512 * 1024; // 512KB

function assertGitCredentialResponse(response: GitCredentialResponse): GitCredentialResponse {
  if (!response.success) {
    const detail = response.error;
    throw new Error(
      detail ? `${detail.message} (${detail.code})` : "Git credential operation failed"
    );
  }
  return response;
}

function assertGitOperationResponse(response: GitOperationResponse): GitOperationResponse {
  if (!response.success) {
    const detail = response.error;
    throw new Error(detail ? `${detail.message} (${detail.code})` : "Git operation failed");
  }
  return response;
}

function assertDirectGitCredentialTransport(serverUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(serverUrl);
  } catch {
    throw new Error("Git Key 只能发送到有效的 WSS Server 地址");
  }
  if (parsed.protocol === "wss:") return;
  const loopbackHosts = new Set(["localhost", "127.0.0.1", "::1"]);
  if (parsed.protocol === "ws:" && loopbackHosts.has(parsed.hostname)) return;
  throw new Error("Direct 模式安装 Git Key 必须使用 wss://；不允许通过局域网明文 ws:// 发送");
}

async function installRemoteGitCredential(
  conn: ServerConnection,
  profile: GitCredentialProfile,
  workspaceMode: AppSettings["workspaceMode"],
  serverUrl: string
): Promise<GitCredentialResponse> {
  if (!conn.isOpen) throw new Error("远端尚未连接，无法安装 Git Key");
  if (workspaceMode !== "relay") assertDirectGitCredentialTransport(serverUrl);
  const secret = await readGitCredentialSecret(profile);
  return assertGitCredentialResponse(
    await conn.upsertGitCredential({
      profile: toGitCredentialWireProfile(profile),
      secret,
      randomBytes: getRandomBytes,
    })
  );
}

function migrationSafeLegacyProjectId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return parseLegacyProjectId(value);
  } catch {
    return undefined;
  }
}

function shouldSyncFile(filePath: string): boolean {
  if (isSensitiveGitContentPath(filePath)) return false;
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

const newTurnId = (): string => `turn_${randomUUID()}`;
const newMessageId = (): string => `msg_${randomUUID()}`;

const mkUserMsg = (
  content: string,
  images?: ImageAttachment[],
  turnId?: string,
  pending?: boolean
): Message => ({
  id: turnId ? `msg_user_${turnId}` : newMessageId(),
  turnId,
  role: "user",
  content,
  images,
  timestamp: Date.now(),
  pending,
});
const mkAssistantMsg = (turnId?: string, uniqueId = false): Message => ({
  id: turnId && !uniqueId ? `msg_assistant_${turnId}` : newMessageId(),
  turnId,
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
  gitCredentialProfileId,
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
  const gitCredentialProfileIdRef = useRef(gitCredentialProfileId);
  gitCredentialProfileIdRef.current = gitCredentialProfileId;
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
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const isStreamingRef = useRef(isStreaming);
  isStreamingRef.current = isStreaming;
  const activeTurnIdRef = useRef<string | null>(null);
  const activeTurnKindRef = useRef<"message" | "goal" | null>(null);
  const renderTurnIdRef = useRef<string | null>(null);
  const replayDrainRef = useRef<Promise<void> | null>(null);
  const replayGenerationRef = useRef(0);
  const sessionPreparationRef = useRef<Promise<void>>(Promise.resolve());
  const sessionReadyRef = useRef(false);
  const pendingRebindScopeRef = useRef<WorkspaceScope | null>(null);
  const replayTurnRef = useRef<{
    queueId: string;
    turnId: string;
    settled: boolean;
    resolve: (result: "done" | "disconnected" | "send-failed" | "uncertain") => void;
  } | null>(null);
  const queueHydrationRef = useRef<Promise<void> | null>(null);
  const queueHydrationIntentRef = useRef(0);
  const queueHydrationDesiredRef = useRef(false);
  const hydratedProvisionalScopeRef = useRef<WorkspaceScope | null>(null);
  const goalStateRef = useRef(goalState);
  goalStateRef.current = goalState;
  // loadSession 定义在 handlers 单例块之后 → handlers 内经 ref 间接引用(P14 resync)
  const loadSessionRef = useRef<((sid: string) => Promise<void>) | null>(null);
  const sessionLoadIntentRef = useRef(0);
  const modeRef = useRef(settings.mode);
  modeRef.current = settings.mode;
  const authTokenRef = useRef(settings.authToken);
  authTokenRef.current = settings.authToken;
  const deviceIdRef = useRef(settings.deviceId);
  deviceIdRef.current = settings.deviceId;

  // Event callbacks may arrive several times in one render frame. Keep the ref as
  // the synchronous source of truth, then mirror it to React state for rendering.
  const commitMessages = useCallback((update: (current: Message[]) => Message[]): Message[] => {
    const next = update(messagesRef.current);
    messagesRef.current = next;
    setMessages(next);
    return next;
  }, []);

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

  const ensureSubmissionScope = (): WorkspaceScope => {
    if (!sessionIdRef.current) {
      const offlineSessionId = `offline_session_${randomUUID()}`;
      sessionIdRef.current = offlineSessionId;
      setSessionId(offlineSessionId);
    }
    const current = getCurrentWorkspaceScope();
    if (current) return current;
    if (projectIdRef.current && workspaceReplicaIdRef.current) {
      return createWorkspaceScope({
        projectId: projectIdRef.current,
        replicaId: workspaceReplicaIdRef.current,
        sessionId: sessionIdRef.current,
        workspaceGeneration: workspaceGenerationRef.current ?? 1,
      });
    }
    throw new Error("Current workspace scope is unavailable");
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
    settings.workspaceMode === "relay"
      ? settings.relayServerUrl || "wss://relay.your-vps.com"
      : settings.mode === "geek"
        ? settings.toolServerUrl
        : settings.cloudServerUrl;
  const serverUrlRef = useRef(serverUrl);
  serverUrlRef.current = serverUrl;

  // 需自动连接:cloud 恒真;geek+server(Termux)恒真;geek+local 否(runCommand 惰性回退)
  const needsAutoConnect =
    settings.mode === "cloud" ||
    settings.workspaceMode === "server" ||
    settings.workspaceMode === "relay";

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
  const pendingFinalizeSaveRef = useRef(false);

  // ── done 收敛(云端 & geek 共用) ─────────────────────
  const finalizeStreaming = useCallback(() => {
    const completedTurnId = renderTurnIdRef.current;
    isStreamingRef.current = false;
    activeTurnIdRef.current = null;
    activeTurnKindRef.current = null;
    renderTurnIdRef.current = null;
    setIsStreaming(false);
    setStreamingPhase("idle");
    setCurrentToolName(undefined);
    pendingFinalizeSaveRef.current = true;
    if (AppState.currentState !== "active") {
      const lastMsg = completedTurnId
        ? [...messagesRef.current]
            .reverse()
            .find((message) => message.role === "assistant" && message.turnId === completedTurnId)
        : messagesRef.current[messagesRef.current.length - 1];
      const summary = lastMsg?.content?.slice(0, 100) || "任务已完成";
      sendLocalNotification("Pocket Code", summary);
    }
  }, []);

  const cancelReplayDrain = useCallback(() => {
    replayGenerationRef.current += 1;
    const replay = replayTurnRef.current;
    if (replay && !replay.settled) {
      replay.settled = true;
      replay.resolve("disconnected");
    }
    replayTurnRef.current = null;
    replayDrainRef.current = null;
  }, []);

  // Run persistence after React has committed the last queued event update. This
  // prevents done and the final text delta in the same batch from saving stale refs.
  useEffect(() => {
    if (isStreaming || !pendingFinalizeSaveRef.current) return;
    pendingFinalizeSaveRef.current = false;
    saveMessages(messages, sessionIdRef.current);
  }, [isStreaming, messages, saveMessages]);

  // ── 重试/降级瞬时提醒(cloud & geek 共用,P13)─────────────
  const applyStreamNotice = useCallback(
    (ev: AgentEventType, controlsStreaming: boolean = true) => {
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
          const nextGoalState =
            ev.change === "completion" || ev.change === "cleared"
              ? null
              : {
                  status: ev.status,
                  goal: ev.goal,
                  stopReason: ev.stopReason,
                  stats: ev.stats,
                  maxTurns: ev.maxTurns,
                };
          // Multiple WS frames can arrive before React commits a render. Keep the
          // ref authoritative immediately so an adjacent done observes the new
          // goal lifecycle instead of stale state.
          goalStateRef.current = nextGoalState;
          if (ev.change === "completion") {
            sendLocalNotification("目标已完成 ✓", ev.goal ?? "");
            setGoalState(null);
          } else if (ev.change === "cleared") {
            setGoalState(null);
          } else {
            setGoalState(nextGoalState);
            if (ev.status === "blocked") {
              sendLocalNotification("目标受阻", ev.stopReason ?? ev.goal ?? "");
            }
          }
          // goal 终局/停车:收敛 streaming 态(done 在 goal active 时被跳过收敛,D-P16-7),
          // 顺带修剪 done 处预插的尾部空占位气泡。
          if (controlsStreaming && (ev.change !== "lifecycle" || ev.status !== "active")) {
            commitMessages((current) => {
              const last = current[current.length - 1];
              return last && last.role === "assistant" && !last.content && !last.toolCalls?.length
                ? current.slice(0, -1)
                : current;
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
    [commitMessages, finalizeStreaming]
  );

  // ── 单例 ServerConnection(惰性创建) ───────────────────
  const connRef = useRef<ServerConnection | null>(null);
  const remoteGitCredentialInstallRef = useRef<Promise<void> | null>(null);
  if (!connRef.current) {
    const config: ConnectionConfig = {
      getServerUrl: () => serverUrlRef.current,
      isRelayMode: () => workspaceModeRef.current === "relay",
      getRelayOptions: () => ({
        machineId: settingsRef.current.relayMachineId || "",
        deviceId: getDeviceId(),
        token: settingsRef.current.relayToken,
        publicKey: settingsRef.current.relayCredentialPublicKey,
        keyId: settingsRef.current.relayCredentialKeyId,
      }),
      getAuthToken: () => authTokenRef.current,
      getDeviceId,
      buildInitPayload: () => ({
        ...(WORKSPACE_FEATURE_FLAGS.protocolV2 ? { workspaceProtocolVersion: 2 as const } : {}),
        sessionId: sessionIdRef.current,
        projectId: projectIdRef.current || undefined,
        legacyProjectId: migrationSafeLegacyProjectId(legacyProjectIdRef.current),
        projectName: projectNameRef.current || undefined,
        gitCredentialProfileId: gitCredentialProfileIdRef.current || undefined,
        model: modelRef.current,
        activeTurnId: activeTurnIdRef.current || undefined,
        activeTurnKind: activeTurnKindRef.current || undefined,
      }),
      isRelayPaired: () => !!(settingsRef.current.relayToken && settingsRef.current.relayMachineId),
      onTokenPersist: (token, machineId) =>
        updateSettings({ relayToken: token, relayMachineId: machineId }),
      onEncryptionKeyPersist: (key, machineId) => {
        const current = settingsRef.current;
        if (current.relayMachineId && current.relayMachineId !== machineId) return;
        const partial = {
          relayMachineId: machineId,
          relayCredentialPublicKey: key.publicKey,
          relayCredentialKeyId: key.keyId,
        };
        // Update the connection's source synchronously; persistence is metadata-only
        // and intentionally does not pass through an offline message queue.
        settingsRef.current = { ...current, ...partial };
        void updateSettings(partial);
      },
    };

    const handlers: ConnectionHandlers = {
      onAgentEvent: (ev: AgentEventType) => {
        // geek 模式的事件由本地适配层 emitGeek 产生,忽略来自服务器的流式事件
        if (modeRef.current === "geek") return;

        commitMessages((current) => applyAgentEvent(current, ev));
        const replay = replayTurnRef.current;
        const completesReplay = Boolean(
          ev.type === "done" &&
          replay &&
          !replay.settled &&
          (ev.turnId === replay.turnId || (!connRef.current?.supportsTurnCorrelation && !ev.turnId))
        );
        if (completesReplay && replay) {
          replay.settled = true;
          replay.resolve("done");
        }
        const isRecoveredGoalState =
          ev.type === "goal-updated" && !!ev.turnId && !activeTurnIdRef.current;
        const controlsActiveTurn =
          !ev.turnId ||
          (!!activeTurnIdRef.current && ev.turnId === activeTurnIdRef.current) ||
          isRecoveredGoalState;
        // Goal lifecycle owns the goal card independently from whichever turn is
        // currently streaming. A late `cleared` for a cancelled goal must still
        // remove the card, but it must not finalize a newer ordinary message.
        if (ev.type === "goal-updated") {
          applyStreamNotice(ev, controlsActiveTurn);
          if (!controlsActiveTurn) return;
        } else {
          if (!controlsActiveTurn) return;
          applyStreamNotice(ev);
        }
        const p = phaseFor(ev);
        if (p) setStreamingPhase(p);

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
            if (completesReplay) break;
            // P16 D-P16-7:goal 续跑的多轮输出用新气泡分隔,否则全堆进同一 assistant
            if (goalStateRef.current?.status === "active") {
              renderTurnIdRef.current = ev.turnId ?? null;
              // One goal owns a stable turnId across multiple model rounds, but
              // React list keys still need to be unique for each rendered bubble.
              commitMessages((current) => [...current, mkAssistantMsg(ev.turnId, true)]);
              isStreamingRef.current = true;
              setIsStreaming(true); // goal 仍在续跑,不收敛 streaming 态
              break;
            }
            finalizeStreaming();
            break;
          case "error":
            // Agent errors are followed by done(stopReason="error"). Keep the turn
            // locked until that terminal event so queued replay cannot overlap it.
            if (
              ev.code === "control-error" ||
              ev.code === "turn-journal-unavailable" ||
              ev.code === "turn-journal-commit-failed" ||
              ev.code === "turn-in-progress"
            ) {
              const replay = replayTurnRef.current;
              if (
                replay &&
                !replay.settled &&
                (ev.turnId === replay.turnId ||
                  (!connRef.current?.supportsTurnCorrelation && !ev.turnId))
              ) {
                replay.settled = true;
                replay.resolve("send-failed");
                break;
              }
              finalizeStreaming();
            }
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
        sessionReadyRef.current = false;
        sessionPreparationRef.current = Promise.resolve();
        // Capture the provisional offline scope before replacing its temporary
        // session id with the authoritative id returned by the server. Otherwise
        // rebindProvisionalQueue would look under the new id and orphan the FIFO.
        const previousScope =
          pendingRebindScopeRef.current ??
          hydratedProvisionalScopeRef.current ??
          getCurrentWorkspaceScope();
        sessionIdRef.current = sid;
        setSessionId(sid);
        setAuthError(null);
        setStreamNotice(null);
        const boundProfile = settingsRef.current.gitCredentialProfiles.find(
          (profile) => profile.id === gitCredentialProfileIdRef.current && profile.hasSecret
        );
        const activeConnection = connRef.current;
        if (boundProfile && activeConnection) {
          // session ack 后预装项目绑定的凭据。发送下一条模型消息前会等待该
          // promise，因此模型首次调用 gitClone/pull/push 也不会与 Vault 安装竞态。
          remoteGitCredentialInstallRef.current = installRemoteGitCredential(
            activeConnection,
            boundProfile,
            workspaceModeRef.current,
            serverUrlRef.current
          )
            .then(() => undefined)
            .catch((error) => {
              console.warn("[Git] Failed to install bound credential profile:", error);
            });
        } else {
          remoteGitCredentialInstallRef.current = null;
        }
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
            const provisionalScope = createWorkspaceScope({
              projectId: authoritativeScope.projectId,
              replicaId: workspaceReplicaIdRef.current ?? authoritativeScope.replicaId,
              sessionId: authoritativeScope.sessionId,
              workspaceGeneration:
                workspaceGenerationRef.current ?? authoritativeScope.workspaceGeneration,
            });
            const scopeToRebind = previousScope ?? provisionalScope;
            pendingRebindScopeRef.current = scopeToRebind;
            sessionPreparationRef.current = (async () => {
              // Even an identical four-field scope still needs its provisional
              // route record upgraded with the server authority before replay.
              await rebindProvisionalQueue(scopeToRebind, authoritativeScope, {
                connectionKey,
                authorityId: workspaceScope.authorityId,
              });
              if (pendingRebindScopeRef.current === scopeToRebind) {
                pendingRebindScopeRef.current = null;
              }
              hydratedProvisionalScopeRef.current = null;
            })();
            return;
          }
        }
      },
      onSessionReady: () => {
        const preparation = sessionPreparationRef.current;
        void preparation
          .then(() => {
            if (sessionPreparationRef.current !== preparation || !connRef.current?.isReady) return;
            sessionReadyRef.current = true;
            setIsConnected(true);
            void replayOfflineQueue();
          })
          .catch((error) => {
            if (sessionPreparationRef.current !== preparation) return;
            console.warn("[OfflineQueue] Failed to bind queued turns to the session:", error);
            sessionReadyRef.current = false;
            setIsConnected(false);
            setStreamNotice("离线消息绑定失败，已停止发送；请重新连接后重试");
            connRef.current?.disconnect();
          });
      },
      onConnected: () => {
        // Transport-open is not turn-ready. The session ack above is the readiness gate.
        sessionReadyRef.current = false;
        setIsConnected(false);
        setAuthError(null);
        setStreamNotice(null);
      },
      onDisconnected: () => {
        sessionReadyRef.current = false;
        setIsConnected(false);
        remoteGitCredentialInstallRef.current = null;
        const replay = replayTurnRef.current;
        if (replay && !replay.settled) {
          const supportsSafeReplay = connRef.current?.supportsTurnCorrelation === true;
          if (!supportsSafeReplay) {
            // A legacy server has neither durable turn IDs nor reconnect backlog.
            // Surface the ambiguity and quarantine the FIFO record rather than
            // silently retrying a possibly side-effecting turn.
            commitMessages((current) =>
              applyAgentEvent(current, {
                type: "error",
                code: "legacy-turn-uncertain",
                message: "连接中断，旧服务端无法确认本轮是否已执行；已停止自动重试。",
                turnId: replay.turnId,
              })
            );
          }
          replay.settled = true;
          replay.resolve(supportsSafeReplay ? "disconnected" : "uncertain");
        }
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
    if (replayDrainRef.current) return replayDrainRef.current;
    const generation = replayGenerationRef.current;
    let ownsReplayLock = false;

    const drain = (async () => {
      await remoteGitCredentialInstallRef.current;
      const replayScope = getCurrentWorkspaceScope();
      const connectionKey = getWorkspaceConnectionKey(settingsRef.current);
      const retainedReplica = getRetainedRemoteReplica();
      const replayRoute =
        connectionKey && retainedReplica?.authorityId
          ? { connectionKey, authorityId: retainedReplica.authorityId }
          : null;
      if (
        !replayScope ||
        !replayRoute ||
        !sessionReadyRef.current ||
        !conn.isReady ||
        generation !== replayGenerationRef.current
      ) {
        return;
      }
      const initialQueue = await getQueueForReplay(replayScope, replayRoute);
      if (
        isStreamingRef.current &&
        activeTurnIdRef.current &&
        !initialQueue.some((queued) => queued.id === activeTurnIdRef.current)
      ) {
        return;
      }

      while (
        sessionReadyRef.current &&
        conn.isReady &&
        generation === replayGenerationRef.current
      ) {
        const currentScope = getCurrentWorkspaceScope();
        const currentConnectionKey = getWorkspaceConnectionKey(settingsRef.current);
        const currentReplica = getRetainedRemoteReplica();
        if (
          !currentScope ||
          !isSameWorkspaceScope(replayScope, currentScope) ||
          currentConnectionKey !== replayRoute.connectionKey ||
          currentReplica?.authorityId !== replayRoute.authorityId
        ) {
          return;
        }
        const queued = (await getQueueForReplay(replayScope, replayRoute))[0];
        if (!queued) return;

        ownsReplayLock = true;
        commitMessages((current) => prepareQueuedTurnMessages(current, queued));
        activeTurnIdRef.current = queued.id;
        activeTurnKindRef.current = "message";
        renderTurnIdRef.current = queued.id;
        isStreamingRef.current = true;
        setIsStreaming(true);
        setStreamingPhase("connecting");
        setLastStopReason(null);

        const result = await new Promise<"done" | "disconnected" | "send-failed" | "uncertain">(
          (resolve) => {
            replayTurnRef.current = {
              queueId: queued.id,
              turnId: queued.id,
              settled: false,
              resolve,
            };
            const sent = conn.sendRaw({
              type: "message",
              turnId: queued.id,
              content: queued.content,
              model: queued.model ?? modelRef.current,
              customPrompt: queued.customPrompt,
              rewindTo: queued.rewindTo,
              images: queued.images,
            });
            if (!sent) {
              replayTurnRef.current.settled = true;
              resolve("send-failed");
            }
          }
        );

        if (generation !== replayGenerationRef.current) return;
        replayTurnRef.current = null;
        if (result !== "done") {
          if (result === "uncertain") {
            await markUncertain(queued.id, "legacy-disconnect");
            await saveChatHistory(
              replayScope.sessionId,
              messagesRef.current as StoredMessage[],
              replayScope.projectId
            );
          } else {
            await markRetried(queued.id);
          }
          finalizeStreaming();
          return;
        }
        // The durable chat snapshot is the handoff point: never remove the queue
        // record until the completed response has been persisted successfully.
        await saveChatHistory(
          replayScope.sessionId,
          messagesRef.current as StoredMessage[],
          replayScope.projectId
        );
        if (generation !== replayGenerationRef.current) return;
        await dequeueMessage(queued.id);
        // done may have finalized React state; the drain owns the lock until it
        // observes an empty FIFO so a live send can never jump between queued turns.
        isStreamingRef.current = true;
        setIsStreaming(true);
      }
    })().finally(() => {
      if (generation === replayGenerationRef.current) {
        replayTurnRef.current = null;
        replayDrainRef.current = null;
        // An active goal has no ordinary FIFO record. Merely checking an empty
        // queue on reconnect must not release that goal's streaming lock.
        if (ownsReplayLock) finalizeStreaming();
      }
    });

    replayDrainRef.current = drain;
    return drain;
  }, [commitMessages, conn, finalizeStreaming]);

  // ── 连接控制 ──────────────────────────────────────────
  const connect = useCallback(() => {
    queueHydrationDesiredRef.current = true;
    queueHydrationIntentRef.current += 1;
    if (conn.isOpen || queueHydrationRef.current) return;

    const startHydration = () => {
      if (!queueHydrationDesiredRef.current || conn.isOpen || queueHydrationRef.current) return;
      const hydrationIntent = queueHydrationIntentRef.current;
      const generation = replayGenerationRef.current;
      const targetProjectId = projectIdRef.current;
      const targetConnectionKey = getWorkspaceConnectionKey(settingsRef.current);
      const retainedReplica = getRetainedRemoteReplica();
      let hydrationFailed = false;
      let hydration!: Promise<void>;
      hydration = (async () => {
        if (
          !sessionIdRef.current &&
          targetProjectId &&
          targetConnectionKey &&
          usesRemoteWorkspace(settingsRef.current)
        ) {
          const resumeScope = await getResumeScopeForProject({
            projectId: targetProjectId,
            connectionKey: targetConnectionKey,
            retainedReplica,
          });
          if (
            resumeScope &&
            !sessionIdRef.current &&
            hydrationIntent === queueHydrationIntentRef.current &&
            generation === replayGenerationRef.current &&
            projectIdRef.current === targetProjectId &&
            getWorkspaceConnectionKey(settingsRef.current) === targetConnectionKey
          ) {
            const archived = await loadChatHistoryStrict(resumeScope.sessionId);
            if (
              hydrationIntent !== queueHydrationIntentRef.current ||
              generation !== replayGenerationRef.current ||
              projectIdRef.current !== targetProjectId ||
              getWorkspaceConnectionKey(settingsRef.current) !== targetConnectionKey
            ) {
              return;
            }
            commitMessages(() => archived as Message[]);
            hydratedProvisionalScopeRef.current = resumeScope;
            sessionIdRef.current = resumeScope.sessionId;
            setSessionId(resumeScope.sessionId);
          }
        }
      })()
        .catch((error) => {
          hydrationFailed = true;
          console.warn("[OfflineQueue] Failed to restore queued session:", error);
          if (
            hydrationIntent === queueHydrationIntentRef.current &&
            generation === replayGenerationRef.current
          ) {
            queueHydrationDesiredRef.current = false;
            setStreamNotice("离线消息恢复失败，请重试连接");
          }
        })
        .finally(() => {
          if (queueHydrationRef.current === hydration) queueHydrationRef.current = null;
          const stillCurrent =
            hydrationIntent === queueHydrationIntentRef.current &&
            generation === replayGenerationRef.current &&
            projectIdRef.current === targetProjectId &&
            getWorkspaceConnectionKey(settingsRef.current) === targetConnectionKey;
          if (queueHydrationDesiredRef.current && stillCurrent && !hydrationFailed) {
            conn.connect();
          } else if (queueHydrationDesiredRef.current && !stillCurrent && !conn.isOpen) {
            // A project/authority change arrived while the previous AsyncStorage
            // read was in flight. Start the latest intent instead of swallowing it.
            startHydration();
          }
        });
      queueHydrationRef.current = hydration;
    };

    startHydration();
  }, [commitMessages, conn]);

  const disconnect = useCallback(() => {
    queueHydrationDesiredRef.current = false;
    queueHydrationIntentRef.current += 1;
    abortRef.current?.abort();
    conn.disconnect();
  }, [conn]);

  const stopStreaming = useCallback(() => {
    abortRef.current?.abort(); // geek:中断 AI 流
    abortRef.current = null;
    if (settings.mode === "cloud") {
      const replay = replayTurnRef.current;
      const sent = conn.sendRaw({ type: "abort" }); // cloud:通知服务器
      if (!sent && replay && !replay.settled) {
        replay.settled = true;
        replay.resolve("disconnected");
      }
      // For queued replay, keep correlation and the lock until the matching
      // aborted done arrives. If transport failed, the drain keeps the record.
      if (replay && sent) return;
    }
    isStreamingRef.current = false;
    activeTurnIdRef.current = null;
    activeTurnKindRef.current = null;
    renderTurnIdRef.current = null;
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
          localWorkspace,
          gitCredentialProfileIdRef.current
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

  const upsertRemoteGitCredential = useCallback(
    async (profile: GitCredentialProfile): Promise<GitCredentialResponse> => {
      return installRemoteGitCredential(
        conn,
        profile,
        workspaceModeRef.current,
        serverUrlRef.current
      );
    },
    [conn]
  );

  const testRemoteGitCredential = useCallback(
    async (args: {
      profile: GitCredentialProfile;
      repositoryUrl: string;
      capability?: "read" | "write";
    }): Promise<GitCredentialResponse> => {
      const repositoryUrl = normalizeGitRemoteHttpsUrl(args.repositoryUrl);
      await upsertRemoteGitCredential(args.profile);
      const response = await conn.testGitCredential({
        credentialProfileId: args.profile.id,
        repositoryUrl,
        capability: args.capability,
      });
      return assertGitCredentialResponse(response);
    },
    [conn, upsertRemoteGitCredential]
  );

  const deleteRemoteGitCredential = useCallback(
    async (credentialProfileId: string): Promise<GitCredentialResponse> => {
      if (!conn.isOpen) throw new Error("远端尚未连接，无法删除远端 Git Key");
      return assertGitCredentialResponse(await conn.deleteGitCredential(credentialProfileId));
    },
    [conn]
  );

  const importRemoteGitWorkspace = useCallback(
    async (args: {
      projectId: string;
      displayName?: string;
      repositoryUrl: string;
      profile: GitCredentialProfile;
      branch?: string;
    }): Promise<LinkedWorkspaceImportResponse> => {
      const repositoryUrl = normalizeGitRemoteHttpsUrl(args.repositoryUrl);
      await upsertRemoteGitCredential(args.profile);
      return conn.importGitWorkspace({
        projectId: args.projectId,
        displayName: args.displayName,
        repositoryUrl,
        credentialProfileId: args.profile.id,
        branch: args.branch,
      });
    },
    [conn, upsertRemoteGitCredential]
  );

  const runRemoteGitWorkspaceOperation = useCallback(
    async (args: {
      projectId: string;
      operation: "status" | "pull" | "commit" | "push";
      profile: GitCredentialProfile;
      commitMessage?: string;
    }): Promise<GitOperationResponse> => {
      await upsertRemoteGitCredential(args.profile);
      return assertGitOperationResponse(
        await conn.runGitWorkspaceOperation({
          projectId: args.projectId,
          operation: args.operation,
          credentialProfileId: args.profile.id,
          commitMessage: args.commitMessage,
        })
      );
    },
    [conn, upsertRemoteGitCredential]
  );

  const deleteProjectWorkspace = useCallback(
    (pid: string) => {
      conn.sendRaw({ type: "delete-project-workspace", projectId: pid });
    },
    [conn]
  );

  const submitCloudMessage = useCallback(
    async (content: string, images?: ImageAttachment[], rewindTo?: number) => {
      if (isStreamingRef.current) return false;
      const generation = replayGenerationRef.current;
      const scope = ensureSubmissionScope();
      const turnId = newTurnId();
      const remoteReplica = getRetainedRemoteReplica();
      const connectionKey = getWorkspaceConnectionKey(settingsRef.current) ?? undefined;
      const provisional = usesRemoteWorkspace(settingsRef.current) && !remoteReplica;

      // Accept and lock before any storage/credential/network await. Every accepted
      // turn gets one durable FIFO record with the same id used by rendering.
      isStreamingRef.current = true;
      activeTurnIdRef.current = turnId;
      activeTurnKindRef.current = "message";
      renderTurnIdRef.current = turnId;
      const acceptedMessages = commitMessages((current) => [
        ...current,
        mkUserMsg(content, images, turnId, true),
        { ...mkAssistantMsg(turnId), pending: true },
      ]);
      setIsStreaming(true);
      setStreamingPhase("connecting");
      setLastStopReason(null);
      setStreamNotice(null);
      setCompactionNotice(null);

      let enqueued = false;
      try {
        await enqueueMessage(scope, content, {
          id: turnId,
          provisional,
          connectionKey,
          authorityId: remoteReplica?.authorityId,
          images,
          model: modelRef.current,
          customPrompt: customPromptRef.current,
          rewindTo,
        });
        enqueued = true;
      } catch {
        if (generation === replayGenerationRef.current) {
          commitMessages((current) => current.filter((message) => message.turnId !== turnId));
          finalizeStreaming();
        }
        return false;
      }

      try {
        await saveChatHistory(
          scope.sessionId,
          acceptedMessages as StoredMessage[],
          scope.projectId
        );
      } catch (error) {
        // enqueueMessage is the durable acceptance boundary. Once it succeeds,
        // returning false would keep the input draft and let a retry create a
        // second turnId while the first FIFO record still executes later.
        if (enqueued) {
          console.warn("[ChatHistory] Accepted turn snapshot could not be saved:", error);
        }
      }

      if (generation !== replayGenerationRef.current) return true;

      if (!sessionReadyRef.current || !conn.isReady || provisional) {
        finalizeStreaming();
        return true;
      }
      void (async () => {
        await remoteGitCredentialInstallRef.current;
        if (generation !== replayGenerationRef.current) return;
        if (!sessionReadyRef.current || !conn.isReady) {
          finalizeStreaming();
          return;
        }
        await replayOfflineQueue();
      })().catch(() => {
        if (generation === replayGenerationRef.current) finalizeStreaming();
      });
      return true;
    },
    [commitMessages, conn, finalizeStreaming, replayOfflineQueue]
  );

  // ── geek 模式:reducer 喂事件 ──────────────────────────
  const emitGeek = useCallback(
    (ev: AgentEventType) => {
      commitMessages((current) => applyAgentEvent(current, ev));
      const p = phaseFor(ev);
      if (p) setStreamingPhase(p);
      applyStreamNotice(ev);
    },
    [applyStreamNotice, commitMessages]
  );

  // ── Geek mode: App drives the agent loop(agent-core runAgentLoop) ────
  const sendGeekMessage = useCallback(
    async (content: string, images?: ImageAttachment[]) => {
      if (isStreamingRef.current) return;
      // Ensure sessionId exists for saving (geek mode may not have server connection)
      if (!sessionIdRef.current) {
        const clientId = `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        setSessionId(clientId);
        sessionIdRef.current = clientId;
      }

      const modelConfig = getModelConfig(modelRef.current);
      const apiKeyField = getApiKeyField(modelConfig.provider);
      const apiKey = apiKeyField ? settings.apiKeys[apiKeyField] || "" : "";

      const turnId = newTurnId();
      activeTurnIdRef.current = turnId;
      activeTurnKindRef.current = "message";
      renderTurnIdRef.current = turnId;
      isStreamingRef.current = true;
      const emitTurnEvent = (event: AgentEventType) =>
        emitGeek({ ...event, turnId } as AgentEventType);
      const userMsg = mkUserMsg(content, images, turnId);
      commitMessages((current) => [...current, userMsg, mkAssistantMsg(turnId)]);
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
        // server workspace 的本地模型也会经 tool-exec 调用远程 Git wrapper；
        // 首轮开始前等待 bound profile 安装，避免 credential_not_found 竞态。
        await remoteGitCredentialInstallRef.current;
        // P15:turn 边界压缩(与 server 侧同函数;失败静默跳过);modelClient 提升复用(D-P15-2)
        const modelClient = createRnModelClient({ modelConfig, apiKey });
        const { history: compactedHistory, result: compaction } = await compactHistory({
          history: coreHistoryRef.current,
          modelClient,
          signal: abortController.signal,
        });
        if (compaction) {
          coreHistoryRef.current = compactedHistory;
          emitTurnEvent({ type: "history-compacted", ...compaction });
        }

        const result = await runAgentLoop({
          modelClient,
          backend: createDeviceBackend({
            projectId: projectIdRef.current,
            execTool: executeTool,
            workspaceRoot: geekWorkspaceRoot,
          }),
          workspace: geekWorkspaceRoot,
          system: buildSystemPrompt({
            customPrompt: customPromptRef.current,
            hasBoundGitCredential: !!gitCredentialProfileIdRef.current,
          }),
          history: coreHistoryRef.current, // newSession/项目切换处重置为 [];loadSession 重建自存档(I1)
          userMessage: content,
          images: images?.map((i) => ({ base64: i.base64, mimeType: i.mimeType })),
          onEvent: emitTurnEvent,
          signal: abortController.signal,
          maxSteps: 10, // 保持 geek 现值
        });
        coreHistoryRef.current = result.messages;
        setLastStopReason(result.stopReason);
      } catch (err: any) {
        // P12 后 loop 不再抛错(错误收敛为返回值);此 catch 仅防御构造期异常
        // (createRnModelClient/createDeviceBackend 等),不会再对 loop 错误二次发 error 事件。
        if (err.name !== "AbortError") {
          emitTurnEvent({ type: "error", message: String(err.message) });
        }
      } finally {
        if (abortRef.current === abortController) abortRef.current = null;
        finalizeStreaming();
      }
    },
    [settings, executeTool, emitGeek, finalizeStreaming, commitMessages]
  );

  // ── Send message ──────────────────────────────────────
  const sendMessage = useCallback(
    async (content: string, images?: ImageAttachment[]) => {
      // P16 D-P16-3:/goal 前缀 → 下发目标(仅 cloud 路径;goal driver 生在 daemon)
      if (
        settings.mode === "cloud" &&
        content.startsWith("/goal ") &&
        sessionReadyRef.current &&
        conn.isReady
      ) {
        const goalContent = content.slice(6).trim();
        if (!goalContent || isStreamingRef.current) return false;
        const generation = replayGenerationRef.current;
        const targetScope = getCurrentWorkspaceScope();
        const turnId = newTurnId();
        activeTurnIdRef.current = turnId;
        activeTurnKindRef.current = "goal";
        renderTurnIdRef.current = turnId;
        isStreamingRef.current = true;
        commitMessages((current) => [
          ...current,
          mkUserMsg(content, images, turnId),
          mkAssistantMsg(turnId),
        ]);
        setIsStreaming(true);
        setStreamingPhase("connecting");
        setLastStopReason(null);
        setStreamNotice(null);
        setCompactionNotice(null);
        await remoteGitCredentialInstallRef.current;
        const currentScope = getCurrentWorkspaceScope();
        if (
          generation !== replayGenerationRef.current ||
          !sessionReadyRef.current ||
          !conn.isReady ||
          (targetScope && (!currentScope || !isSameWorkspaceScope(targetScope, currentScope)))
        ) {
          if (generation === replayGenerationRef.current) {
            commitMessages((current) => current.filter((message) => message.turnId !== turnId));
            finalizeStreaming();
          }
          return false;
        }
        if (!conn.sendRaw({ type: "goal-create", turnId, content: goalContent })) {
          commitMessages((current) =>
            applyAgentEvent(current, {
              type: "error",
              message: "目标发送失败，请重试",
              turnId,
            })
          );
          finalizeStreaming();
        }
        return true;
      }
      if (settings.mode === "cloud") {
        return submitCloudMessage(content, images);
      } else {
        if (isStreamingRef.current) return false;
        await sendGeekMessage(content, images);
        return true;
      }
    },
    [settings.mode, conn, submitCloudMessage, sendGeekMessage, commitMessages, finalizeStreaming]
  );

  // ── P16:goal 控制(不经模型 turn) ─────────────────────
  const goalControl = useCallback(
    (action: "pause" | "resume" | "cancel") => {
      if (action === "resume") {
        // Resume starts a new goal turn. Never let it replace the correlation
        // identity of an ordinary turn that is still streaming.
        if (isStreamingRef.current || !sessionReadyRef.current || !conn.isReady) {
          setStreamNotice("当前消息尚未完成，暂时无法继续目标");
          return;
        }
        const turnId = newTurnId();
        activeTurnIdRef.current = turnId;
        activeTurnKindRef.current = "goal";
        renderTurnIdRef.current = turnId;
        isStreamingRef.current = true;
        setIsStreaming(true);
        setStreamingPhase("connecting");
        commitMessages((current) => [...current, mkAssistantMsg(turnId)]);
        if (!conn.sendRaw({ type: "goal-control", action, turnId })) {
          commitMessages((current) =>
            applyAgentEvent(current, {
              type: "error",
              message: "目标继续请求发送失败，请重试",
              turnId,
            })
          );
          finalizeStreaming();
        }
        return;
      }
      conn.sendRaw({ type: "goal-control", action });
    },
    [conn, commitMessages, finalizeStreaming]
  );

  // ── Edit & Resend (conversation branching) ────────────
  const editAndResend = useCallback(
    async (messageId: string, newContent: string) => {
      const idx = messagesRef.current.findIndex((m) => m.id === messageId);
      if (idx === -1) return;

      // 截断到目标消息之前;立即更新 ref 供后续构建历史使用
      const truncated = messagesRef.current.slice(0, idx);
      commitMessages(() => truncated);
      // geek 模式:coreHistoryRef 与 UI messages 并行维护,同步截断到相同的
      // user 轮次数,否则重发时仍会把已被分支丢弃的旧轮次带给模型(见
      // truncateCoreHistory 注释)。
      const keepUserTurns = truncated.filter((m) => m.role === "user").length;
      coreHistoryRef.current = truncateCoreHistory(coreHistoryRef.current, keepUserTurns);

      if (settings.mode === "cloud") {
        await submitCloudMessage(newContent, undefined, idx);
      } else {
        await new Promise((r) => setTimeout(r, 50));
        sendGeekMessage(newContent);
      }
    },
    [settings.mode, sendGeekMessage, submitCloudMessage, commitMessages]
  );

  // ── Session management ────────────────────────────────
  /** Load a previous session's messages and reconnect */
  const loadSession = useCallback(
    async (targetSessionId: string) => {
      const loadIntent = ++sessionLoadIntentRef.current;
      const generation = replayGenerationRef.current;
      const targetProjectId = projectIdRef.current;
      const targetConnectionKey = getWorkspaceConnectionKey(settingsRef.current);
      let loaded: StoredMessage[];
      try {
        loaded = await loadChatHistoryStrict(targetSessionId);
      } catch (error) {
        if (
          loadIntent === sessionLoadIntentRef.current &&
          generation === replayGenerationRef.current &&
          projectIdRef.current === targetProjectId &&
          getWorkspaceConnectionKey(settingsRef.current) === targetConnectionKey
        ) {
          console.warn("[ChatHistory] Failed to load session:", error);
          setStreamNotice("会话历史读取失败，已保留当前会话，请重试");
        }
        return;
      }
      if (
        loadIntent !== sessionLoadIntentRef.current ||
        generation !== replayGenerationRef.current ||
        projectIdRef.current !== targetProjectId ||
        getWorkspaceConnectionKey(settingsRef.current) !== targetConnectionKey
      ) {
        return;
      }
      abortRef.current?.abort();
      cancelReplayDrain();
      conn.disconnect();
      conn.resetSessionCursor();
      setIsConnected(false);
      commitMessages(() => loaded as Message[]);
      // I1 修复:从存档重建 CoreMessage 历史(而非重置为 []),使 loadSession 后
      // geek 续聊仍能看到之前对话的上下文。
      coreHistoryRef.current = storedToCoreMessages(loaded);
      setSessionId(targetSessionId);
      sessionIdRef.current = targetSessionId; // 立即更新,供 connect() 使用
      setIsStreaming(false);
      isStreamingRef.current = false;
      activeTurnIdRef.current = null;
      activeTurnKindRef.current = null;
      renderTurnIdRef.current = null;
      setLastStopReason(null);
      setStreamNotice(null);
      setCompactionNotice(null);
      setEditCutoff(0);
      setGoalState(null);
      goalStateRef.current = null;
      hydratedProvisionalScopeRef.current = null;
      pendingRebindScopeRef.current = null;
      if (needsAutoConnect) setTimeout(() => connect(), 50); // loadSession 断开后延迟重连
    },
    [conn, connect, needsAutoConnect, commitMessages, cancelReplayDrain]
  );
  loadSessionRef.current = loadSession;

  /** Start a new empty session */
  const newSession = useCallback(() => {
    sessionLoadIntentRef.current += 1;
    abortRef.current?.abort();
    cancelReplayDrain();
    conn.disconnect();
    conn.resetSessionCursor();
    commitMessages(() => []);
    coreHistoryRef.current = [];
    setSessionId(null);
    sessionIdRef.current = null;
    setIsStreaming(false);
    isStreamingRef.current = false;
    activeTurnIdRef.current = null;
    activeTurnKindRef.current = null;
    renderTurnIdRef.current = null;
    setLastStopReason(null);
    setStreamNotice(null);
    setCompactionNotice(null);
    setEditCutoff(0);
    setGoalState(null);
    goalStateRef.current = null;
    hydratedProvisionalScopeRef.current = null;
    pendingRebindScopeRef.current = null;
  }, [conn, commitMessages, cancelReplayDrain]);

  // ── Reset session when project changes ───────────────
  useEffect(() => {
    if (!projectId) return;
    sessionLoadIntentRef.current += 1;
    abortRef.current?.abort();
    cancelReplayDrain();
    conn.disconnect();
    conn.resetSessionCursor();
    commitMessages(() => []);
    coreHistoryRef.current = [];
    setSessionId(null);
    sessionIdRef.current = null;
    setIsStreaming(false);
    isStreamingRef.current = false;
    activeTurnIdRef.current = null;
    activeTurnKindRef.current = null;
    renderTurnIdRef.current = null;
    setIsConnected(false);
    setLastStopReason(null);
    setStreamNotice(null);
    setCompactionNotice(null);
    setEditCutoff(0);
    setGoalState(null);
    goalStateRef.current = null;
    hydratedProvisionalScopeRef.current = null;
    pendingRebindScopeRef.current = null;
    activeRemoteReplicaRef.current = null;
  }, [
    projectId,
    workspaceHandle?.generation,
    workspaceRoot,
    conn,
    commitMessages,
    cancelReplayDrain,
  ]);

  // ── Cleanup ───────────────────────────────────────────
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      cancelReplayDrain();
      conn.disconnect();
    };
  }, [conn, cancelReplayDrain]);

  return {
    messages,
    setMessages: (next: Message[] | ((current: Message[]) => Message[])) => {
      commitMessages((current) => (typeof next === "function" ? next(current) : next));
    },
    isConnected,
    isStreaming,
    activeTurnId: renderTurnIdRef.current,
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
    upsertRemoteGitCredential,
    testRemoteGitCredential,
    deleteRemoteGitCredential,
    importRemoteGitWorkspace,
    runRemoteGitWorkspaceOperation,
    deleteProjectWorkspace,
  };
}
