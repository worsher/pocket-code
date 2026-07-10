// ── Relay Connection ──────────────────────────────────────
// WebSocket client that connects to the Relay server,
// registers the daemon, maintains heartbeat, and handles reconnection.

import { WebSocket } from "ws";
import crypto from "crypto";
import type { DaemonInboundType } from "@pocket-code/protocol-core";
import { parseRelayMessage } from "./inbound.js";

export interface ConnectionOptions {
  relayUrl: string;
  machineId: string;
  machineName: string;
  /** 与 relay 共享的注册密钥(必填,启动时已校验) */
  relaySecret: string;
  onMessage: (msg: DaemonInboundType) => void;
  onConnected: () => void;
  onDisconnected: () => void;
}

const HEARTBEAT_INTERVAL_MS = 20 * 1000;
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 30000;

export class RelayConnection {
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private stopped = false;

  constructor(private opts: ConnectionOptions) {}

  /** Start the connection (and auto-reconnect) */
  connect(): void {
    this.stopped = false;
    this.doConnect();
  }

  /** Send a JSON message to the relay */
  send(data: unknown): boolean {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
      return true;
    }
    return false;
  }

  /** Gracefully disconnect and stop reconnecting */
  disconnect(): void {
    this.stopped = true;
    this.clearTimers();
    if (this.ws) {
      this.ws.close(1000, "Daemon shutting down");
      this.ws = null;
    }
  }

  private doConnect(): void {
    if (this.stopped) return;

    console.log(`[Tunnel] Connecting to relay: ${this.opts.relayUrl}`);

    try {
      this.ws = new WebSocket(this.opts.relayUrl);
    } catch (err: any) {
      console.error(`[Tunnel] Failed to create WebSocket: ${err.message}`);
      this.scheduleReconnect();
      return;
    }

    this.ws.on("open", () => {
      console.log("[Tunnel] Connected to relay");
      this.reconnectAttempt = 0;

      // Register with the relay (HMAC computed with the shared relay secret)
      const timestamp = Date.now();
      const hmac = crypto
        .createHmac("sha256", this.opts.relaySecret)
        .update(this.opts.machineId + timestamp)
        .digest("hex");
      this.send({
        type: "daemon-register",
        machineId: this.opts.machineId,
        machineName: this.opts.machineName,
        authToken: hmac,
        timestamp,
      });

      // Start heartbeat
      this.heartbeatTimer = setInterval(() => {
        this.send({
          type: "daemon-heartbeat",
          machineId: this.opts.machineId,
          timestamp: Date.now(),
        });
      }, HEARTBEAT_INTERVAL_MS);

      this.opts.onConnected();
    });

    this.ws.on("message", (raw: Buffer) => {
      const msg = parseRelayMessage(raw.toString());
      if (msg) this.opts.onMessage(msg);
    });

    this.ws.on("close", (code: number, reason: Buffer) => {
      console.log(
        `[Tunnel] Disconnected from relay (code: ${code}, reason: ${reason.toString()})`
      );
      this.clearTimers();
      this.opts.onDisconnected();
      this.scheduleReconnect();
    });

    this.ws.on("error", (err: Error) => {
      console.error("[Tunnel] WebSocket error:", err.message);
      // 'close' event will fire after 'error', which handles reconnection
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;

    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempt),
      RECONNECT_MAX_MS
    );
    this.reconnectAttempt++;

    console.log(
      `[Tunnel] Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${this.reconnectAttempt})`
    );

    this.reconnectTimer = setTimeout(() => {
      this.doConnect();
    }, delay);
  }

  private clearTimers(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
