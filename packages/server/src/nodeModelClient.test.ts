import { describe, it, expect } from "vitest";
import { tool, jsonSchema } from "ai";
import { createNodeModelClient } from "./nodeModelClient.js";
import type { CoreMessage, ToolSchema, ModelDelta } from "@pocket-code/agent-core";

/** 造一个假的 streamTextImpl:记录调用参数,返回可控 fullStream + usage promise。 */
function fakeStreamText(opts: {
  parts: any[];
  usage?: Promise<any>;
}) {
  const calls: any[] = [];
  const impl = (args: any) => {
    calls.push(args);
    return {
      fullStream: (async function* () {
        for (const p of opts.parts) yield p;
      })(),
      usage: opts.usage ?? Promise.resolve({ promptTokens: 1, completionTokens: 2 }),
    };
  };
  return { impl, calls };
}

describe("createNodeModelClient", () => {
  it("passes tools without execute and maxSteps===1 to streamTextImpl", async () => {
    const { impl, calls } = fakeStreamText({ parts: [] });
    const client = createNodeModelClient("claude-sonnet", impl as any);
    const tools: ToolSchema[] = [
      { name: "readFile", description: "read a file", parameters: { type: "object", properties: { path: { type: "string" } } } },
      { name: "writeFile", description: "write a file", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } } },
    ];

    const iter = client.streamStep({ system: "sys", messages: [], tools });
    for await (const _ of iter) {
      // drain
    }

    expect(calls).toHaveLength(1);
    const passedArgs = calls[0];
    expect(passedArgs.maxSteps).toBe(1);
    const toolValues = Object.values(passedArgs.tools);
    expect(toolValues.length).toBe(2);
    for (const t of toolValues as any[]) {
      expect(t.execute).toBeUndefined();
    }
  });

  it("maps fullStream parts (text-delta, tool-call) to ModelDelta sequence", async () => {
    const { impl } = fakeStreamText({
      parts: [
        { type: "text-delta", textDelta: "hel" },
        { type: "text-delta", textDelta: "lo" },
        { type: "tool-call", toolCallId: "c1", toolName: "readFile", args: { path: "a.ts" } },
      ],
      usage: Promise.resolve(undefined),
    });
    const client = createNodeModelClient("claude-sonnet", impl as any);

    const deltas: ModelDelta[] = [];
    for await (const d of client.streamStep({ system: "sys", messages: [], tools: [] })) {
      deltas.push(d);
    }

    expect(deltas).toEqual([
      { type: "text", text: "hel" },
      { type: "text", text: "lo" },
      { type: "tool-call", id: "c1", name: "readFile", args: { path: "a.ts" } },
    ]);
  });

  it("maps reasoning parts and throws on error part", async () => {
    const { impl } = fakeStreamText({
      parts: [
        { type: "reasoning", textDelta: "thinking" },
        { type: "error", error: new Error("boom") },
      ],
    });
    const client = createNodeModelClient("claude-sonnet", impl as any);

    const deltas: ModelDelta[] = [];
    await expect(async () => {
      for await (const d of client.streamStep({ system: "sys", messages: [], tools: [] })) {
        deltas.push(d);
      }
    }).rejects.toThrow();
    expect(deltas).toEqual([{ type: "reasoning", text: "thinking" }]);
  });

  it("converts CoreMessage tool round trip to AI SDK message shape (tool-result part, JSON.parse'd result)", async () => {
    const { impl, calls } = fakeStreamText({ parts: [] });
    const client = createNodeModelClient("claude-sonnet", impl as any);

    const messages: CoreMessage[] = [
      {
        role: "assistant",
        content: "let me check",
        toolCalls: [{ id: "c1", name: "readFile", args: { path: "a.ts" } }],
      },
      {
        role: "tool",
        toolCallId: "c1",
        toolName: "readFile",
        content: JSON.stringify({ success: true, content: "hi" }),
      },
      {
        role: "tool",
        toolCallId: "c2",
        toolName: "runCommand",
        content: "not json at all",
      },
    ];

    for await (const _ of client.streamStep({ system: "sys", messages, tools: [] })) {
      // drain
    }

    const passedArgs = calls[0];
    const assistantMsg = passedArgs.messages[0];
    expect(assistantMsg.role).toBe("assistant");
    expect(assistantMsg.content).toEqual([
      { type: "text", text: "let me check" },
      { type: "tool-call", toolCallId: "c1", toolName: "readFile", args: { path: "a.ts" } },
    ]);

    const toolMsg1 = passedArgs.messages[1];
    expect(toolMsg1.role).toBe("tool");
    expect(toolMsg1.content).toEqual([
      {
        type: "tool-result",
        toolCallId: "c1",
        toolName: "readFile",
        result: { success: true, content: "hi" },
      },
    ]);

    const toolMsg2 = passedArgs.messages[2];
    expect(toolMsg2.content).toEqual([
      {
        type: "tool-result",
        toolCallId: "c2",
        toolName: "runCommand",
        result: "not json at all",
      },
    ]);
  });

  it("converts user ContentPart image to AI SDK image part", async () => {
    const { impl, calls } = fakeStreamText({ parts: [] });
    const client = createNodeModelClient("claude-sonnet", impl as any);

    const messages: CoreMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image", base64: "AAAA", mimeType: "image/png" },
        ],
      },
    ];

    for await (const _ of client.streamStep({ system: "sys", messages, tools: [] })) {
      // drain
    }

    const userMsg = calls[0].messages[0];
    expect(userMsg.content).toEqual([
      { type: "text", text: "look" },
      { type: "image", image: "AAAA", mimeType: "image/png" },
    ]);
  });

  it("emits usage delta after stream ends when usage promise resolves", async () => {
    const { impl } = fakeStreamText({
      parts: [{ type: "text-delta", textDelta: "hi" }],
      usage: Promise.resolve({ promptTokens: 10, completionTokens: 20 }),
    });
    const client = createNodeModelClient("claude-sonnet", impl as any);

    const deltas: ModelDelta[] = [];
    for await (const d of client.streamStep({ system: "sys", messages: [], tools: [] })) {
      deltas.push(d);
    }

    expect(deltas).toEqual([
      { type: "text", text: "hi" },
      { type: "usage", inputTokens: 10, outputTokens: 20 },
    ]);
  });

  it("does not emit or throw when usage promise rejects", async () => {
    const { impl } = fakeStreamText({
      parts: [{ type: "text-delta", textDelta: "hi" }],
      usage: Promise.reject(new Error("no usage")),
    });
    const client = createNodeModelClient("claude-sonnet", impl as any);

    const deltas: ModelDelta[] = [];
    for await (const d of client.streamStep({ system: "sys", messages: [], tools: [] })) {
      deltas.push(d);
    }

    expect(deltas).toEqual([{ type: "text", text: "hi" }]);
  });

  it("real AI SDK assertion: tool() with no execute does not throw (client-side tool def allowed)", () => {
    expect(() =>
      tool({
        description: "a tool with no execute",
        parameters: jsonSchema({ type: "object", properties: { path: { type: "string" } } }),
      })
    ).not.toThrow();
  });
});
