// ── P16:goal driver(spec §7.1,契约 C16-2/4/5;D-P16-4 防空转)──
// 把一个 active goal 推进成连续的普通 turn:每轮读 P12 的 stopReason 与
// goal 状态决定续跑/停车。goal turn 就是普通 runAgent turn——事件经 P14 的
// publish 带 seq 可补发;P13 重试在 loop 内自愈,driver 只见最终 stopReason;
// P15 压缩在每个 turn 的 runAgent 内自动生效。

import {
  goalKickoffPrompt,
  GOAL_CONTINUATION_PROMPT,
  type LoopStopReason,
} from "@pocket-code/agent-core";
import type { AgentEventType } from "@pocket-code/wire";
import type { AgentSession } from "../agent.js";
import { goalUpdatedEvent, type GoalState } from "./types.js";

export interface TurnOutcome {
  stopReason: LoopStopReason;
  usage: { inputTokens: number; outputTokens: number };
}

export interface GoalDriverDeps {
  runAgent: (
    session: AgentSession,
    content: string,
    onEvent: (ev: AgentEventType) => void,
    signal?: AbortSignal
  ) => Promise<TurnOutcome | undefined>;
  persistGoal: (sessionId: string, goalJsonOwner: GoalState | null) => void;
  publish: (ev: AgentEventType) => void;
}

const MAX_IDLE_TURNS = 3;

/**
 * 前置:session.goal 存在且 active。返回时 goal 已停在终态(paused/blocked)
 * 或被清除(complete/cancel),事件已发、已持久化。
 */
export async function runGoalDriver(session: AgentSession, deps: GoalDriverDeps): Promise<void> {
  const { sessionId } = session;
  const transportTurnId = session.goal?.transportTurnId;
  let idleTurns = 0;

  // One goal command can span many agent turns, but it remains one rendered
  // transport turn. Override producer metadata so every delta/tool/done and
  // lifecycle event is routed to the same assistant projection.
  const publish = (event: AgentEventType): void => {
    deps.publish(transportTurnId ? { ...event, turnId: transportTurnId } : event);
  };

  const park = (g: GoalState, status: "paused" | "blocked", reason: string): void => {
    g.status = status;
    g.stopReason = reason;
    g.updatedAt = Date.now();
    deps.persistGoal(sessionId, g);
    publish(goalUpdatedEvent(g, "lifecycle"));
  };

  while (session.goal?.status === "active") {
    const g = session.goal;

    if (g.stats.turns >= g.budgets.maxTurns) {
      park(g, "blocked", `已达轮数预算(${g.budgets.maxTurns} 轮)`); // C16-2
      break;
    }
    g.stats.turns++;

    const content = g.stats.turns === 1 ? goalKickoffPrompt(g) : GOAL_CONTINUATION_PROMPT;
    const before = g.updatedAt;
    const abort = new AbortController();
    session.currentAbort = abort;
    session.currentAbortOwner = "goal";
    let outcome: TurnOutcome | undefined;
    try {
      outcome = await deps.runAgent(session, content, publish, abort.signal);
    } finally {
      if (session.currentAbort === abort) {
        session.currentAbort = undefined;
        session.currentAbortOwner = undefined;
      }
    }

    if (outcome) {
      g.stats.inputTokens += outcome.usage.inputTokens;
      g.stats.outputTokens += outcome.usage.outputTokens;
    }

    // turn 中被 cancel(goal-control 清除):静默退出,cleared 事件由 control 分支发
    if (!session.goal) break;
    const cur = session.goal;

    if (cur.status === "complete") {
      // C16-4:恰一条 completion,随后 goal 清除(complete 是瞬时态,不持久化)
      publish(goalUpdatedEvent(cur, "completion"));
      session.goal = undefined;
      deps.persistGoal(sessionId, null);
      break;
    }
    if (cur.status === "paused" || cur.status === "blocked") {
      // 工具或 goal-control 已置态:driver 只补通告(单一事件源在此)
      deps.persistGoal(sessionId, cur);
      publish(goalUpdatedEvent(cur, "lifecycle"));
      break;
    }

    if (!outcome || outcome.stopReason === "error") {
      park(cur, "paused", "技术错误,已暂停"); // C16-5 错误停车
      break;
    }
    if (outcome.stopReason === "aborted") {
      park(cur, "paused", "用户中断");
      break;
    }
    if (outcome.stopReason === "end_turn" && cur.updatedAt === before) {
      // D-P16-4:end_turn 且未经工具更新状态 = 空转轮;max_steps 不计(在干活)
      if (++idleTurns >= MAX_IDLE_TURNS) {
        park(cur, "blocked", "连续多轮无进展(防空转)");
        break;
      }
    } else {
      idleTurns = 0;
    }
    // max_steps → 直接续跑(P12 组合点:自动"继续")
    deps.persistGoal(sessionId, cur);
  }
}
