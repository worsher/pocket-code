import { updateSettings } from "../store/settings";

// Define local events so useAgent can listen to them
export type RelayEvent =
  | { type: "open" }
  | { type: "close"; code: number; reason: string }
  | { type: "error"; error: Error }
  | { type: "message"; data: string }; // The unwrapped inner payload

export interface RelayClientOptions {
  relayUrl: string;
  machineId: string;
  deviceId: string;
  deviceName: string;
  /** Long-lived device JWT */
  token?: string;
}

/**
 * A wrapper around WebSocket that transparently handles the Relay Envelope protocol.
 * To the consumer (useAgent.ts), this looks just like a normal WebSocket connection
 * directly to the Daemon.
 */
export class RelayClient {
  private ws: WebSocket | null = null;
  private pendingRequests = new Map<string, { resolve: (val: any) => void; reject: (err: any) => void }>();
  
  public onopen?: () => void;
  public onmessage?: (event: { data: string }) => void;
  public onclose?: (event: { code: number; reason: string }) => void;
  public onerror?: (event: { message: string }) => void;

  /** True if the underlying socket is open */
  public get readyState() {
    return this.ws ? this.ws.readyState : WebSocket.CLOSED;
  }

  constructor(private opts: RelayClientOptions) {}

  /** Connect to the VPS Relay Server */
  public connect() {
    console.log(`[RelayClient] Connecting to relay: ${this.opts.relayUrl}`);
    this.ws = new WebSocket(this.opts.relayUrl);

    this.ws.onopen = () => {
      console.log("[RelayClient] WebSocket connected");
      this.onopen?.();
    };

    this.ws.onmessage = (event) => {
      try {
        const raw = JSON.parse(event.data);

        switch (raw.type) {
          // Inner business message passed through the envelope
          case "relay-response":
          case "relay-stream": {
            // Unpack and emit as though it was a direct message
            this.onmessage?.({ data: JSON.stringify(raw.payload) });
            break;
          }

          // Pairing flow messages
          case "pair-response": {
            const req = this.pendingRequests.get("pairing");
            if (req) {
              req.resolve(raw);
              this.pendingRequests.delete("pairing");
            }
            break;
          }

          case "machines-list": {
            const req = this.pendingRequests.get("machines");
            if (req) {
              req.resolve(raw.machines);
              this.pendingRequests.delete("machines");
            }
            break;
          }

          case "error": {
            console.error("[RelayClient] Relay level error:", raw.error);
            this.onerror?.({ message: raw.error });
            break;
          }
        }
      } catch (err) {
        console.error("[RelayClient] Message parse error:", err);
      }
    };

    this.ws.onclose = (event) => {
      console.log(`[RelayClient] Closed. Code=${event.code}`);
      this.onclose?.({ code: event.code, reason: event.reason });
    };

    this.ws.onerror = (event) => {
      console.error("[RelayClient] Error.");
      this.onerror?.({ message: "Network error" });
    };
  }

  public close() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  /**
   * Transparently wrap the business message in a RelayEnvelope and send it.
   */
  public send(data: string) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn("[RelayClient] Cannot send: socket not open");
      return;
    }

    if (!this.opts.token || !this.opts.machineId) {
      console.error("[RelayClient] Cannot send: missing token or machineId. Must pair first.");
      return;
    }

    try {
      const payload = JSON.parse(data);
      
      // Use the requestId from the payload if it has one (like tool-exec),
      // otherwise generate a transient one for tracking.
      const requestId = payload.callId || payload._reqId || `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      const envelope = {
        type: "relay-request",
        token: this.opts.token,
        machineId: this.opts.machineId,
        requestId,
        payload,
      };

      this.ws.send(JSON.stringify(envelope));
    } catch (err) {
      console.error("[RelayClient] Failed to prepare envelope:", err);
    }
  }

  // ── Specific Protocol Commands ──────────────────────────────────────────

  /** Fetch online machines from relay */
  public getOnlineMachines(): Promise<Array<any>> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return reject(new Error("Socket not open"));
      }

      this.pendingRequests.set("machines", { resolve, reject });
      
      // Timeout
      setTimeout(() => {
        if (this.pendingRequests.has("machines")) {
          this.pendingRequests.delete("machines");
          reject(new Error("Timeout fetching machines list"));
        }
      }, 5000);

      this.ws.send(JSON.stringify({ type: "list-machines" }));
    });
  }

  /** Initiate pairing flow */
  public pairDevice(pairingCode: string, targetMachineId?: string): Promise<{ success: boolean; token?: string; error?: string; machineId?: string; machineName?: string }> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return reject(new Error("Socket not open"));
      }

      this.pendingRequests.set("pairing", { resolve, reject });

      // Timeout
      setTimeout(() => {
        if (this.pendingRequests.has("pairing")) {
          this.pendingRequests.delete("pairing");
          reject(new Error("Pairing request timed out. Make sure the daemon is online."));
        }
      }, 10000);

      this.ws.send(JSON.stringify({
        type: "pair-request",
        pairingCode,
        deviceId: this.opts.deviceId,
        deviceName: this.opts.deviceName,
        machineId: targetMachineId,
      }));
    });
  }

  /** Update current connection token (called after successful pair) */
  public updateToken(token: string, machineId: string) {
    this.opts.token = token;
    this.opts.machineId = machineId;
    
    // Fire and forget persist
    updateSettings({
      relayToken: token,
      relayMachineId: machineId
    });
  }
}
