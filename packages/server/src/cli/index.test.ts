import { beforeEach, describe, expect, it, vi } from "vitest";

// 单次静态 vi.mock(顶层,被 Vitest hoist 到 import 之前),避免每个 it 重复
// vi.doMock + 动态 import 同一 specifier 触发的模块缓存/mock 注册竞态
// (实测:每个 it 内 doMock+import("./index.js") 会间歇性地让 runCliSession
//  拿到未 mock 的真实 runner.js,导致 "adapter.buildSpawn is not a function"
//  —— 这是伪造的 mock adapter 对象缺少 buildSpawn 属性所致,不是被测代码的 bug)。
// 用一个 it 间可重赋值的 mockRunCliAgent 实现被测试逐个替换,规避重复 mock 注册。
const mockRunCliAgent = vi.fn();
vi.mock("./runner.js", () => ({
  runCliAgent: (...args: unknown[]) => mockRunCliAgent(...args),
}));

// 静态 import 在文件顶层即可安全使用(vi.mock 已被 hoist,故此处拿到的是 mock 版)。
import { runCliSession } from "./index.js";

describe("runCliSession 历史注入与 resume", () => {
  beforeEach(() => {
    mockRunCliAgent.mockReset();
  });

  it("supportsResume:false 且有历史 → userMessage 前缀含 Recent conversation,resumeSessionId 恒 undefined", async () => {
    const captured: { msg?: string; ctx?: any } = {};
    mockRunCliAgent.mockImplementation(async (_a: any, msg: string, ctx: any) => {
      captured.msg = msg;
      captured.ctx = ctx;
      return { fullText: "ok" };
    });
    const session: any = {
      workspace: "/ws",
      messages: [
        { role: "user", content: "prev q" },
        { role: "assistant", content: "prev a" },
        { role: "user", content: "new q" }, // 本轮已被 agent.ts push(在 runCliSession 调用之前)
      ],
    };
    await runCliSession({ id: "codex", supportsResume: false } as any, session, "new q", () => {});
    expect(captured.msg).toContain("## Recent conversation");
    expect(captured.msg).toContain("prev q");
    expect(captured.msg).toContain("prev a");
    // 本轮 user("new q")必须被排除出历史区块,只应出现在 "## Current request" 之后一次。
    expect(captured.msg?.split("new q").length).toBe(2);
    expect(captured.msg).toContain("## Current request\nnew q");
    expect(captured.ctx.resumeSessionId).toBeUndefined();
  });

  it("无历史(messages 只有本轮 user)→ 不注入,原样透传 userMessage", async () => {
    const captured: { msg?: string } = {};
    mockRunCliAgent.mockImplementation(async (_a: any, msg: string) => {
      captured.msg = msg;
      return { fullText: "ok" };
    });
    const session: any = { workspace: "/ws", messages: [{ role: "user", content: "only turn" }] };
    await runCliSession({ id: "codex", supportsResume: false } as any, session, "only turn", () => {});
    expect(captured.msg).toBe("only turn");
  });

  it("supportsResume:true → 不注历史,透传原始 userMessage,带上既存 resumeSessionId,回写 cliSessions", async () => {
    const captured: { msg?: string; ctx?: any } = {};
    mockRunCliAgent.mockImplementation(async (_a: any, msg: string, ctx: any) => {
      captured.msg = msg;
      captured.ctx = ctx;
      return { fullText: "ok", cliSessionId: "sess_new" };
    });
    const session: any = {
      workspace: "/ws",
      messages: [
        { role: "user", content: "prev q" },
        { role: "assistant", content: "prev a" },
        { role: "user", content: "q" },
      ],
      cliSessions: { "claude-code": "sess_old" },
    };
    await runCliSession({ id: "claude-code", supportsResume: true } as any, session, "q", () => {});
    expect(captured.msg).toBe("q"); // 未走 injectHistory
    expect(captured.ctx.resumeSessionId).toBe("sess_old"); // 携带上一轮捕获的 id
    expect(session.cliSessions["claude-code"]).toBe("sess_new"); // 回写新 id
  });

  it("supportsResume:true 且无既存 cliSessions → resumeSessionId undefined,首次成功后建立 cliSessions", async () => {
    mockRunCliAgent.mockImplementation(async () => ({ fullText: "ok", cliSessionId: "sess_first" }));
    const session: any = { workspace: "/ws", messages: [{ role: "user", content: "q" }] };
    await runCliSession({ id: "claude-code", supportsResume: true } as any, session, "q", () => {});
    expect(session.cliSessions).toEqual({ "claude-code": "sess_first" });
  });

  it("cliSessionId 未捕获(undefined)时不覆盖既存 cliSessions", async () => {
    mockRunCliAgent.mockImplementation(async () => ({ fullText: "ok" })); // 无 cliSessionId
    const session: any = {
      workspace: "/ws",
      messages: [{ role: "user", content: "q" }],
      cliSessions: { "claude-code": "sess_keep" },
    };
    await runCliSession({ id: "claude-code", supportsResume: true } as any, session, "q", () => {});
    expect(session.cliSessions["claude-code"]).toBe("sess_keep");
  });
});
