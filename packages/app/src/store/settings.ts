import AsyncStorage from "@react-native-async-storage/async-storage";
import { defaultWorkspaceMode } from "../utils/platformDefaults";
import { runtimePlatformOS } from "../utils/runtimePlatform";
import {
    BUILTIN_GIT_CREDENTIAL_PROFILES,
    mergeBuiltinGitCredentialProfiles,
    normalizeGitCredentialOrigin,
    normalizeGitCredentialPathPrefix,
    normalizeGitCredentialProfile,
    secretRefForGitCredentialProfile,
    type GitCredentialProfile,
    type GitCredentialProvider,
} from "../services/gitCredentialProfiles";
import { gitCredentialVault } from "../services/gitCredentialVault";

export type { GitCredentialProfile, GitCredentialProvider } from "../services/gitCredentialProfiles";

// ── Types ──────────────────────────────────────────────

export type AppMode = "cloud" | "geek";
export type WorkspaceMode = "local" | "server" | "relay";

export interface ApiKeys {
    siliconflow?: string;
    anthropic?: string;
    openai?: string;
    google?: string;
    iflow?: string;
}

export interface AppSettings {
    /** 运行模式：cloud = 全代理走云端 Server; geek = App 直调 AI API */
    mode: AppMode;

    /** 极客模式：工作区位置 local=本地文件 server=Termux/远程 Server */
    workspaceMode: WorkspaceMode;

    /** 云端模式：Server WebSocket 地址 */
    cloudServerUrl: string;

    /** 极客模式：本地工具 Server 地址 */
    toolServerUrl: string;

    /** 极客模式：Relay 中继服务器地址 */
    relayServerUrl: string;

    /** 极客模式：配对授权后的 Relay Token */
    relayToken?: string;

    /** 极客模式：当前配对的机器 ID */
    relayMachineId?: string;

    /** 配对 daemon 用于密封 Git Key 的 TOFU 公钥（非敏感元数据）。 */
    relayCredentialPublicKey?: string;

    /** 与 relayCredentialPublicKey 成对的 daemon key id。 */
    relayCredentialKeyId?: string;

    /** 极客模式:relay 隧道模式(运行时从 /health 拉取,不落盘持久化) */
    relayTunnelMode?: "subdomain" | "path";

    /** 极客模式:relay 子域基础域名(subdomain 模式,运行时拉取) */
    relayTunnelBaseDomain?: string | null;

    /** 极客模式：各 AI 厂商 API Key */
    apiKeys: ApiKeys;

    /** 默认模型 key */
    defaultModel: string;

    /** Git 认证 metadata。PAT/API Key 只存在系统 SecureStore 中。 */
    gitCredentialProfiles: GitCredentialProfile[];

    /** 旧版明文凭据尚未完全迁移；不持久化到新 schema。 */
    gitCredentialMigrationPending?: boolean;

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

interface LegacyGitCredential {
    platform: GitCredentialProvider;
    host: string;
    username?: string;
    token: string;
}

export const DEFAULT_SETTINGS: AppSettings = {
    mode: "cloud",
    workspaceMode: defaultWorkspaceMode(runtimePlatformOS),
    cloudServerUrl: "ws://192.168.1.200:3100",
    toolServerUrl: "ws://localhost:3100",
    relayServerUrl: "wss://relay.your-vps.com", // Example URL, configurable in UI
    apiKeys: {},
    defaultModel: "deepseek-v4-flash",
    gitCredentialProfiles: BUILTIN_GIT_CREDENTIAL_PROFILES.map((profile) => ({ ...profile })),
};

// ── API ────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

function persistedProfiles(value: unknown): GitCredentialProfile[] {
    if (!Array.isArray(value)) return [];
    const profiles: GitCredentialProfile[] = [];
    for (const item of value) {
        if (!isRecord(item)) continue;
        try {
            profiles.push(
                normalizeGitCredentialProfile({
                    id: String(item.id ?? ""),
                    label: String(item.label ?? ""),
                    provider: item.provider as GitCredentialProvider,
                    authKind: "pat",
                    origin: String(item.origin ?? ""),
                    username: typeof item.username === "string" ? item.username : undefined,
                    pathPrefix: typeof item.pathPrefix === "string" ? item.pathPrefix : undefined,
                    secretRef: String(item.secretRef ?? ""),
                    hasSecret: item.hasSecret === true,
                    updatedAt:
                        typeof item.updatedAt === "number" && Number.isFinite(item.updatedAt)
                            ? item.updatedAt
                            : undefined,
                })
            );
        } catch {
            // Invalid non-secret metadata is discarded.
        }
    }
    return profiles;
}

function parseLegacyGitCredentials(value: unknown): LegacyGitCredential[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((item): LegacyGitCredential[] => {
        if (!isRecord(item)) return [];
        const platform = item.platform;
        const host = typeof item.host === "string" ? item.host.trim() : "";
        const token = typeof item.token === "string" ? item.token.trim() : "";
        if (
            (platform !== "github" && platform !== "gitee" && platform !== "gitlab") ||
            !host ||
            !token
        ) {
            return [];
        }
        return [{
            platform,
            host,
            token,
            username: typeof item.username === "string" ? item.username : undefined,
        }];
    });
}

function shortStableHash(value: string): string {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
}

function profileForLegacyCredential(credential: LegacyGitCredential): GitCredentialProfile {
    const rawBase = credential.host.includes("://")
        ? credential.host
        : `https://${credential.host}`;
    let parsed: URL;
    try {
        parsed = new URL(rawBase);
    } catch {
        throw new Error("Legacy Git credential host is invalid");
    }
    const origin = normalizeGitCredentialOrigin(parsed.origin);
    const pathPrefix = normalizeGitCredentialPathPrefix(parsed.pathname);
    const builtinId =
        credential.platform === "github" && origin === "https://github.com" && !pathPrefix
            ? "github-pat"
            : credential.platform === "gitee" && origin === "https://gitee.com" && !pathPrefix
              ? "gitee-pat"
              : credential.platform === "gitlab" && origin === "https://gitlab.com" && !pathPrefix
                ? "gitlab-com-pat"
                : undefined;
    const id = builtinId ?? `git-legacy-${shortStableHash(`${origin}${pathPrefix ?? ""}`)}`;
    return normalizeGitCredentialProfile({
        id,
        label: builtinId
            ? BUILTIN_GIT_CREDENTIAL_PROFILES.find((profile) => profile.id === builtinId)!.label
            : `${credential.platform} (${parsed.host}${pathPrefix ?? ""})`,
        provider: credential.platform,
        authKind: "pat",
        origin,
        username: credential.username?.trim() || "oauth2",
        pathPrefix,
        secretRef: secretRefForGitCredentialProfile(id),
        hasSecret: false,
    });
}

function settingsFromPersisted(value: Record<string, unknown>): AppSettings {
    const profiles = mergeBuiltinGitCredentialProfiles(persistedProfiles(value.gitCredentialProfiles));
    // Explicitly omit legacy plaintext and internal migration state from the in-memory spread.
    const { gitCredentials: _legacy, gitCredentialMigrationPending: _pending, ...safe } = value;
    return {
        ...DEFAULT_SETTINGS,
        ...safe,
        apiKeys: isRecord(value.apiKeys) ? value.apiKeys : {},
        gitCredentialProfiles: profiles,
    } as AppSettings;
}

function settingsForPersistence(settings: AppSettings): AppSettings {
    const { gitCredentialMigrationPending: _pending, ...safe } = settings;
    return {
        ...safe,
        gitCredentialProfiles: mergeBuiltinGitCredentialProfiles(settings.gitCredentialProfiles),
    };
}

async function migrateLegacyGitCredentials(
    legacy: readonly LegacyGitCredential[],
    settings: AppSettings
): Promise<AppSettings> {
    if (legacy.length === 0) return settings;
    const profiles = [...settings.gitCredentialProfiles];
    for (const credential of legacy) {
        const migrated = profileForLegacyCredential(credential);
        const existingIndex = profiles.findIndex((profile) => profile.id === migrated.id);
        const existingSecret = await gitCredentialVault.get(migrated.id);
        if (!existingSecret) {
            await gitCredentialVault.set(migrated.id, credential.token);
        }
        const verified = await gitCredentialVault.get(migrated.id);
        if (!verified) throw new Error("Legacy Git credential migration verification failed");
        const profile = normalizeGitCredentialProfile({
            ...(existingIndex >= 0 ? profiles[existingIndex] : migrated),
            hasSecret: true,
            updatedAt: Date.now(),
        });
        if (existingIndex >= 0) profiles[existingIndex] = profile;
        else profiles.push(profile);
    }
    return {
        ...settings,
        gitCredentialProfiles: mergeBuiltinGitCredentialProfiles(profiles),
        gitCredentialMigrationPending: undefined,
    };
}

export async function loadSettings(): Promise<AppSettings> {
    try {
        const raw = await AsyncStorage.getItem(STORAGE_KEY);
        if (!raw) return settingsForPersistence(DEFAULT_SETTINGS);
        const parsed: unknown = JSON.parse(raw);
        if (!isRecord(parsed)) return settingsForPersistence(DEFAULT_SETTINGS);
        let settings = settingsFromPersisted(parsed);
        const legacy = parseLegacyGitCredentials(parsed.gitCredentials);
        if (legacy.length > 0) {
            try {
                settings = await migrateLegacyGitCredentials(legacy, settings);
                await AsyncStorage.setItem(
                    STORAGE_KEY,
                    JSON.stringify(settingsForPersistence(settings))
                );
            } catch (error) {
                // Keep the original AsyncStorage record intact so migration can retry on next load.
                console.warn("[Git credentials] SecureStore migration will be retried", error);
                settings = { ...settings, gitCredentialMigrationPending: true };
            }
        }
        return settings;
    } catch {
        return settingsForPersistence(DEFAULT_SETTINGS);
    }
}

export async function saveSettings(settings: AppSettings): Promise<void> {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    let ready = settings;
    if (raw) {
        let persisted: unknown;
        try {
            persisted = JSON.parse(raw);
        } catch {
            persisted = undefined;
        }
        if (isRecord(persisted)) {
            const legacy = parseLegacyGitCredentials(persisted.gitCredentials);
            // SecureStore failures deliberately propagate. Otherwise a regular settings save
            // could overwrite the only remaining plaintext copy before migration succeeds.
            ready = await migrateLegacyGitCredentials(legacy, ready);
        }
    }
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(settingsForPersistence(ready)));
}

export async function updateSettings(
    partial: Partial<AppSettings>
): Promise<AppSettings> {
    const current = await loadSettings();
    const updated = { ...current, ...partial };
    await saveSettings(updated);
    return updated;
}
