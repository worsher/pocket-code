import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { runCliSession, cliAdapters } from "./index.js";

function makeFakeProc() {
  const proc: any = new EventEmitter();
  proc.pid = 4242;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { end: vi.fn() };
  proc.kill = vi.fn();
  proc.pushLine = (obj: unknown) => proc.stdout.emit("data", Buffer.from(JSON.stringify(obj) + "\n"));
  proc.finish = (code = 0) => proc.emit("close", code);
  return proc;
}

describe("cliAdapters registry", () => {
  it("contains all three adapters", () => {
    expect(Object.keys(cliAdapters).sort()).toEqual(["claude-code", "codex", "gemini-cli"]);
  });
});

describe("runCliSession", () => {
  it("runs the adapter and pushes assistant full text into session.messages", async () => {
    const session: any = { workspace: "/ws", customPrompt: undefined, messages: [] };
    const proc = makeFakeProc();
    const events: any[] = [];
    const p = runCliSession(cliAdapters["codex"], session, "hi", (e) => events.push(e), undefined, () => proc);
    proc.pushLine({ type: "item.completed", item: { id: "i1", type: "agent_message", text: "done!" } });
    proc.finish(0);
    await p;
    expect(session.messages).toEqual([{ role: "assistant", content: "done!" }]);
    expect(events.map((e: any) => e.type)).toContain("text-delta");
  });

  it("pushes a placeholder when CLI produced no text", async () => {
    const session: any = { workspace: "/ws", messages: [] };
    const proc = makeFakeProc();
    const p = runCliSession(cliAdapters["codex"], session, "hi", () => {}, undefined, () => proc);
    proc.finish(0);
    await p;
    expect(session.messages[0].content).toBe("(codex completed)");
  });

  it("runs the gemini-cli adapter and pushes assistant full text (parity with old appendText accumulation path)", async () => {
    const session: any = { workspace: "/ws", customPrompt: undefined, messages: [] };
    const proc = makeFakeProc();
    const events: any[] = [];
    const p = runCliSession(cliAdapters["gemini-cli"], session, "hi", (e) => events.push(e), undefined, () => proc);
    proc.pushLine({ type: "message", role: "assistant", content: "hello from gemini" });
    proc.finish(0);
    await p;
    expect(session.messages).toEqual([{ role: "assistant", content: "hello from gemini" }]);
    expect(events.map((e: any) => e.type)).toContain("text-delta");
  });
});
