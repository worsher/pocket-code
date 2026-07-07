// ToolRegistry:组装各类工具(文件类/exec 类...)并提供统一 run(name,args) 派发。
// 未知工具与工具内部异常均归一为 {success:false, error} 结构(App 侧渲染依赖此形状)。
import type { RuntimeBackend, ToolSchema } from "../types.js";
import { buildFileTools } from "./fileTools.js";
import { buildExecTools, buildProcessTools } from "./execTools.js";

export interface ToolDef {
  schema: ToolSchema;
  execute(backend: RuntimeBackend, args: Record<string, unknown>): Promise<unknown>;
}

export interface ToolRegistry {
  schemas: ToolSchema[];
  run(name: string, args: Record<string, unknown>): Promise<unknown>;
  has(name: string): boolean;
}

export function buildToolRegistry(backend: RuntimeBackend, workspace: string): ToolRegistry {
  const tools = new Map<string, ToolDef>();
  for (const def of buildFileTools(workspace)) {
    tools.set(def.schema.name, def);
  }
  for (const def of buildExecTools(workspace)) {
    tools.set(def.schema.name, def);
  }
  // 能力门控:runInBackground/stopProcess 仅当 backend 提供 startProcess/stopProcess 时才注册。
  for (const def of buildProcessTools(backend)) {
    tools.set(def.schema.name, def);
  }

  return {
    get schemas(): ToolSchema[] {
      return Array.from(tools.values()).map((t) => t.schema);
    },
    has(name: string): boolean {
      return tools.has(name);
    },
    async run(name: string, args: Record<string, unknown>): Promise<unknown> {
      const def = tools.get(name);
      if (!def) {
        return { success: false, error: `Unknown tool: ${name}` };
      }
      try {
        return await def.execute(backend, args);
      } catch (err) {
        // 归一化落网:多数工具已自带 try/catch,但 runCommandTool(execTools.ts)不自带——
        // App geek 本地路径 native 模块缺失等场景会同步/异步裸抛,若不在此兜底,异常将穿透
        // registry 直达 runAgentLoop 并 reject 整轮循环,而不是把 {success:false} 喂回模型
        // 让其继续(兑现头注释"工具内部异常均归一为 {success:false,error}"的契约)。
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
