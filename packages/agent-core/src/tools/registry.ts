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
      return def.execute(backend, args);
    },
  };
}
