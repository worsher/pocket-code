import { describe, it, expect } from "vitest";
import { AgentEvent } from "@pocket-code/wire";
import { mapAiSdkPart } from "./aiSdkEvents.js";

describe("mapAiSdkPart", () => {
  it("maps text-delta / reasoning", () => {
    expect(mapAiSdkPart({ type: "text-delta", textDelta: "hi" })).toEqual([
      { type: "text-delta", text: "hi" },
    ]);
    expect(mapAiSdkPart({ type: "reasoning", textDelta: "think" })).toEqual([
      { type: "reasoning-delta", text: "think" },
    ]);
  });

  it("maps tool-call with callId", () => {
    const evs = mapAiSdkPart({
      type: "tool-call", toolCallId: "tc1", toolName: "readFile", args: { path: "a.ts" },
    });
    expect(evs).toEqual([
      { type: "tool-call", callId: "tc1", name: "readFile", args: { path: "a.ts" } },
    ]);
  });

  it("maps tool-result and derives file-changed for writeFile/editFile success", () => {
    const evs = mapAiSdkPart({
      type: "tool-result", toolCallId: "tc2", toolName: "writeFile",
      result: { success: true, path: "src/a.ts", isNew: true },
    });
    expect(evs[0]).toEqual({
      type: "tool-result", callId: "tc2", result: { success: true, path: "src/a.ts", isNew: true },
    });
    expect(evs[1]).toEqual({ type: "file-changed", path: "src/a.ts", changeType: "created" });
    // editFile 非新建 → modified
    const evs2 = mapAiSdkPart({
      type: "tool-result", toolCallId: "tc3", toolName: "editFile",
      result: { success: true, path: "src/b.ts" },
    });
    expect(evs2[1]).toEqual({ type: "file-changed", path: "src/b.ts", changeType: "modified" });
    // 失败/非文件工具 → 不派生
    expect(mapAiSdkPart({ type: "tool-result", toolCallId: "t", toolName: "writeFile", result: { success: false } })).toHaveLength(1);
    expect(mapAiSdkPart({ type: "tool-result", toolCallId: "t", toolName: "runCommand", result: { success: true } })).toHaveLength(1);
  });

  it("maps error and ignores unknown part types", () => {
    expect(mapAiSdkPart({ type: "error", error: new Error("boom") })).toEqual([
      { type: "error", message: "Error: boom" },
    ]);
    expect(mapAiSdkPart({ type: "step-start" })).toEqual([]);
  });

  it("every produced event passes wire AgentEvent.safeParse", () => {
    const all = [
      ...mapAiSdkPart({ type: "text-delta", textDelta: "x" }),
      ...mapAiSdkPart({ type: "tool-call", toolCallId: "c", toolName: "n", args: {} }),
      ...mapAiSdkPart({ type: "tool-result", toolCallId: "c", toolName: "writeFile", result: { success: true, path: "p" } }),
      ...mapAiSdkPart({ type: "error", error: "e" }),
    ];
    for (const ev of all) expect(AgentEvent.safeParse(ev).success).toBe(true);
  });
});
