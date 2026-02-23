import AsyncStorage from "@react-native-async-storage/async-storage";

// ── Types ──────────────────────────────────────────────

export type AppMode = "cloud" | "geek";
export type WorkspaceMode = "local" | "server";

export interface ApiKeys {
    siliconflow?: string;
    anthropic?: string;
    openai?: string;
    google?: string;
}

export interface GitCredential {
    platform: "github" | "gitee" | "gitlab";
    host: string;
    username: string;
    token: string;
}

export const GIT_PLATFORMS = [
    { platform: "github" as const, host: "github.com", label: "GitHub" },
    { platform: "gitee" as const, host: "gitee.com", label: "Gitee" },
    { platform: "gitlab" as const, host: "gitlab.com", label: "GitLab" },
];

export interface AppSettings {
    /** 运行模式：cloud = 全代理走云端 Server; geek = App 直调 AI API */
    mode: AppMode;

    /** 极客模式：工作区位置 local=本地文件 server=Termux/远程 Server */
    workspaceMode: WorkspaceMode;

    /** 云端模式：Server WebSocket 地址 */
    cloudServerUrl: string;

    /** 极客模式：本地工具 Server 地址 */
    toolServerUrl: string;

    /** 极客模式：各 AI 厂商 API Key */
    apiKeys: ApiKeys;

    /** 默认模型 key */
    defaultModel: string;

    /** Git 认证凭证 */
    gitCredentials: GitCredential[];

    /** JWT token (由 Server 签发) */
    authToken?: string;

    /** 用户 ID (Server 分配) */
    userId?: string;

    /** 设备 ID (本地生成，持久化) */
    deviceId?: string;

    /** GitHub 登录名 */
    githubLogin?: string;

    /** GitHub 头像 URL */
    avatarUrl?: string;
}

// ── Defaults ───────────────────────────────────────────

const STORAGE_KEY = "pocket-code:settings";

export const DEFAULT_SETTINGS: AppSettings = {
    mode: "cloud",
    workspaceMode: "local",
    cloudServerUrl: "ws://192.168.1.200:3100",
    toolServerUrl: "ws://localhost:3100",
    apiKeys: {},
    defaultModel: "deepseek-v3",
    gitCredentials: [],
};

// ── API ────────────────────────────────────────────────

export async function loadSettings(): Promise<AppSettings> {
    try {
        const raw = await AsyncStorage.getItem(STORAGE_KEY);
        if (!raw) return { ...DEFAULT_SETTINGS };
        return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    } catch {
        return { ...DEFAULT_SETTINGS };
    }
}

export async function saveSettings(settings: AppSettings): Promise<void> {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

export async function updateSettings(
    partial: Partial<AppSettings>
): Promise<AppSettings> {
    const current = await loadSettings();
    const updated = { ...current, ...partial };
    await saveSettings(updated);
    return updated;
}
