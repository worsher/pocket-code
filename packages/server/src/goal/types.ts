// ── P16:Goal 状态机(spec §7,契约 C16-1~8)─────────────────
// goal 是 runtime 持有的结构化状态,不是聊天文本。active 是唯一自动续跑态;
// complete 为瞬时态(driver 发 completion 事件后立即清除,不持久化);
// 无 cancelled 态——取消即清除。状态只经 updateGoalStatus 工具、goal-control
// 消息、系统停车规则(错误/中断/预算/防空转/重启降级)变更(C16-1)。

import type { AgentEventType } from "@pocket-code/wire";
import type { ToolDef } from "@pocket-code/agent-core";

export interface GoalState {
  goal: string;
  acceptance?: string;
  status: "active" | "paused" | "blocked" | "complete";
  stopReason?: string;
  stats: { turns: number; inputTokens: number; outputTokens: number; startedAt: number };
  budgets: { maxTurns: number };
  createdAt: number;
  updatedAt: number;
}

const DEFAULT_MAX_TURNS = 20;

export function createGoal(content: string, acceptance?: string, maxTurns?: number): GoalState {
  const now = Date.now();
  return {
    goal: content,
    ...(acceptance ? { acceptance } : {}),
    status: "active",
    stats: { turns: 0, inputTokens: 0, outputTokens: 0, startedAt: now },
    budgets: { maxTurns: maxTurns ?? DEFAULT_MAX_TURNS },
    createdAt: now,
    updatedAt: now,
  };
}

/** goal 状态变更事件(lifecycle/completion)。 */
export function goalUpdatedEvent(g: GoalState, change: "lifecycle" | "completion"): AgentEventType {
  return {
    type: "goal-updated",
    status: g.status,
    change,
    ...(g.stopReason ? { stopReason: g.stopReason } : {}),
    goal: g.goal,
    stats: { turns: g.stats.turns, inputTokens: g.stats.inputTokens, outputTokens: g.stats.outputTokens },
    maxTurns: g.budgets.maxTurns,
  };
}

/** cancel 的终局事件(此后 goal 已清除,D-P16-5)。 */
export function clearedEvent(stats: GoalState["stats"]): AgentEventType {
  return {
    type: "goal-updated",
    status: "paused",
    change: "cleared",
    stats: { turns: stats.turns, inputTokens: stats.inputTokens, outputTokens: stats.outputTokens },
  };
}

/**
 * goal turn 注入的状态收束工具(C16-1/7:仅 goal turn 挂载;模型改 goal 状态的
 * 唯一通道)。execute 闭包捕获 session,直接改 session.goal(不经 backend)。
 */
export function makeUpdateGoalStatusTool(session: { goal?: GoalState }): ToolDef {
  return {
    schema: {
      name: "updateGoalStatus",
      description:
        "标记当前目标的状态(complete=全部完成且已验证 / blocked=真实受阻 / paused=暂时停放)。标记后请继续用普通文本向用户简短总结。",
      parameters: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["complete", "blocked", "paused"] },
          reason: { type: "string", description: "blocked/paused 时说明原因与所需输入" },
        },
        required: ["status"],
      },
    },
    async execute(_backend, args) {
      const status = args.status;
      if (status !== "complete" && status !== "blocked" && status !== "paused") {
        return { success: false, error: `无效状态: ${String(status)}` };
      }
      const goal = session.goal;
      if (!goal) return { success: false, error: "当前没有活动目标" };
      goal.status = status;
      goal.stopReason = typeof args.reason === "string" ? args.reason : undefined;
      goal.updatedAt = Date.now();
      return { success: true, status, note: "状态已记录,请继续输出总结" };
    },
  };
}
