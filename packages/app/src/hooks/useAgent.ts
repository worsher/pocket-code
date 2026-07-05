// ── useAgent:瘦组合层 ─────────────────────────────────────
// P6b:传输交给 ServerConnection,UI 更新交给 chatReducer(applyAgentEvent
// /phaseFor)。云端与 geek 共用同一 reducer,对外 API 面保持不变。
import { useState, useRef, useCallback, useEffect } from "react";
import { AppState } from "react-native";
import { getModelConfig, getApiKeyField, MODELS } from "../services/modelConfig";
import { updateSettings, type AppSettings } from "../store/settings";
import { saveChatHistory, loadChatHistory, type StoredMessage } from "../store/chatHistory";
import { executeLocalTool, writeLocalFile, getProjectWorkspaceRoot } from "../services/localFileSystem";
import type { StreamingPhase } from "../components/StreamingIndicator";
import { enqueueMessage, getQueue, dequeueMessage } from "../services/offlineQueue";
import { sendLocalNotification } from "../services/notifications";
import { ServerConnection, type ConnectionConfig, type ConnectionHandlers } from "../services/serverConnection";
import { applyAgentEvent, phaseFor } from "./chatReducer";
import type { Message, ImageAttachment } from "./chatReducer";
import { runGeekLoop, buildChatHistory } from "./geekLoop";
import type { AgentEventType } from "@pocket-code/wire";

// ── Public Types(re-export) ───────────────────────────────
export type { StreamingPhase } from "../components/StreamingIndicator";
export type { Message, ToolCall, ImageAttachment } from "./chatReducer";

export interface ModelInfo { key: string; label: string; description: string; }
export const AVAILABLE_MODELS: ModelInfo[] = MODELS.map((m) => ({ key: m.key, label: m.label, description: m.description }));

// ── Hook Options ───────────────────────────────────────
interface UseAgentOptions {
  settings: AppSettings;
  model?: string;
  customPrompt?: string;
  projectId?: string;
  /** Called when AI modifies a file (writeFile/editFile). Used by WorkspaceContext for auto-refresh. */
  onFileChanged?: (path: string, action: "created" | "modified" | "deleted") => void;
}

// ── Sync filtering ────────────────────────────────────────
const SYNC_IGNORE_DIRS = ["node_modules", ".git", "dist", "build", ".next", ".cache", "__pycache__", ".tox", "vendor"];
const SYNC_IGNORE_EXTENSIONS = [".lock", ".log"];
const SYNC_IGNORE_FILES = [".gitconfig", ".git-credentials"];
const MAX_SYNC_FILE_SIZE = 512 * 1024; // 512KB

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
  const firstLine = (res?.stdout || res?.stderr || res?.error || "").trim().split("\n")[0].slice(0, 80);
  sendLocalNotification(ok ? "命令执行完成 ✓" : "命令执行失败 ✗", firstLine || (ok ? "命令已完成" : "命令执行失败"));
}

const mkUserMsg = (content: string, images?: ImageAttachment[]): Message => ({
  id: Date.now().toString(), role: "user", content, images, timestamp: Date.now(),
});
const mkAssistantMsg = (): Message => ({
  id: (Date.now() + 1).toString(), role: "assistant", content: "", toolCalls: [], timestamp: Date.now(),
});

// ── Main Hook ──────────────────────────────────────────
export function useAgent({ settings, model = "deepseek-v3", customPrompt, projectId, onFileChanged }: UseAgentOptions) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [streamingPhase, setStreamingPhase] = useState<StreamingPhase>("idle");
  const [currentToolName, setCurrentToolName] = useState<string | undefined>();
  // 设备授权失效(token 被 daemon 拒绝):非空表示需要重新配对
  const [authError, setAuthError] = useState<string | null>(null);
  // 最新值 refs(避免 handler/闭包中的 stale closure)
  const abortRef = useRef<AbortController | null>(null);
  const modelRef = useRef(model); modelRef.current = model;
  const customPromptRef = useRef(customPrompt); customPromptRef.current = customPrompt;
  const projectIdRef = useRef(projectId); projectIdRef.current = projectId;
  const onFileChangedRef = useRef(onFileChanged); onFileChangedRef.current = onFileChanged;
  const workspaceModeRef = useRef(settings.workspaceMode); workspaceModeRef.current = settings.workspaceMode;
  const settingsRef = useRef(settings); settingsRef.current = settings;
  const gitCredentialsRef = useRef(settings.gitCredentials); gitCredentialsRef.current = settings.gitCredentials;
  const sessionIdRef = useRef(sessionId); sessionIdRef.current = sessionId;
  const messagesRef = useRef(messages); messagesRef.current = messages;
  const modeRef = useRef(settings.mode); modeRef.current = settings.mode;
  const authTokenRef = useRef(settings.authToken); authTokenRef.current = settings.authToken;
  const deviceIdRef = useRef(settings.deviceId); deviceIdRef.current = settings.deviceId;
  // callId → toolName(runCommand 后台通知需知道工具名)
  const callNamesRef = useRef(new Map<string, string>());

  const serverUrl = settings.mode === "geek"
    ? settings.toolServerUrl
    : (settings.workspaceMode === "relay" ? (settings.relayServerUrl || "wss://relay.your-vps.com") : settings.cloudServerUrl);
  const serverUrlRef = useRef(serverUrl); serverUrlRef.current = serverUrl;

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
    saveChatHistory(sid, msgs as StoredMessage[], projectIdRef.current || '').catch(() => { });
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
        sessionId: sessionIdRef.current,
        projectId: projectIdRef.current || undefined,
        model: modelRef.current,
        gitCredentials: gitCredentialsRef.current?.filter((c) => c.token) || [],
      }),
      isRelayPaired: () =>
        !!(settingsRef.current.relayToken && settingsRef.current.relayMachineId),
    };

    const handlers: ConnectionHandlers = {
      onAgentEvent: (ev: AgentEventType) => {
        // geek 模式的事件由本地适配层 emitGeek 产生,忽略来自服务器的流式事件
        if (modeRef.current === "geek") return;

        setMessages((prev) => applyAgentEvent(prev, ev));
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
      onSession: (sid: string) => setSessionId(sid),
      onConnected: () => {
        setIsConnected(true);
        setAuthError(null);
        replayOfflineQueue();
      },
      onDisconnected: () => setIsConnected(false),
      onAuthError: (msg: string) => setAuthError(msg),
      onFileChanged: (path: string, changeType: "created" | "modified" | "deleted") => {
        onFileChangedRef.current?.(path, changeType);
        // local 模式:自动同步到本地(读取失败非致命,文件仍在远端)
        if (workspaceModeRef.current === "local" && projectIdRef.current && shouldSyncFile(path)) {
          const localRoot = getProjectWorkspaceRoot(projectIdRef.current);
          connRef.current?.readFile(path).then((result: any) => {
            if (result?.success && result.content != null && result.content.length <= MAX_SYNC_FILE_SIZE) {
              writeLocalFile(path, result.content, localRoot);
            }
          }).catch(() => { /* non-critical */ });
        }
      },
    };

    connRef.current = new ServerConnection(config, handlers);
  }
  const conn = connRef.current;

  // ── Offline queue replay(连接建立后) ─────────────────
  const replayOfflineQueue = useCallback(async () => {
    const queue = await getQueue();
    for (const msg of queue) {
      if (!conn.isOpen) break;
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
        const localResult = await executeLocalTool(toolName, args, settingsRef.current);
        if (localResult !== null) return localResult;
      }
      return conn.execTool(toolName, args); // Termux 或 runCommand 回退
    },
    [conn]
  );

  // ── File / sync RPC(透传 ServerConnection) ────────────
  const requestFileList = useCallback((path: string = ".") => conn.listFiles(path), [conn]);
  const requestFileContent = useCallback((path: string) => conn.readFile(path), [conn]);
  const requestSyncPull = useCallback((sinceCommit?: string) => conn.syncPull(sinceCommit), [conn]);
  const requestSyncFile = useCallback((commit: string, path: string) => conn.syncFile(commit, path), [conn]);

  const deleteProjectWorkspace = useCallback(
    (pid: string) => { conn.sendRaw({ type: "delete-project-workspace", projectId: pid }); },
    [conn]
  );

  // ── 云端发送 ──────────────────────────────────────────
  const sendCloudMessage = useCallback(
    (content: string, images?: ImageAttachment[]) => {
      setMessages((prev) => [...prev, mkUserMsg(content, images), mkAssistantMsg()]);
      setIsStreaming(true);
      setStreamingPhase("connecting");

      const payload: Record<string, unknown> = { type: "message", content, model: modelRef.current };
      if (images?.length) {
        payload.images = images.map((img) => ({ base64: img.base64, mimeType: img.mimeType }));
      }
      if (customPromptRef.current) payload.customPrompt = customPromptRef.current;
      conn.sendRaw(payload);
    },
    [conn]
  );

  // ── geek 模式:reducer 喂事件 ──────────────────────────
  const emitGeek = useCallback((ev: AgentEventType) => {
    setMessages((prev) => applyAgentEvent(prev, ev));
    const p = phaseFor(ev);
    if (p) setStreamingPhase(p);
  }, []);

  // ── Geek mode: App drives the agent loop ─────────────
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
      const apiKey = apiKeyField ? (settings.apiKeys[apiKeyField] || "") : "";

      const userMsg = mkUserMsg(content, images);
      setMessages((prev) => [...prev, userMsg, mkAssistantMsg()]);
      setIsStreaming(true);
      setStreamingPhase("connecting");

      const chatHistory = buildChatHistory([...messages, userMsg]);
      const abortController = new AbortController();
      abortRef.current = abortController;
      try {
        await runGeekLoop({
          modelConfig, apiKey, chatHistory, signal: abortController.signal, settings,
          customPrompt: customPromptRef.current,
          emitGeek, executeTool, setCurrentToolName, setStreamingPhase,
        });
      } catch (err: any) {
        if (err.name !== "AbortError") emitGeek({ type: "error", message: String(err.message) });
      } finally {
        abortRef.current = null;
        finalizeStreaming();
      }
    },
    [messages, settings, executeTool, emitGeek, finalizeStreaming]
  );

  // ── Send message ──────────────────────────────────────
  const sendMessage = useCallback(
    async (content: string, images?: ImageAttachment[]) => {
      if (settings.mode === "cloud") {
        if (!conn.isOpen) {
          // 未连接:入队待重放,并本地插入 pending 用户消息以可见
          await enqueueMessage(sessionIdRef.current || "", content);
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

  // ── Edit & Resend (conversation branching) ────────────
  const editAndResend = useCallback(
    async (messageId: string, newContent: string) => {
      const idx = messagesRef.current.findIndex((m) => m.id === messageId);
      if (idx === -1) return;

      // 截断到目标消息之前;立即更新 ref 供后续构建历史使用
      const truncated = messagesRef.current.slice(0, idx);
      setMessages(truncated);
      messagesRef.current = truncated;

      if (settings.mode === "cloud") {
        await new Promise((r) => setTimeout(r, 50));
        if (!conn.isOpen) return;
        setMessages((prev) => [...prev, mkUserMsg(newContent), mkAssistantMsg()]);
        setIsStreaming(true);
        setStreamingPhase("connecting");

        const payload: Record<string, unknown> = {
          type: "message", content: newContent, model: modelRef.current, rewindTo: idx,
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
      setSessionId(targetSessionId);
      sessionIdRef.current = targetSessionId; // 立即更新,供 connect() 使用
      setIsStreaming(false);
      if (needsAutoConnect) setTimeout(() => connect(), 50); // loadSession 断开后延迟重连
    },
    [conn, connect, needsAutoConnect]
  );

  /** Start a new empty session */
  const newSession = useCallback(() => {
    abortRef.current?.abort();
    conn.disconnect();
    setMessages([]);
    setSessionId(null);
    setIsStreaming(false);
  }, [conn]);

  // ── Reset session when project changes ───────────────
  useEffect(() => {
    if (!projectId) return;
    abortRef.current?.abort();
    conn.disconnect();
    setMessages([]);
    setSessionId(null);
    sessionIdRef.current = null;
    setIsStreaming(false);
    setIsConnected(false);
  }, [projectId, conn]);

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
    deleteProjectWorkspace,
  };
}
