// 文件类工具:行为等价迁移自 packages/server/src/tools.ts(readFile/writeFile/editFile/listFiles/searchFiles)。
// core 包零依赖:不直接碰 fs/child_process,而是经由 RuntimeBackend 抽象(Node/浏览器后端各自实现)。
import { safePath } from "../safePath.js";
import type { RuntimeBackend, ToolSchema } from "../types.js";
import type { ToolDef } from "./registry.js";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 组装文件类工具;workspace 供 safePath 使用(与 backend 无关,由调用方——registry——注入)。 */
export function buildFileTools(workspace: string): ToolDef[] {
  const readFileSchema: ToolSchema = {
    name: "readFile",
    description:
      "Read the contents of a file at the given path (relative to workspace root)",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative file path" },
      },
      required: ["path"],
    },
  };

  const readFileTool: ToolDef = {
    schema: readFileSchema,
    async execute(backend: RuntimeBackend, args: Record<string, unknown>) {
      const path = args.path as string;
      try {
        const fullPath = safePath(workspace, path);
        const content = await backend.readFile(fullPath);
        return { success: true, content };
      } catch (err) {
        return { success: false, error: errorMessage(err) };
      }
    },
  };

  const writeFileSchema: ToolSchema = {
    name: "writeFile",
    description:
      "Write content to a file at the given path (relative to workspace root). Creates parent directories if needed.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative file path" },
        content: { type: "string", description: "File content to write" },
      },
      required: ["path", "content"],
    },
  };

  const writeFileTool: ToolDef = {
    schema: writeFileSchema,
    async execute(backend: RuntimeBackend, args: Record<string, unknown>) {
      const path = args.path as string;
      const content = args.content as string;
      try {
        const fullPath = safePath(workspace, path);
        const { isNew } = await backend.writeFile(fullPath, content);
        return { success: true, path, isNew };
      } catch (err) {
        return { success: false, error: errorMessage(err) };
      }
    },
  };

  const editFileSchema: ToolSchema = {
    name: "editFile",
    description:
      "Edit a file by replacing a specific text string with new content. More precise than writeFile for modifying existing files — only the matched portion is changed. The oldText must match exactly (including whitespace and indentation).",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative file path" },
        oldText: {
          type: "string",
          description:
            "The exact text to find and replace. Must match the file content exactly.",
        },
        newText: { type: "string", description: "The replacement text" },
      },
      required: ["path", "oldText", "newText"],
    },
  };

  const editFileTool: ToolDef = {
    schema: editFileSchema,
    async execute(backend: RuntimeBackend, args: Record<string, unknown>) {
      const path = args.path as string;
      const oldText = args.oldText as string;
      const newText = args.newText as string;
      try {
        const fullPath = safePath(workspace, path);
        const content = await backend.readFile(fullPath);

        const index = content.indexOf(oldText);
        if (index === -1) {
          return {
            success: false,
            error:
              "oldText not found in the file. Make sure it matches exactly including whitespace.",
          };
        }

        const secondIndex = content.indexOf(oldText, index + oldText.length);
        if (secondIndex !== -1) {
          return {
            success: false,
            error:
              "oldText found multiple times in the file. Provide a more specific (longer) oldText to match uniquely.",
          };
        }

        const newContent =
          content.slice(0, index) + newText + content.slice(index + oldText.length);

        await backend.writeFile(fullPath, newContent);

        return { success: true, path, isNew: false, replaced: 1 };
      } catch (err) {
        return { success: false, error: errorMessage(err) };
      }
    },
  };

  const listFilesSchema: ToolSchema = {
    name: "listFiles",
    description:
      "List files and directories at the given path (relative to workspace root)",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          default: ".",
          description: "Relative directory path, defaults to workspace root",
        },
      },
      required: [],
    },
  };

  const listFilesTool: ToolDef = {
    schema: listFilesSchema,
    async execute(backend: RuntimeBackend, args: Record<string, unknown>) {
      const path = (args.path as string | undefined) ?? ".";
      try {
        const fullPath = safePath(workspace, path);
        const items = await backend.listFiles(fullPath);
        return { success: true, items };
      } catch (err) {
        return { success: false, error: errorMessage(err) };
      }
    },
  };

  const searchFilesSchema: ToolSchema = {
    name: "searchFiles",
    description:
      "Search for a text pattern across files in the workspace using grep. Returns matching lines with file paths and line numbers. Use this to find code, functions, imports, or any text patterns.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Search pattern (text or regex)" },
        path: {
          type: "string",
          default: ".",
          description: "Directory to search in (relative to workspace root)",
        },
        include: {
          type: "string",
          description: "File glob pattern to include, e.g. '*.ts' or '*.py'",
        },
        ignoreCase: {
          type: "boolean",
          default: false,
          description: "Whether to ignore case",
        },
        isRegex: {
          type: "boolean",
          default: false,
          description: "Whether the pattern is a regex",
        },
      },
      required: ["pattern"],
    },
  };

  const searchFilesTool: ToolDef = {
    schema: searchFilesSchema,
    async execute(backend: RuntimeBackend, args: Record<string, unknown>) {
      const pattern = args.pattern as string;
      const path = (args.path as string | undefined) ?? ".";
      const include = args.include as string | undefined;
      const ignoreCase = (args.ignoreCase as boolean | undefined) ?? false;
      const isRegex = (args.isRegex as boolean | undefined) ?? false;

      try {
        // 旧版命令构造照迁(grep -rn --include=... -e <pattern>);core 侧统一用 -e 传参
        // (避免 -F/-E 与 pattern 转义细节耦合),配合 exec 输出 2000 字符截断(替代旧版 shell head -50)。
        const flags = [
          "-rn", // recursive + line numbers
          "--color=never",
          ignoreCase ? "-i" : "",
          isRegex ? "-E" : "",
        ]
          .filter(Boolean)
          .join(" ");

        const includeFlag = include ? `--include=${JSON.stringify(include)}` : "";
        const safePattern = JSON.stringify(pattern);

        const searchPath = path === "." ? workspace : safePath(workspace, path);

        const cmd = `grep ${flags} ${includeFlag} -e ${safePattern} ${JSON.stringify(searchPath)}`.replace(/\s+/g, " ").trim();

        const { stdout } = await backend.exec(cmd, { cwd: workspace, timeoutMs: 15000 });

        const truncatedStdout = stdout.slice(0, 2000);

        const matches = truncatedStdout
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            // Format: filepath:lineNumber:content
            const firstColon = line.indexOf(":");
            const secondColon = line.indexOf(":", firstColon + 1);
            if (firstColon === -1 || secondColon === -1) {
              return { file: "", line: 0, content: line };
            }
            let file = line.slice(0, firstColon);
            const wsPrefix = workspace + "/";
            if (file.startsWith(wsPrefix)) {
              file = file.slice(wsPrefix.length);
            }
            return {
              file,
              line: parseInt(line.slice(firstColon + 1, secondColon), 10) || 0,
              content: line.slice(secondColon + 1).trim(),
            };
          });

        return { success: true, matches };
      } catch (err) {
        return { success: false, error: errorMessage(err) };
      }
    },
  };

  return [readFileTool, writeFileTool, editFileTool, listFilesTool, searchFilesTool];
}
