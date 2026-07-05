// ── WS 隧道枢纽(relay 侧,P7 HMR) ─────────────────────────────
// 关联浏览器侧 WebSocket 与 tunnelId:daemon 回帧写给浏览器,浏览器
// 消息发给 daemon。归属校验与掉线清理沿用 P6a 的 TunnelHub 模式。

import type { WebSocket } from "ws";

const MAX_PREOPEN_BUFFER = 64;

/** ws.close() 只接受合法关闭码;帧里的原始码在调用前夹紧。 */
function clampCloseCode(code?: number): number {
  if (code === 1000 || code === 1001 || code === 1011 || (code !== undefined && code >= 3000 && code <= 4999)) {
    return code;
  }
  return 1000;
}

interface WsTunnel {
  browserWs: WebSocket;
  machineId: string;
  opened: boolean;
  /** daemon 确认 opened 前,浏览器消息先缓冲 */
  buffer: Array<Record<string, unknown>>;
}

export class WsTunnelHub {
  private tunnels = new Map<string, WsTunnel>();

  constructor(
    private sendToDaemon: (machineId: string, frame: unknown) => boolean
  ) {}

  open(tunnelId: string, browserWs: WebSocket, machineId: string): void {
    const t: WsTunnel = { browserWs, machineId, opened: false, buffer: [] };
    this.tunnels.set(tunnelId, t);

    browserWs.on("message", (data: Buffer, isBinary: boolean) => {
      const frame = isBinary
        ? { type: "tunnel-ws-data", tunnelId, data: data.toString("base64"), binary: true }
        : { type: "tunnel-ws-data", tunnelId, data: data.toString("utf-8") };
      if (!t.opened) {
        if (t.buffer.length >= MAX_PREOPEN_BUFFER) {
          console.warn(`[Relay] WS tunnel ${tunnelId} pre-open buffer overflow, closing`);
          this.tunnels.delete(tunnelId);
          try { browserWs.close(1011, "tunnel buffer overflow"); } catch { /* ignore */ }
          return;
        }
        t.buffer.push(frame);
      } else {
        this.sendToDaemon(t.machineId, frame);
      }
    });

    browserWs.on("close", (code: number, reason: Buffer) => {
      // onClose 主动关闭时已删条目 → 不再回发,防回环
      if (this.tunnels.delete(tunnelId)) {
        this.sendToDaemon(t.machineId, {
          type: "tunnel-ws-close",
          tunnelId,
          code,
          reason: reason.toString("utf-8").slice(0, 512) || undefined,
        });
      }
    });
  }

  /** 归属校验:sender 传入且不符 → 丢弃(P6a 语义)。 */
  private owned(tunnelId: string, senderMachineId?: string): WsTunnel | undefined {
    const t = this.tunnels.get(tunnelId);
    if (!t) return undefined;
    if (senderMachineId !== undefined && t.machineId !== senderMachineId) {
      console.warn(`[Relay] Dropped ws-tunnel frame for ${tunnelId} from non-owner ${senderMachineId}`);
      return undefined;
    }
    return t;
  }

  onOpened(tunnelId: string, senderMachineId?: string): void {
    const t = this.owned(tunnelId, senderMachineId);
    if (!t || t.opened) return;
    t.opened = true;
    for (const frame of t.buffer.splice(0)) {
      this.sendToDaemon(t.machineId, frame);
    }
  }

  onData(tunnelId: string, data: string, binary?: boolean, senderMachineId?: string): void {
    const t = this.owned(tunnelId, senderMachineId);
    if (!t) return;
    try {
      t.browserWs.send(binary ? Buffer.from(data, "base64") : data);
    } catch { /* 浏览器侧已断,close 事件会做清理 */ }
  }

  onClose(tunnelId: string, code?: number, reason?: string, senderMachineId?: string): void {
    const t = this.owned(tunnelId, senderMachineId);
    if (!t) return;
    this.tunnels.delete(tunnelId); // 先删,浏览器 close 事件不再回发
    try {
      t.browserWs.close(clampCloseCode(code), reason?.slice(0, 120));
    } catch { /* ignore */ }
  }

  /** daemon 掉线:关闭该机全部 WS 隧道。 */
  abortByMachine(machineId: string, reason = "daemon offline"): void {
    for (const [id, t] of this.tunnels) {
      if (t.machineId === machineId) {
        this.tunnels.delete(id);
        try { t.browserWs.close(1001, reason); } catch { /* ignore */ }
      }
    }
  }

  get size(): number {
    return this.tunnels.size;
  }
}
