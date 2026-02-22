// ── Smart Model Router ──────────────────────────────────
// Analyzes prompt complexity to auto-select the best model.
// Rule-based + heuristic, no extra AI call.

import type { CoreMessage } from "ai";

export type ComplexityLevel = "simple" | "medium" | "complex" | "reasoning";

interface RoutingRule {
  complexity: ComplexityLevel;
  modelKey: string;
  description: string;
}

const DEFAULT_ROUTING: RoutingRule[] = [
  { complexity: "simple", modelKey: "deepseek-v3", description: "简单问答、文件操作" },
  { complexity: "medium", modelKey: "deepseek-v3", description: "一般编码任务" },
  { complexity: "complex", modelKey: "claude-sonnet", description: "复杂架构、重构" },
  { complexity: "reasoning", modelKey: "deepseek-r1", description: "数学推理、算法" },
];

export interface PromptAnalysis {
  complexity: ComplexityLevel;
  confidence: number;
  reason: string;
  suggestedModel: string;
}

// ── Pattern sets ──────────────────────────────────────────

const SIMPLE_PATTERNS = [
  /^(hi|hello|你好|hey|嗨)/i,
  /^(what|how|explain|解释|什么是|告诉我)/i,
  /^git\s+(status|log|branch|pull|push|add|commit)/i,
  /^(ls|cat|list|read|show|查看|看看)/i,
  /^(run|execute|npm|yarn|pnpm|运行|执行)\s/i,
  /帮我(提交|推送|拉取|安装|查看|列出)/,
  /^(install|安装)\s/i,
];

const REASONING_PATTERNS = [
  /算法|algorithm|优化复杂度|time\s+complexity|空间复杂度/i,
  /数学|mathematical|证明|prove|推导/i,
  /为什么.*不.*工作|why.*not.*work|debug.*complex/i,
  /设计模式|design\s+pattern|架构.*方案/i,
  /分析.*性能|performance.*analy|性能优化/i,
  /递归|动态规划|dynamic\s+programming|二叉树|图论/i,
  /比较.*方案|权衡|trade.?off/i,
];

const COMPLEX_PATTERNS = [
  /重构|refactor|rewrite|重写/i,
  /从零.*创建|create.*from\s+scratch|搭建.*项目/i,
  /全栈|full.?stack|前后端/i,
  /微服务|microservice|分布式/i,
  /整个.*项目|entire.*project|完整.*应用/i,
  /迁移|migrate|升级.*框架/i,
  /系统设计|system\s+design/i,
];

export function analyzePrompt(
  userMessage: string,
  conversationHistory: CoreMessage[],
  hasImages?: boolean
): PromptAnalysis {
  // If the message contains images, always choose a multimodal model
  if (hasImages) {
    return {
      complexity: "complex",
      confidence: 0.9,
      reason: "Message contains images — requires multimodal model",
      suggestedModel: "claude-sonnet",
    };
  }
  const msg = userMessage.toLowerCase();
  const wordCount = userMessage.split(/\s+/).length;
  const charCount = userMessage.length;
  const codeBlockCount = (userMessage.match(/```/g) || []).length / 2;
  const historyLength = conversationHistory.length;

  // 1. Simple task detection
  if (SIMPLE_PATTERNS.some((p) => p.test(userMessage)) && wordCount < 30) {
    return {
      complexity: "simple",
      confidence: 0.85,
      reason: "Simple task pattern match",
      suggestedModel: getModelForComplexity("simple"),
    };
  }

  // 2. Reasoning task detection
  if (REASONING_PATTERNS.some((p) => p.test(userMessage))) {
    return {
      complexity: "reasoning",
      confidence: 0.75,
      reason: "Reasoning/algorithm pattern match",
      suggestedModel: getModelForComplexity("reasoning"),
    };
  }

  // 3. Complex task detection
  const hasLargeCodeBlock = codeBlockCount > 0 && charCount > 500;
  const isLongPrompt = wordCount > 100;
  const isDeepConversation = historyLength > 20;

  if (
    COMPLEX_PATTERNS.some((p) => p.test(userMessage)) ||
    hasLargeCodeBlock ||
    (isLongPrompt && isDeepConversation)
  ) {
    return {
      complexity: "complex",
      confidence: 0.65,
      reason: "Complex task pattern match",
      suggestedModel: getModelForComplexity("complex"),
    };
  }

  // 4. Default: medium
  return {
    complexity: "medium",
    confidence: 0.5,
    reason: "Default classification",
    suggestedModel: getModelForComplexity("medium"),
  };
}

function getModelForComplexity(complexity: ComplexityLevel): string {
  const rule = DEFAULT_ROUTING.find((r) => r.complexity === complexity);
  return rule?.modelKey || "deepseek-v3";
}
