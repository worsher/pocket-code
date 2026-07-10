import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebAgentStore } from "./webAgentStore";
import type { WebSettings } from "./webStorage";

class FakeWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.CLOSED;
  sent: string[] = [];
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: () => void;
  onerror?: () => void;
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {}
  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
  receive(obj: unknown) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
}

const SETTINGS: WebSettings = {
  mode: "lan",
  serverUrl: "ws://localhost:8787",
  relayUrl: "",
  relayMachineId: "",
  deviceId: "web_test",
};

describe("WebAgentStore", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("streams a full turn: send → text-delta → tool-call/result → done", () => {
    const store = new WebAgentStore(SETTINGS);
    const seen: string[] = [];
    store.subscribe(() => seen.push(store.getState().phase));
    store.connect();
    const ws = FakeWebSocket.instances[0];
    ws.open();
    expect(store.getState().connected).toBe(true);

    store.sendMessage("改一下 README");
    const outbound = JSON.parse(ws.sent.at(-1)!);
    expect(outbound).toMatchObject({ type: "message", content: "改一下 README" });
    expect(store.getState().messages).toHaveLength(2); // user + pending assistant

    ws.receive({ type: "text-delta", text: "好的" });
    ws.receive({ type: "tool-call", callId: "c1", name: "writeFile", args: { path: "README.md" } });
    ws.receive({ type: "tool-result", callId: "c1", result: { success: true, newContent: "x" } });
    ws.receive({ type: "done" });

    const state = store.getState();
    const assistant = state.messages.at(-1)!;
    expect(assistant.content).toBe("好的");
    expect(assistant.toolCalls).toHaveLength(1);
    expect(assistant.toolCalls![0].result).toMatchObject({ success: true });
    expect(state.phase).toBe("idle");
    expect(seen).toContain("generating");
  });

  it("captures sessionId and surfaces auth errors", () => {
    const store = new WebAgentStore(SETTINGS);
    store.connect();
    const ws = FakeWebSocket.instances[0];
    ws.open();
    ws.receive({ type: "session", sessionId: "s_1" });
    expect(store.getState().sessionId).toBe("s_1");
    ws.receive({ type: "error", error: "Unauthorized device" });
    expect(store.getState().authError).toContain("重新配对");
  });
});
