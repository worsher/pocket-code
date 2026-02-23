import { useState, useRef, useCallback, useEffect } from "react";
import { AppState } from "react-native";
import {
  streamChat,
  type ChatMessage,
  type ToolCallRequest,
} from "../services/aiClient";
import { getModelConfig, MODELS, type ModelConfig } from "../services/modelConfig";
import type { AppSettings } from "../store/settings";
import {
  saveChatHistory,
  loadChatHistory,
  type StoredMessage,
} from "../store/chatHistory";
import { executeLocalTool } from "../services/localFileSystem";
import { updateSettings } from "../store/settings";
import type { StreamingPhase } from "../components/StreamingIndicator";
import { enqueueMessage, getQueue, dequeueMessage } from "../services/offlineQueue";
import { sendLocalNotification } from "../services/notifications";

// ── Public Types ───────────────────────────────────────

export type { StreamingPhase } from "../components/StreamingIndicator";

export interface ImageAttachment {
  uri: string;
  base64: string;
  mimeType: "image/jpeg" | "image/png";
}

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  thinking?: string;
  toolCalls?: ToolCall[];
  images?: ImageAttachment[];
  timestamp: number;
  pending?: boolean;
  modelUsed?: string;
}

export interface ToolCall {
  toolName: string;
  args: Record<string, unknown>;
  result?: unknown;
}

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
}

// ── Main Hook ──────────────────────────────────────────

export function useAgent({ settings, model = "deepseek-v3", customPrompt, projectId }: UseAgentOptions) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [streamingPhase, setStreamingPhase] = useState<StreamingPhase>("idle");
  const [currentToolName, setCurrentToolName] = useState<string | undefined>();

  const wsRef = useRef<WebSocket | null>(null);
  const currentAssistantRef = useRef<Message | null>(null);
  const modelRef = useRef(model);
  const abortRef = useRef<AbortController | null>(null);
  modelRef.current = model;

  const customPromptRef = useRef(customPrompt);
  customPromptRef.current = customPrompt;

  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;

  // Ref for workspaceMode — avoid stale closure in executeTool
  const workspaceModeRef = useRef(settings.workspaceMode);
  workspaceModeRef.current = settings.workspaceMode;

  // Ref for full settings — needed by executeLocalTool (git auth)
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  // Ref for gitCredentials — avoid stale closure in connect
  const gitCredentialsRef = useRef(settings.gitCredentials);
  gitCredentialsRef.current = settings.gitCredentials;

  // Refs for save — avoid stale closure
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  // Pending tool result resolvers (geek mode)
  const toolResolvers = useRef<
    Map<string, (result: unknown) => void>
  >(new Map());

  // File operation resolvers
  const fileResolvers = useRef<
    Map<string, (result: unknown) => void>
  >(new Map());

  // ── Save helper (debounced, avoids high-frequency saves) ──
  const saveMessages = useCallback((msgs: Message[], sid: string | null) => {
    if (!sid || msgs.length === 0) return;
    saveChatHistory(sid, msgs as StoredMessage[], projectIdRef.current || '').catch(() => { });
  }, []);

  // ── Determine the Server URL based on mode ────────────
  const serverUrl =
    settings.mode === "geek" ? settings.toolServerUrl : settings.cloudServerUrl;

  // Whether auto-connect is needed:
  // - Cloud mode: always (all operations go through server)
  // - Geek + server (Termux): always (all tools go through WS)
  // - Geek + local: no (only runCommand needs WS, lazy connect)
  const needsAutoConnect =
    settings.mode === "cloud" || settings.workspaceMode === "server";

  // ── Auth helpers ─────────────────────────────────────
  const authTokenRef = useRef(settings.authToken);
  authTokenRef.current = settings.authToken;
  const deviceIdRef = useRef(settings.deviceId);
  deviceIdRef.current = settings.deviceId;

  /** Generate or retrieve a persistent deviceId */
  const getDeviceId = useCallback((): string => {
    if (deviceIdRef.current) return deviceIdRef.current;
    const id = `dev_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    // Persist deviceId (fire-and-forget)
    updateSettings({ deviceId: id });
    deviceIdRef.current = id;
    return id;
  }, []);

  /** Send init message with token */
  const sendInit = useCallback((ws: WebSocket, token: string) => {
    ws.send(
      JSON.stringify({
        type: "init",
        token,
        sessionId: sessionIdRef.current,
        projectId: projectIdRef.current || undefined,
        model: modelRef.current,
        gitCredentials: gitCredentialsRef.current?.filter((c) => c.token) || [],
      })
    );
  }, []);

  // ── WebSocket connection (shared between modes) ───────
  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    console.log("[useAgent] Connecting to:", serverUrl, "mode:", settings.mode);
    const ws = new WebSocket(serverUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log("[useAgent] WebSocket connected");
      setIsConnected(true);

      // If we already have a token, go straight to init
      if (authTokenRef.current) {
        sendInit(ws, authTokenRef.current);
      } else {
        // Register anonymously first
        const deviceId = getDeviceId();
        ws.send(JSON.stringify({ type: "register", deviceId }));
      }

      // Replay any queued offline messages
      replayOfflineQueue();
    };

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);

      switch (data.type) {
        // ── Auth response (anonymous registration) ──
        case "auth": {
          const token = data.token;
          const userId = data.userId;
          // Persist token (fire-and-forget)
          updateSettings({ authToken: token, userId });
          authTokenRef.current = token;
          // Now send init
          sendInit(ws, token);
          break;
        }

        case "session":
          setSessionId(data.sessionId);
          break;

        // ── Cloud mode events ────────────────────────
        case "text-delta":
          if (settings.mode === "cloud" && currentAssistantRef.current) {
            setStreamingPhase("generating");
            setMessages((prev) => {
              const updated = [...prev];
              const last = updated[updated.length - 1];
              if (last?.role === "assistant") {
                updated[updated.length - 1] = {
                  ...last,
                  content: last.content + data.text,
                };
              }
              return updated;
            });
          }
          break;

        case "reasoning-delta":
          if (settings.mode === "cloud" && currentAssistantRef.current) {
            setStreamingPhase("thinking");
            setMessages((prev) => {
              const updated = [...prev];
              const last = updated[updated.length - 1];
              if (last?.role === "assistant") {
                updated[updated.length - 1] = {
                  ...last,
                  thinking: (last.thinking || "") + data.text,
                };
              }
              return updated;
            });
          }
          break;

        case "model-selected":
          if (settings.mode === "cloud") {
            setMessages((prev) => {
              const updated = [...prev];
              const last = updated[updated.length - 1];
              if (last?.role === "assistant") {
                updated[updated.length - 1] = {
                  ...last,
                  modelUsed: data.model,
                };
              }
              return updated;
            });
          }
          break;

        case "tool-call":
          if (settings.mode === "cloud") {
            setStreamingPhase("tool-calling");
            setCurrentToolName(data.toolName);
            setMessages((prev) => {
              const updated = [...prev];
              const last = updated[updated.length - 1];
              if (last?.role === "assistant") {
                const toolCalls = [
                  ...(last.toolCalls || []),
                  { toolName: data.toolName, args: data.args },
                ];
                updated[updated.length - 1] = { ...last, toolCalls };
              }
              return updated;
            });
            // Transition to tool-running after a brief delay
            setTimeout(() => setStreamingPhase("tool-running"), 100);
          }
          break;

        case "tool-result":
          if (settings.mode === "cloud") {
            setStreamingPhase("generating");
            setCurrentToolName(undefined);
            setMessages((prev) => {
              const updated = [...prev];
              const last = updated[updated.length - 1];
              if (last?.role === "assistant" && last.toolCalls) {
                const toolCalls = [...last.toolCalls];
                const tc = toolCalls.find(
                  (t) => t.toolName === data.toolName && !t.result
                );
                if (tc) tc.result = data.result;
                updated[updated.length - 1] = { ...last, toolCalls };
              }
              return updated;
            });
          } else {
            // Geek mode: resolve the pending tool execution
            const resolver = toolResolvers.current.get(data.callId);
            if (resolver) {
              resolver(data.result);
              toolResolvers.current.delete(data.callId);
            }
          }
          break;

        case "done":
          if (settings.mode === "cloud") {
            setIsStreaming(false);
            setStreamingPhase("idle");
            setCurrentToolName(undefined);
            currentAssistantRef.current = null;
            // Save after cloud mode round completes
            saveMessages(messagesRef.current, sessionIdRef.current);
            // Background notification
            if (AppState.currentState !== "active") {
              const lastMsg = messagesRef.current[messagesRef.current.length - 1];
              const summary = lastMsg?.content?.slice(0, 100) || "任务已完成";
              sendLocalNotification("Pocket Code", summary);
            }
          }
          break;

        case "error":
          setIsStreaming(false);
          setStreamingPhase("idle");
          setCurrentToolName(undefined);
          currentAssistantRef.current = null;
          if (settings.mode === "cloud") {
            setMessages((prev) => {
              const updated = [...prev];
              const last = updated[updated.length - 1];
              if (last?.role === "assistant") {
                updated[updated.length - 1] = {
                  ...last,
                  content: last.content + `\n\nError: ${data.error}`,
                };
              }
              return updated;
            });
          }
          break;

        // ── File operations ────────────────────────
        case "file-list":
        case "file-content": {
          const reqId = data._reqId;
          if (reqId) {
            const resolver = fileResolvers.current.get(reqId);
            if (resolver) {
              resolver(data);
              fileResolvers.current.delete(reqId);
            }
          }
          break;
        }
      }
    };

    ws.onclose = (e) => {
      console.log("[useAgent] WebSocket closed, code:", e.code, "reason:", e.reason);
      setIsConnected(false);
    };

    ws.onerror = (e) => {
      console.error("[useAgent] WebSocket error:", (e as any).message || e);
      setIsConnected(false);
    };
  }, [serverUrl, settings.mode, saveMessages, getDeviceId, sendInit]);

  const disconnect = useCallback(() => {
    abortRef.current?.abort();
    wsRef.current?.close();
    wsRef.current = null;
  }, []);

  const stopStreaming = useCallback(() => {
    // Geek mode: abort the AI stream
    abortRef.current?.abort();
    abortRef.current = null;

    // Cloud mode: send abort message to server
    if (settings.mode === "cloud" && wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "abort" }));
    }

    setIsStreaming(false);
    setStreamingPhase("idle");
    setCurrentToolName(undefined);
    currentAssistantRef.current = null;
  }, [settings.mode]);

  // ── Execute a tool (geek mode) ──────────────────────
  // workspaceMode=server: all tools go through WebSocket (Termux mode)
  // workspaceMode=local: file tools run locally, runCommand falls back to WS
  const executeTool = useCallback(
    async (toolName: string, args: Record<string, unknown>): Promise<unknown> => {
      // When workspaceMode is "local", try local execution first
      if (workspaceModeRef.current !== "server") {
        const localResult = await executeLocalTool(toolName, args, settingsRef.current);
        if (localResult !== null) {
          console.log("[useAgent] Tool executed locally:", toolName);
          return localResult;
        }
      }

      // WebSocket execution (Termux mode or runCommand fallback)
      return new Promise((resolve, reject) => {
        const ws = wsRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          reject(new Error("Tool server not connected. Cannot execute: " + toolName));
          return;
        }
        const callId = `tc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        toolResolvers.current.set(callId, resolve);

        // Timeout after 30s
        setTimeout(() => {
          if (toolResolvers.current.has(callId)) {
            toolResolvers.current.delete(callId);
            reject(new Error(`Tool ${toolName} timed out`));
          }
        }, 30000);

        ws.send(JSON.stringify({ type: "tool-exec", callId, toolName, args }));
      });
    },
    []
  );

  // ── File operations via WebSocket ─────────────────────
  const requestFileList = useCallback(
    (path: string = "."): Promise<any> => {
      return new Promise((resolve, reject) => {
        const ws = wsRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          reject(new Error("WebSocket not connected"));
          return;
        }
        const reqId = `fr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        fileResolvers.current.set(reqId, resolve);

        setTimeout(() => {
          if (fileResolvers.current.has(reqId)) {
            fileResolvers.current.delete(reqId);
            reject(new Error("File list request timed out"));
          }
        }, 10000);

        ws.send(JSON.stringify({ type: "list-files", path, _reqId: reqId }));
      });
    },
    []
  );

  const requestFileContent = useCallback(
    (path: string): Promise<any> => {
      return new Promise((resolve, reject) => {
        const ws = wsRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          reject(new Error("WebSocket not connected"));
          return;
        }
        const reqId = `fr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        fileResolvers.current.set(reqId, resolve);

        setTimeout(() => {
          if (fileResolvers.current.has(reqId)) {
            fileResolvers.current.delete(reqId);
            reject(new Error("File read request timed out"));
          }
        }, 10000);

        ws.send(JSON.stringify({ type: "read-file", path, _reqId: reqId }));
      });
    },
    []
  );

  // ── Send message ──────────────────────────────────────
  const sendMessage = useCallback(
    async (content: string, images?: ImageAttachment[]) => {
      if (settings.mode === "cloud") {
        // If WebSocket is not connected, queue the message for later
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
          await enqueueMessage(sessionIdRef.current || "", content);
          // Add user message locally so it's visible
          const offlineMsg: Message = {
            id: Date.now().toString(),
            role: "user",
            content,
            images,
            timestamp: Date.now(),
            pending: true,
          };
          setMessages((prev) => [...prev, offlineMsg]);
          return;
        }
        sendCloudMessage(content, images);
      } else {
        sendGeekMessage(content, images);
      }
    },
    [settings.mode]
  );

  // Replay offline queue when connection is established
  const replayOfflineQueue = useCallback(async () => {
    const queue = await getQueue();
    for (const msg of queue) {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        sendCloudMessage(msg.content);
        await dequeueMessage(msg.id);
        // Small delay between replayed messages
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }, []);

  // ── Cloud mode: forward to Server (existing logic) ───
  const sendCloudMessage = useCallback(
    (content: string, images?: ImageAttachment[]) => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

      const userMsg: Message = {
        id: Date.now().toString(),
        role: "user",
        content,
        images,
        timestamp: Date.now(),
      };

      const assistantMsg: Message = {
        id: (Date.now() + 1).toString(),
        role: "assistant",
        content: "",
        toolCalls: [],
        timestamp: Date.now(),
      };

      currentAssistantRef.current = assistantMsg;
      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      setIsStreaming(true);
      setStreamingPhase("connecting");

      const payload: Record<string, unknown> = {
        type: "message",
        content,
        model: modelRef.current,
      };
      if (images?.length) {
        payload.images = images.map((img) => ({
          base64: img.base64,
          mimeType: img.mimeType,
        }));
      }
      if (customPromptRef.current) {
        payload.customPrompt = customPromptRef.current;
      }
      wsRef.current.send(JSON.stringify(payload));
    },
    []
  );

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
      const apiKey = settings.apiKeys[modelConfig.provider] || "";

      const userMsg: Message = {
        id: Date.now().toString(),
        role: "user",
        content,
        images,
        timestamp: Date.now(),
      };

      const assistantMsg: Message = {
        id: (Date.now() + 1).toString(),
        role: "assistant",
        content: "",
        toolCalls: [],
        timestamp: Date.now(),
      };

      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      setIsStreaming(true);
      setStreamingPhase("connecting");

      // Build conversation history for the AI
      const chatHistory: ChatMessage[] = [];
      const allMsgs = [...messages, userMsg];
      for (const msg of allMsgs) {
        if (msg.role === "user") {
          if (msg.images?.length) {
            // Multi-modal message: build content parts (OpenAI image_url format)
            // Anthropic conversion is handled in aiClient.ts streamChatAnthropic
            const contentParts: any[] = [
              { type: "text", text: msg.content },
            ];
            for (const img of msg.images) {
              contentParts.push({
                type: "image_url",
                image_url: {
                  url: `data:${img.mimeType};base64,${img.base64}`,
                },
              });
            }
            chatHistory.push({ role: "user", content: contentParts } as any);
          } else {
            chatHistory.push({ role: "user", content: msg.content });
          }
        } else if (msg.role === "assistant") {
          if (msg.toolCalls?.length) {
            const toolCalls: ToolCallRequest[] = msg.toolCalls.map((tc, i) => ({
              id: `tc_hist_${msg.id}_${i}`,
              type: "function" as const,
              function: {
                name: tc.toolName,
                arguments: JSON.stringify(tc.args),
              },
            }));
            chatHistory.push({
              role: "assistant",
              content: msg.content,
              tool_calls: toolCalls,
            });
            for (let i = 0; i < msg.toolCalls.length; i++) {
              const tc = msg.toolCalls[i];
              if (tc.result !== undefined) {
                chatHistory.push({
                  role: "tool",
                  content: JSON.stringify(tc.result),
                  tool_call_id: `tc_hist_${msg.id}_${i}`,
                });
              }
            }
          } else {
            chatHistory.push({ role: "assistant", content: msg.content });
          }
        }
      }

      const abortController = new AbortController();
      abortRef.current = abortController;

      const MAX_STEPS = 10;
      let step = 0;

      try {
        while (step < MAX_STEPS) {
          step++;
          let pendingToolCalls: {
            id: string;
            name: string;
            args: Record<string, unknown>;
          }[] = [];
          let stepText = "";

          await streamChat({
            model: modelConfig,
            apiKey,
            messages: chatHistory,
            signal: abortController.signal,
            settings,
            customPrompt: customPromptRef.current,
            callbacks: {
              onTextDelta: (text) => {
                setStreamingPhase("generating");
                stepText += text;
                setMessages((prev) => {
                  const updated = [...prev];
                  const last = updated[updated.length - 1];
                  if (last?.role === "assistant") {
                    updated[updated.length - 1] = {
                      ...last,
                      content: last.content + text,
                    };
                  }
                  return updated;
                });
              },
              onThinking: (text) => {
                setStreamingPhase("thinking");
                setMessages((prev) => {
                  const updated = [...prev];
                  const last = updated[updated.length - 1];
                  if (last?.role === "assistant") {
                    updated[updated.length - 1] = {
                      ...last,
                      thinking: (last.thinking || "") + text,
                    };
                  }
                  return updated;
                });
              },
              onToolCall: (id, name, args) => {
                setStreamingPhase("tool-calling");
                setCurrentToolName(name);
                pendingToolCalls.push({ id, name, args });
                setMessages((prev) => {
                  const updated = [...prev];
                  const last = updated[updated.length - 1];
                  if (last?.role === "assistant") {
                    const toolCalls = [
                      ...(last.toolCalls || []),
                      { toolName: name, args },
                    ];
                    updated[updated.length - 1] = { ...last, toolCalls };
                  }
                  return updated;
                });
              },
              onDone: () => { },
              onError: (error) => {
                setMessages((prev) => {
                  const updated = [...prev];
                  const last = updated[updated.length - 1];
                  if (last?.role === "assistant") {
                    updated[updated.length - 1] = {
                      ...last,
                      content: last.content + `\n\nError: ${error}`,
                    };
                  }
                  return updated;
                });
              },
            },
          });

          if (pendingToolCalls.length === 0) {
            break;
          }

          const assistantToolCalls: ToolCallRequest[] = pendingToolCalls.map(
            (tc) => ({
              id: tc.id,
              type: "function" as const,
              function: {
                name: tc.name,
                arguments: JSON.stringify(tc.args),
              },
            })
          );
          chatHistory.push({
            role: "assistant",
            content: stepText,
            tool_calls: assistantToolCalls,
          });

          for (const tc of pendingToolCalls) {
            try {
              setStreamingPhase("tool-running");
              setCurrentToolName(tc.name);
              const result = await executeTool(tc.name, tc.args);
              chatHistory.push({
                role: "tool",
                content: JSON.stringify(result),
                tool_call_id: tc.id,
              });
              setMessages((prev) => {
                const updated = [...prev];
                const last = updated[updated.length - 1];
                if (last?.role === "assistant" && last.toolCalls) {
                  const toolCalls = [...last.toolCalls];
                  const existing = toolCalls.find(
                    (t) => t.toolName === tc.name && !t.result
                  );
                  if (existing) existing.result = result;
                  updated[updated.length - 1] = { ...last, toolCalls };
                }
                return updated;
              });
            } catch (err: any) {
              const errorResult = { success: false, error: err.message };
              chatHistory.push({
                role: "tool",
                content: JSON.stringify(errorResult),
                tool_call_id: tc.id,
              });
            }
          }
        }
      } catch (err: any) {
        if (err.name !== "AbortError") {
          setMessages((prev) => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last?.role === "assistant") {
              updated[updated.length - 1] = {
                ...last,
                content: last.content + `\n\nError: ${err.message}`,
              };
            }
            return updated;
          });
        }
      } finally {
        setIsStreaming(false);
        setStreamingPhase("idle");
        setCurrentToolName(undefined);
        abortRef.current = null;
        // Save after geek mode round completes
        saveMessages(messagesRef.current, sessionIdRef.current);
        // Background notification
        if (AppState.currentState !== "active") {
          const lastMsg = messagesRef.current[messagesRef.current.length - 1];
          const summary = lastMsg?.content?.slice(0, 100) || "任务已完成";
          sendLocalNotification("Pocket Code", summary);
        }
      }
    },
    [messages, settings.apiKeys, executeTool, saveMessages]
  );

  // ── Edit & Resend (conversation branching) ────────────
  const editAndResend = useCallback(
    async (messageId: string, newContent: string) => {
      const idx = messagesRef.current.findIndex((m) => m.id === messageId);
      if (idx === -1) return;

      // Truncate messages to before the target message
      const truncated = messagesRef.current.slice(0, idx);
      setMessages(truncated);
      // Update ref immediately so sendMessage uses truncated history
      messagesRef.current = truncated;

      // For cloud mode, include rewindTo index
      if (settings.mode === "cloud") {
        // Wait a tick for state to settle, then send with rewindTo
        await new Promise((r) => setTimeout(r, 50));
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

        const userMsg: Message = {
          id: Date.now().toString(),
          role: "user",
          content: newContent,
          timestamp: Date.now(),
        };
        const assistantMsg: Message = {
          id: (Date.now() + 1).toString(),
          role: "assistant",
          content: "",
          toolCalls: [],
          timestamp: Date.now(),
        };

        currentAssistantRef.current = assistantMsg;
        setMessages((prev) => [...prev, userMsg, assistantMsg]);
        setIsStreaming(true);
        setStreamingPhase("connecting");

        const payload: Record<string, unknown> = {
          type: "message",
          content: newContent,
          model: modelRef.current,
          rewindTo: idx,
        };
        if (customPromptRef.current) {
          payload.customPrompt = customPromptRef.current;
        }
        wsRef.current.send(JSON.stringify(payload));
      } else {
        // Geek mode: just send with truncated history
        await new Promise((r) => setTimeout(r, 50));
        sendGeekMessage(newContent);
      }
    },
    [settings.mode]
  );

  // ── Session management ────────────────────────────────

  /** Load a previous session's messages and reconnect */
  const loadSession = useCallback(
    async (targetSessionId: string) => {
      // Disconnect current
      abortRef.current?.abort();
      wsRef.current?.close();
      wsRef.current = null;
      setIsConnected(false);

      // Load messages
      const loaded = await loadChatHistory(targetSessionId);
      setMessages(loaded as Message[]);
      setSessionId(targetSessionId);
      // Update ref immediately so connect() uses the new sessionId
      sessionIdRef.current = targetSessionId;
      setIsStreaming(false);

      // Reconnect — connect() reads sessionIdRef.current
      setTimeout(() => connect(), 50);
    },
    [serverUrl, connect]
  );

  /** Start a new empty session */
  const newSession = useCallback(() => {
    // Disconnect current
    abortRef.current?.abort();
    wsRef.current?.close();
    wsRef.current = null;

    // Clear state
    setMessages([]);
    setSessionId(null);
    setIsStreaming(false);
  }, []);

  // ── Reset session when project changes ───────────────
  // When the user switches projects, disconnect and start a new session
  // so the server creates the workspace for the new project.
  useEffect(() => {
    if (!projectId) return;
    abortRef.current?.abort();
    wsRef.current?.close();
    wsRef.current = null;
    setMessages([]);
    setSessionId(null);
    sessionIdRef.current = null;
    setIsStreaming(false);
    setIsConnected(false);
  }, [projectId]);

  // ── Cleanup ───────────────────────────────────────────
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      wsRef.current?.close();
    };
  }, []);

  /** Send a request to delete a project's workspace directory on the server */
  const deleteProjectWorkspace = useCallback((pid: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "delete-project-workspace", projectId: pid }));
  }, []);

  return {
    messages,
    setMessages,
    isConnected,
    isStreaming,
    streamingPhase,
    currentToolName,
    sessionId,
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
    deleteProjectWorkspace,
  };
}
