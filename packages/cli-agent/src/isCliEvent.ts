// CliEvent 的运行时守卫:库消费者在边界(如 IPC/持久化)校验事件用;
// 本库测试也用它替代原先对 pocket-code wire zod schema 的依赖。
import type { CliEvent } from "./types.js";

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isNonNegInt(v: unknown): boolean {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

export function isCliEvent(v: unknown): v is CliEvent {
  if (!isObj(v) || typeof v.type !== "string") return false;
  switch (v.type) {
    case "text-delta":
    case "reasoning-delta":
      return typeof v.text === "string";
    case "tool-call":
      return typeof v.callId === "string" && typeof v.name === "string" && isObj(v.args);
    case "tool-result":
      return typeof v.callId === "string" && (v.isError === undefined || typeof v.isError === "boolean");
    case "file-changed":
      return typeof v.path === "string" && (v.changeType === "created" || v.changeType === "modified" || v.changeType === "deleted");
    case "usage":
      return isNonNegInt(v.inputTokens) && isNonNegInt(v.outputTokens);
    case "done":
      return true;
    case "error":
      return typeof v.message === "string" && (v.code === undefined || typeof v.code === "string");
    default:
      return false;
  }
}
