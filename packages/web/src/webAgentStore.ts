// ── Web 端 agent 编排(框架无关,对应 App useAgent 的最小子集) ──
// 砍掉 RN 专属:AppState/通知/离线队列/geek 模式/会话存档。

import {
  ServerConnection,
  applyAgentEvent,
  phaseFor,
  type ConnectionConfig,
  type ConnectionHandlers,
  type Message,
  type StreamingPhase,
} from "@pocket-code/client-core";
import type { WebSettings } from "./webStorage";

export interface AgentState {
  messages: Message[];
  phase: StreamingPhase;
  connected: boolean;
  authError: string | null;
  sessionId: string | null;
}

export class WebAgentStore {
  private state: AgentState = {
    messages: [],
    phase: "idle",
    connected: false,
    authError: null,
    sessionId: null,
  };
  private listeners = new Set<() => void>();
  readonly conn: ServerConnection;

  constructor(private settings: WebSettings) {
    const config: ConnectionConfig = {
      getServerUrl: () => (settings.mode === "relay" ? settings.relayUrl : settings.serverUrl),
      isRelayMode: () => settings.mode === "relay",
      getRelayOptions: () => ({
        machineId: settings.relayMachineId,
        deviceId: settings.deviceId,
        token: settings.relayToken,
      }),
      getAuthToken: () => undefined, // LAN 模式走 register 流程
      getDeviceId: () => settings.deviceId,
      buildInitPayload: () => ({ sessionId: this.state.sessionId ?? undefined }),
      isRelayPaired: () => !!(settings.relayToken && settings.relayMachineId),
    };
    const handlers: ConnectionHandlers = {
      onAgentEvent: (ev) => {
        const messages = applyAgentEvent(this.state.messages, ev);
        const phase = phaseFor(ev) ?? this.state.phase;
        this.setState({ messages, phase });
      },
      onAuth: () => {}, // LAN 匿名注册返回的 token 由 ServerConnection 自己回发 init
      onSession: (sessionId) => this.setState({ sessionId }),
      onConnected: () => this.setState({ connected: true, authError: null }),
      onDisconnected: () => this.setState({ connected: false }),
      onAuthError: (message) => this.setState({ authError: message }),
      onFileChanged: () => {}, // Files 页手动刷新,MVP 不做推送联动
    };
    this.conn = new ServerConnection(config, handlers);
  }

  getState(): AgentState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  connect(): void {
    this.conn.connect();
  }

  disconnect(): void {
    this.conn.disconnect();
  }

  sendMessage(content: string): void {
    const now = Date.now();
    const user: Message = { id: `u_${now}`, role: "user", content, timestamp: now };
    const pending: Message = { id: `a_${now}`, role: "assistant", content: "", timestamp: now, pending: true };
    this.setState({
      messages: [...this.state.messages, user, pending],
      phase: "connecting",
    });
    this.conn.sendRaw({ type: "message", content });
  }

  private setState(patch: Partial<AgentState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }
}
