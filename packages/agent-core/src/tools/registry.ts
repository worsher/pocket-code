// ToolRegistry:组装各类工具(文件类/exec 类...)并提供统一 run(name,args) 派发。
// 未知工具与工具内部异常均归一为 {success:false, error} 结构(App 侧渲染依赖此形状)。
import type { RuntimeBackend, ToolSchema } from "../types.js";
import { buildFileTools } from "./fileTools.js";

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
  // T3 后:execTools(runCommand/git*)在此追加注册;startProcess/stopProcess 仅当 backend 提供对应方法时注册。

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
      return def.execute(backend, args);
    },
  };
}
