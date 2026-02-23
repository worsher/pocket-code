// ── AI Client ──────────────────────────────────────────
// Direct AI API caller for geek mode.
// Uses XMLHttpRequest for SSE streaming (React Native doesn't support
// fetch ReadableStream / response.body.getReader()).

import { type ModelConfig } from "./modelConfig";
import type { AppSettings } from "../store/settings";

// ── Types ──────────────────────────────────────────────

/** Content part for multi-modal messages (images) */
export type ContentPart =
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string } }        // OpenAI format
    | { type: "image"; source: { type: "base64"; media_type: string; data: string } }; // Anthropic format

export interface ChatMessage {
    role: "system" | "user" | "assistant" | "tool";
    content: string | ContentPart[];
    tool_calls?: ToolCallRequest[];
    tool_call_id?: string;
}

export interface ToolCallRequest {
    id: string;
    type: "function";
    function: {
        name: string;
        arguments: string; // JSON string
    };
}

export interface ToolDefinition {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
    };
}

export interface StreamCallbacks {
    onTextDelta: (text: string) => void;
    onThinking?: (text: string) => void;
    onToolCall: (id: string, name: string, args: Record<string, unknown>) => void;
    onDone: () => void;
    onError: (error: string) => void;
}

// ── Tool definitions for AI (matches server tools.ts) ──

export const TOOL_DEFINITIONS: ToolDefinition[] = [
    {
        type: "function",
        function: {
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
        },
    },
    {
        type: "function",
        function: {
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
        },
    },
    {
        type: "function",
        function: {
            name: "listFiles",
            description:
                "List files and directories at the given path (relative to workspace root)",
            parameters: {
                type: "object",
                properties: {
                    path: {
                        type: "string",
                        description:
                            "Relative directory path, defaults to workspace root",
                        default: ".",
                    },
                },
                required: [],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "runCommand",
            description:
                "Execute a shell command in the workspace directory. Use for npm, git, build tools, etc.",
            parameters: {
                type: "object",
                properties: {
                    command: {
                        type: "string",
                        description: "The shell command to execute",
                    },
                },
                required: ["command"],
            },
        },
    },
    // ── Git tools ──
    {
        type: "function",
        function: {
            name: "gitClone",
            description: "Clone a git repository into the workspace. Creates a subdirectory named after the repo.",
            parameters: {
                type: "object",
                properties: {
                    url: { type: "string", description: "Repository URL (HTTPS)" },
                    dir: { type: "string", description: "Target directory name (optional, defaults to repo name)" },
                },
                required: ["url"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "gitStatus",
            description: "Show the working tree status — lists changed, staged, and untracked files. You MUST set 'path' to the repo directory name (e.g. the directory created by gitClone).",
            parameters: {
                type: "object",
                properties: {
                    path: { type: "string", description: "Subdirectory within workspace (optional, defaults to workspace root)" },
                },
                required: [],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "gitAdd",
            description: "Stage files for commit. Use filepath '.' to stage all changes. You MUST set 'path' to the repo directory name.",
            parameters: {
                type: "object",
                properties: {
                    filepath: { type: "string", description: "File path to stage, or '.' for all" },
                    path: { type: "string", description: "Repository subdirectory (optional)" },
                },
                required: ["filepath"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "gitCommit",
            description: "Commit staged changes with a message. You MUST set 'path' to the repo directory name.",
            parameters: {
                type: "object",
                properties: {
                    message: { type: "string", description: "Commit message" },
                    path: { type: "string", description: "Repository subdirectory (optional)" },
                },
                required: ["message"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "gitPush",
            description: "Push commits to the remote repository. Requires git credentials configured in settings. You MUST set 'path' to the repo directory name.",
            parameters: {
                type: "object",
                properties: {
                    remote: { type: "string", description: "Remote name (default: origin)" },
                    branch: { type: "string", description: "Branch name (optional)" },
                    path: { type: "string", description: "Repository subdirectory (optional)" },
                },
                required: [],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "gitPull",
            description: "Pull updates from the remote repository. You MUST set 'path' to the repo directory name.",
            parameters: {
                type: "object",
                properties: {
                    remote: { type: "string", description: "Remote name (default: origin)" },
                    branch: { type: "string", description: "Branch name (optional)" },
                    path: { type: "string", description: "Repository subdirectory (optional)" },
                },
                required: [],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "gitLog",
            description: "Show recent commit history. You MUST set 'path' to the repo directory name.",
            parameters: {
                type: "object",
                properties: {
                    depth: { type: "number", description: "Number of commits to show (default: 10)" },
                    path: { type: "string", description: "Repository subdirectory (optional)" },
                },
                required: [],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "gitBranch",
            description: "List branches (no name param) or create a new branch (with name param). You MUST set 'path' to the repo directory name.",
            parameters: {
                type: "object",
                properties: {
                    name: { type: "string", description: "New branch name (omit to list branches)" },
                    path: { type: "string", description: "Repository subdirectory (optional)" },
                },
                required: [],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "gitCheckout",
            description: "Switch to a different branch or commit. You MUST set 'path' to the repo directory name.",
            parameters: {
                type: "object",
                properties: {
                    ref: { type: "string", description: "Branch name or commit SHA to checkout" },
                    path: { type: "string", description: "Repository subdirectory (optional)" },
                },
                required: ["ref"],
            },
        },
    },
];

// ── System prompt ──────────────────────────────────────

function buildSystemPrompt(settings?: AppSettings, customPrompt?: string): string {
    const isLocal = settings?.workspaceMode === "local";
    const configuredGit = settings?.gitCredentials?.filter((c) => c.token) || [];

    let prompt = `You are Pocket Code, an AI coding assistant running on a mobile device. You help developers write, debug, and manage code through natural conversation.

You have access to a workspace directory where you can read/write files and perform git operations. Use the tools provided to help the user.

Available tool categories:
- File operations: readFile, writeFile, listFiles
- Git: gitClone, gitStatus, gitAdd, gitCommit, gitPush, gitPull, gitLog, gitBranch, gitCheckout`;

    if (isLocal) {
        prompt += `\n- Shell: runCommand is NOT available in local mode. You MUST use the dedicated git tools (gitClone, gitCommit, etc.) for all git operations.`;
    } else {
        prompt += `\n- Shell: runCommand (execute shell commands in the workspace)`;
    }

    if (configuredGit.length > 0) {
        const platforms = configuredGit.map((c) => `${c.platform} (${c.host})`).join(", ");
        prompt += `\n\nGit authentication configured for: ${platforms}. You can directly clone, push, and pull repositories from these platforms — authentication is handled automatically.`;
    }

    prompt += `\n\nGuidelines:
- Be concise in your responses (mobile screen is small)
- When modifying files, always read them first to understand the context
- After making changes, verify by reading the file or running relevant commands
- Use markdown for code blocks with language tags
- When executing commands, explain what you're doing briefly
- If a command fails, try to diagnose and fix the issue
- ALWAYS use the dedicated git tools (gitClone, gitCommit, etc.) instead of runCommand for git operations
- IMPORTANT: The workspace root is NOT a git repository. When you clone a repo (e.g. gitClone with url "https://gitee.com/user/my-repo"), it creates a subdirectory (e.g. "my-repo"). All subsequent git operations (gitStatus, gitAdd, gitCommit, gitPush, etc.) MUST pass the repo directory name as the "path" parameter (e.g. path: "my-repo").`;

    if (customPrompt?.trim()) {
        prompt += `\n\n## Project Instructions\n${customPrompt.trim()}`;
    }

    return prompt;
}

// ── SSE parser helper ──────────────────────────────────

function parseSSELines(
    text: string,
    lastIndex: number
): { lines: string[]; newIndex: number } {
    const newText = text.substring(lastIndex);
    const parts = newText.split("\n");
    // If the text doesn't end with newline, the last part is incomplete
    const hasTrailing = newText.endsWith("\n");
    const lines = hasTrailing ? parts.slice(0, -1) : parts.slice(0, -1);
    const consumed = hasTrailing
        ? lastIndex + newText.length
        : lastIndex + newText.length - (parts[parts.length - 1]?.length || 0);
    return { lines, newIndex: consumed };
}

// ── OpenAI-compatible streaming via XHR ────────────────

export function streamChatOpenAI(params: {
    baseURL: string;
    apiKey: string;
    modelId: string;
    messages: ChatMessage[];
    callbacks: StreamCallbacks;
    signal?: AbortSignal;
    systemPrompt: string;
}): Promise<void> {
    const { baseURL, apiKey, modelId, messages, callbacks, signal, systemPrompt } = params;

    return new Promise<void>((resolve) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", `${baseURL}/chat/completions`);
        xhr.setRequestHeader("Content-Type", "application/json");
        xhr.setRequestHeader("Authorization", `Bearer ${apiKey}`);
        // Enable incremental response for React Native
        xhr.setRequestHeader("Accept", "text/event-stream");

        let lastIndex = 0;
        let settled = false;
        let insideThink = false;
        const toolCallAccum: Record<
            number,
            { id: string; name: string; arguments: string }
        > = {};

        const finish = () => {
            if (settled) return;
            settled = true;
            resolve();
        };

        // Abort support
        if (signal) {
            signal.addEventListener("abort", () => {
                xhr.abort();
                finish();
            });
        }

        xhr.onreadystatechange = () => {
            // readyState 3 = LOADING (partial data available)
            if (xhr.readyState < 3) return;

            try {
                const { lines, newIndex } = parseSSELines(xhr.responseText, lastIndex);
                lastIndex = newIndex;

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed || !trimmed.startsWith("data: ")) continue;
                    const data = trimmed.slice(6);

                    if (data === "[DONE]") {
                        // Flush remaining tool calls
                        flushToolCalls(toolCallAccum, callbacks);
                        callbacks.onDone();
                        finish();
                        return;
                    }

                    try {
                        const json = JSON.parse(data);
                        const delta = json.choices?.[0]?.delta;
                        if (!delta) continue;

                        // Reasoning content (DeepSeek R1 native)
                        if (delta.reasoning_content && callbacks.onThinking) {
                            callbacks.onThinking(delta.reasoning_content);
                        }

                        // Text content — parse <think> tags for models that use them
                        if (delta.content) {
                            let content = delta.content as string;
                            if (callbacks.onThinking) {
                                // Handle <think> open tag
                                if (!insideThink && content.includes("<think>")) {
                                    insideThink = true;
                                    const idx = content.indexOf("<think>");
                                    const before = content.slice(0, idx);
                                    if (before) callbacks.onTextDelta(before);
                                    const after = content.slice(idx + 7);
                                    if (after) callbacks.onThinking(after);
                                    content = "";
                                }
                                // Handle </think> close tag
                                if (insideThink && content.includes("</think>")) {
                                    insideThink = false;
                                    const idx = content.indexOf("</think>");
                                    const before = content.slice(0, idx);
                                    if (before) callbacks.onThinking(before);
                                    const after = content.slice(idx + 8);
                                    if (after) callbacks.onTextDelta(after);
                                    content = "";
                                }
                                // Inside think block
                                if (insideThink && content) {
                                    callbacks.onThinking(content);
                                    content = "";
                                }
                            }
                            if (content) {
                                callbacks.onTextDelta(content);
                            }
                        }

                        // Tool calls (may arrive across multiple deltas)
                        if (delta.tool_calls) {
                            for (const tc of delta.tool_calls) {
                                const idx = tc.index ?? 0;
                                if (!toolCallAccum[idx]) {
                                    toolCallAccum[idx] = { id: "", name: "", arguments: "" };
                                }
                                if (tc.id) toolCallAccum[idx].id = tc.id;
                                if (tc.function?.name)
                                    toolCallAccum[idx].name = tc.function.name;
                                if (tc.function?.arguments)
                                    toolCallAccum[idx].arguments += tc.function.arguments;
                            }
                        }

                        // On finish_reason, flush tool calls
                        const finishReason = json.choices?.[0]?.finish_reason;
                        if (finishReason === "tool_calls" || finishReason === "stop") {
                            flushToolCalls(toolCallAccum, callbacks);
                        }
                    } catch {
                        // Skip malformed JSON
                    }
                }
            } catch {
                // Ignore partial-read errors
            }

            // readyState 4 = DONE
            if (xhr.readyState === 4) {
                if (xhr.status !== 200 && !settled) {
                    callbacks.onError(`API error ${xhr.status}: ${xhr.responseText.slice(0, 500)}`);
                }
                finish();
            }
        };

        xhr.onerror = () => {
            callbacks.onError("Network error");
            finish();
        };

        // Convert messages: keep content arrays as-is for multi-modal
        const apiMessages = [
            { role: "system", content: systemPrompt },
            ...messages.map((m) => ({
                role: m.role,
                content: m.content,
                ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
                ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
            })),
        ];

        const body = JSON.stringify({
            model: modelId,
            messages: apiMessages,
            stream: true,
            tools: TOOL_DEFINITIONS,
        });

        xhr.send(body);
    });
}

/** Flush accumulated tool calls and clear the map */
function flushToolCalls(
    accum: Record<number, { id: string; name: string; arguments: string }>,
    callbacks: StreamCallbacks
) {
    for (const idx of Object.keys(accum)) {
        const tc = accum[Number(idx)];
        if (tc.name) {
            try {
                const args = JSON.parse(tc.arguments || "{}");
                callbacks.onToolCall(tc.id, tc.name, args);
            } catch {
                callbacks.onToolCall(tc.id, tc.name, {});
            }
        }
        delete accum[Number(idx)];
    }
}

// ── Anthropic Messages API streaming via XHR ───────────

export function streamChatAnthropic(params: {
    apiKey: string;
    modelId: string;
    messages: ChatMessage[];
    callbacks: StreamCallbacks;
    signal?: AbortSignal;
    systemPrompt: string;
}): Promise<void> {
    const { apiKey, modelId, messages, callbacks, signal, systemPrompt } = params;

    // Convert messages to Anthropic format
    const anthropicMessages = messages
        .filter((m) => m.role !== "system")
        .map((m) => {
            if (m.role === "tool") {
                return {
                    role: "user" as const,
                    content: [
                        {
                            type: "tool_result" as const,
                            tool_use_id: m.tool_call_id,
                            content: m.content as string,
                        },
                    ],
                };
            }
            if (m.role === "assistant" && m.tool_calls?.length) {
                const content: any[] = [];
                if (m.content) content.push({ type: "text", text: m.content });
                for (const tc of m.tool_calls) {
                    content.push({
                        type: "tool_use",
                        id: tc.id,
                        name: tc.function.name,
                        input: JSON.parse(tc.function.arguments || "{}"),
                    });
                }
                return { role: "assistant" as const, content };
            }
            // Handle multi-modal content (images)
            if (m.role === "user" && Array.isArray(m.content)) {
                // Convert OpenAI image_url format to Anthropic image format
                const anthropicContent = (m.content as ContentPart[]).map((part) => {
                    if (part.type === "image_url") {
                        // Extract base64 from data URI
                        const url = (part as any).image_url.url as string;
                        const match = url.match(/^data:(.+?);base64,(.+)$/);
                        if (match) {
                            return {
                                type: "image" as const,
                                source: {
                                    type: "base64" as const,
                                    media_type: match[1],
                                    data: match[2],
                                },
                            };
                        }
                    }
                    return part;
                });
                return { role: "user" as const, content: anthropicContent };
            }
            return { role: m.role as "user" | "assistant", content: m.content };
        });

    const tools = TOOL_DEFINITIONS.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters,
    }));

    return new Promise<void>((resolve) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", "https://api.anthropic.com/v1/messages");
        xhr.setRequestHeader("Content-Type", "application/json");
        xhr.setRequestHeader("x-api-key", apiKey);
        xhr.setRequestHeader("anthropic-version", "2023-06-01");
        xhr.setRequestHeader("Accept", "text/event-stream");

        let lastIndex = 0;
        let settled = false;
        let currentToolId = "";
        let currentToolName = "";
        let currentToolArgs = "";

        const finish = () => {
            if (settled) return;
            settled = true;
            resolve();
        };

        if (signal) {
            signal.addEventListener("abort", () => {
                xhr.abort();
                finish();
            });
        }

        xhr.onreadystatechange = () => {
            if (xhr.readyState < 3) return;

            try {
                const { lines, newIndex } = parseSSELines(xhr.responseText, lastIndex);
                lastIndex = newIndex;

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed.startsWith("data: ")) continue;
                    const data = trimmed.slice(6);

                    try {
                        const event = JSON.parse(data);

                        switch (event.type) {
                            case "content_block_start":
                                if (event.content_block?.type === "tool_use") {
                                    currentToolId = event.content_block.id;
                                    currentToolName = event.content_block.name;
                                    currentToolArgs = "";
                                }
                                break;

                            case "content_block_delta":
                                if (event.delta?.type === "text_delta") {
                                    callbacks.onTextDelta(event.delta.text);
                                } else if (event.delta?.type === "input_json_delta") {
                                    currentToolArgs += event.delta.partial_json;
                                }
                                break;

                            case "content_block_stop":
                                if (currentToolName) {
                                    try {
                                        const args = JSON.parse(currentToolArgs || "{}");
                                        callbacks.onToolCall(currentToolId, currentToolName, args);
                                    } catch {
                                        callbacks.onToolCall(currentToolId, currentToolName, {});
                                    }
                                    currentToolId = "";
                                    currentToolName = "";
                                    currentToolArgs = "";
                                }
                                break;

                            case "message_stop":
                                callbacks.onDone();
                                finish();
                                return;

                            case "error":
                                callbacks.onError(
                                    event.error?.message || "Unknown Anthropic error"
                                );
                                finish();
                                return;
                        }
                    } catch {
                        // Skip malformed JSON
                    }
                }
            } catch {
                // Ignore partial-read errors
            }

            if (xhr.readyState === 4) {
                if (xhr.status !== 200 && !settled) {
                    callbacks.onError(
                        `Anthropic API error ${xhr.status}: ${xhr.responseText.slice(0, 500)}`
                    );
                }
                finish();
            }
        };

        xhr.onerror = () => {
            callbacks.onError("Network error");
            finish();
        };

        xhr.send(
            JSON.stringify({
                model: modelId,
                max_tokens: 4096,
                system: systemPrompt,
                messages: anthropicMessages,
                tools,
                stream: true,
            })
        );
    });
}

// ── Unified entry point ────────────────────────────────

export async function streamChat(params: {
    model: ModelConfig;
    apiKey: string;
    messages: ChatMessage[];
    callbacks: StreamCallbacks;
    signal?: AbortSignal;
    settings?: AppSettings;
    customPrompt?: string;
}): Promise<void> {
    const { model, apiKey, messages, callbacks, signal, settings, customPrompt } = params;
    const systemPrompt = buildSystemPrompt(settings, customPrompt);

    if (!apiKey) {
        callbacks.onError(
            `No API key configured for ${model.provider}. Please set it in Settings.`
        );
        return;
    }

    if (model.provider === "anthropic") {
        return streamChatAnthropic({
            apiKey,
            modelId: model.modelId,
            messages,
            callbacks,
            signal,
            systemPrompt,
        });
    }

    // OpenAI, SiliconFlow, Google — all OpenAI-compatible
    return streamChatOpenAI({
        baseURL: model.baseURL,
        apiKey,
        modelId: model.modelId,
        messages,
        callbacks,
        signal,
        systemPrompt,
    });
}
