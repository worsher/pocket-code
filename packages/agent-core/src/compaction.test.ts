import { describe, it, expect, vi } from "vitest";
import { compactHistory, COMPACT_PREFIX } from "./compaction.js";
import { estimateTokens } from "./tokens.js";
import type { CoreMessage, ModelClient, ModelDelta } from "./types.js";

/** 固定摘要文本的 fake client;记录收到的请求。 */
function summaryClient(summary = "这是摘要:早期完成了 X,改了 a.ts。") {
  const calls: any[] = [];
  const client: ModelClient & { calls: any[] } = {
    calls,
    async *streamStep(req) {
      calls.push(req);
      yield { type: "text", text: summary } as ModelDelta;
    },
  };
  return client;
}

/** n 个完整 user turn 的史:每 turn = user + assistant(toolCalls) + tool + assistant 纯文本。 */
function mkHistory(nTurns: number, opts: { withImages?: boolean; padding?: number } = {}): CoreMessage[] {
  const pad = "x".repeat(opts.padding ?? 2000);
  const out: CoreMessage[] = [];
  for (let i = 0; i < nTurns; i++) {
    out.push(
      opts.withImages
        ? { role: "user", content: [{ type: "text", text: `请求${i} ${pad}` }, { type: "image", base64: `IMG${i}`, mimeType: "image/png" }] }
        : { role: "user", content: `请求${i} ${pad}` }
    );
    out.push({ role: "assistant", content: `想法${i}`, toolCalls: [{ id: `c${i}`, name: "readFile", args: { path: `f${i}.ts` } }] });
    out.push({ role: "tool", toolCallId: `c${i}`, toolName: "readFile", content: `内容${i} ${pad}` });
    out.push({ role: "assistant", content: `答复${i}` });
  }
  return out;
}

describe("compactHistory", () => {
  it("① below threshold → same reference, no result (C15-3)", async () => {
    const history = mkHistory(3, { padding: 10 });
    const client = summaryClient();
    const r = await compactHistory({ history, modelClient: client });
    expect(r.history).toBe(history);
    expect(r.result).toBeUndefined();
    expect(client.calls.length).toBe(0);
  });

  it("② above threshold → [summary user] + last keepRecentTurns turns verbatim (C15-2)", async () => {
    const history = mkHistory(6);
    const r = await compactHistory({ history, modelClient: summaryClient(), thresholdTokens: 1000, keepRecentTurns: 2 });
    expect(r.result).toBeDefined();
    const compacted = r.history;
    // 首条为摘要 user 消息,COMPACT_PREFIX 开头,无 toolCalls
    expect(compacted[0].role).toBe("user");
    expect((compacted[0] as any).content.startsWith(COMPACT_PREFIX)).toBe(true);
    expect((compacted[0] as any).toolCalls).toBeUndefined();
    // 保留段 = 原史最后 2 个 turn(每 turn 4 条)逐字
    expect(compacted.slice(1)).toEqual(history.slice(4 * 4));
    expect(r.result!.compactedMessages).toBe(4 * 4);
    expect(r.result!.keptRecentTurns).toBe(2);
  });

  it("③ kept segment preserves toolCall pairing (C15-2)", async () => {
    const history = mkHistory(5);
    const r = await compactHistory({ history, modelClient: summaryClient(), thresholdTokens: 1000, keepRecentTurns: 2 });
    const kept = r.history.slice(1);
    for (const m of kept) {
      if (m.role === "assistant" && m.toolCalls) {
        for (const tc of m.toolCalls) {
          expect(kept.some((t) => t.role === "tool" && (t as any).toolCallId === tc.id)).toBe(true);
        }
      }
    }
  });

  it("④ user turns ≤ keepRecentTurns → no-op even above threshold", async () => {
    const history = mkHistory(2, { padding: 200000 });
    const r = await compactHistory({ history, modelClient: summaryClient(), thresholdTokens: 1000, keepRecentTurns: 2 });
    expect(r.history).toBe(history);
    expect(r.result).toBeUndefined();
  });

  it("⑤ summary failure / empty summary → original history, no result (C15-4)", async () => {
    const history = mkHistory(6);
    const throwing: ModelClient = {
      async *streamStep(): AsyncIterable<ModelDelta> {
        throw new Error("provider down");
      },
    };
    const r1 = await compactHistory({ history, modelClient: throwing, thresholdTokens: 1000 });
    expect(r1.history).toBe(history);
    expect(r1.result).toBeUndefined();

    const r2 = await compactHistory({ history, modelClient: summaryClient("   "), thresholdTokens: 1000 });
    expect(r2.history).toBe(history);
    expect(r2.result).toBeUndefined();
  });

  it("⑥ tokensAfter < tokensBefore and matches estimate (C15-5)", async () => {
    const history = mkHistory(6);
    const r = await compactHistory({ history, modelClient: summaryClient(), thresholdTokens: 1000 });
    expect(r.result!.tokensAfter).toBeLessThan(r.result!.tokensBefore);
    expect(r.result!.tokensBefore).toBe(estimateTokens(history));
    expect(r.result!.tokensAfter).toBe(estimateTokens(r.history));
  });

  it("⑦ summarizer receives serialized text: single user message, no image parts, tool results truncated (D-P15-1)", async () => {
    const history = mkHistory(6, { withImages: true, padding: 3000 });
    const client = summaryClient();
    await compactHistory({ history, modelClient: client, thresholdTokens: 1000 });
    expect(client.calls.length).toBe(1);
    const req = client.calls[0];
    expect(req.tools).toEqual([]);
    expect(req.messages.length).toBe(1);
    expect(req.messages[0].role).toBe("user");
    const text = req.messages[0].content as string;
    expect(typeof text).toBe("string");
    expect(text).toContain("[图片]");
    expect(text).not.toContain("IMG0"); // base64 不进摘要请求
    // tool 结果截 500:序列化里不含完整 3000 字符 padding 的 tool 内容
    expect(text).toContain("tool(readFile):");
  });

  it("⑧ pre-aborted signal → skip compaction", async () => {
    const history = mkHistory(6);
    const ac = new AbortController();
    ac.abort();
    const client = summaryClient();
    const r = await compactHistory({ history, modelClient: client, thresholdTokens: 1000, signal: ac.signal });
    expect(r.history).toBe(history);
    expect(r.result).toBeUndefined();
  });
});
