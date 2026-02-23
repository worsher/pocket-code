// ── Model Configuration ────────────────────────────────
// Shared between cloud and geek modes.
// In geek mode the App calls the provider directly;
// in cloud mode the key is forwarded to the Server.

export type ModelProvider = "anthropic" | "openai" | "google" | "siliconflow" | "iflow";

export interface ModelConfig {
    key: string;
    label: string;
    description: string;
    provider: ModelProvider;
    modelId: string;
    /** Base URL for the provider API (used in geek mode) */
    baseURL: string;
}

export const MODELS: ModelConfig[] = [
    // Auto — smart routing (cloud mode only)
    {
        key: "auto",
        label: "Auto",
        description: "智能路由，自动选模型",
        provider: "siliconflow",
        modelId: "auto",
        baseURL: "",
    },
    // SiliconFlow — DeepSeek / Qwen (OpenAI-compatible)
    {
        key: "deepseek-v3",
        label: "DeepSeek V3",
        description: "日常编码，性价比之王",
        provider: "siliconflow",
        modelId: "deepseek-ai/DeepSeek-V3",
        baseURL: "https://api.siliconflow.cn/v1",
    },
    {
        key: "deepseek-r1",
        label: "DeepSeek R1",
        description: "复杂推理",
        provider: "siliconflow",
        modelId: "deepseek-ai/DeepSeek-R1",
        baseURL: "https://api.siliconflow.cn/v1",
    },
    {
        key: "qwen-coder",
        label: "Qwen Coder",
        description: "代码专精",
        provider: "siliconflow",
        modelId: "Qwen/Qwen2.5-Coder-32B-Instruct",
        baseURL: "https://api.siliconflow.cn/v1",
    },
    // Anthropic
    {
        key: "claude-sonnet",
        label: "Claude Sonnet",
        description: "高质量编程",
        provider: "anthropic",
        modelId: "claude-sonnet-4-5-20250929",
        baseURL: "https://api.anthropic.com",
    },
    {
        key: "claude-haiku",
        label: "Claude Haiku",
        description: "快速轻量",
        provider: "anthropic",
        modelId: "claude-haiku-4-5-20251001",
        baseURL: "https://api.anthropic.com",
    },
    // OpenAI
    {
        key: "gpt-4o",
        label: "GPT-4o",
        description: "通用编程",
        provider: "openai",
        modelId: "gpt-4o",
        baseURL: "https://api.openai.com/v1",
    },
    {
        key: "gpt-4o-mini",
        label: "GPT-4o Mini",
        description: "轻量任务",
        provider: "openai",
        modelId: "gpt-4o-mini",
        baseURL: "https://api.openai.com/v1",
    },
    // Google
    {
        key: "gemini-flash",
        label: "Gemini Flash",
        description: "轻量 / 免费额度大",
        provider: "google",
        modelId: "gemini-2.5-flash-preview-05-20",
        baseURL: "https://generativelanguage.googleapis.com/v1beta",
    },
    // iFlow (心流) — GLM series (OpenAI-compatible)
    {
        key: "glm-4-6",
        label: "GLM-4.6",
        description: "心流平台，智谱 GLM 系列",
        provider: "iflow",
        modelId: "glm-4.6",
        baseURL: "https://apis.iflow.cn/v1",
    },
];

/** Look up a model config by key, fallback to deepseek-v3 */
export function getModelConfig(key: string): ModelConfig {
    return MODELS.find((m) => m.key === key) ?? MODELS[0];
}

/** Get the API key name for a provider from settings */
export function getApiKeyField(
    provider: ModelProvider
): "siliconflow" | "anthropic" | "openai" | "google" | "iflow" {
    return provider;
}
