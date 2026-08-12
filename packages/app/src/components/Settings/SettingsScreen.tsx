import React, { useState } from "react";
import {
    View,
    Text,
    TextInput,
    TouchableOpacity,
    ScrollView,
    StyleSheet,
    Alert,
    Platform,
} from "react-native";
import { randomUUID } from "expo-crypto";
import type { AppSettings, GitCredentialProfile } from "../../store/settings";
import { clearAllHistory } from "../../store/chatHistory";
import { RelayClient } from "@pocket-code/client-core";
import {
    normalizeGitCredentialProfile,
    secretRefForGitCredentialProfile,
} from "../../services/gitCredentialProfiles";
import { persistGitCredentialProfileChanges } from "../../services/gitCredentialVault";

interface Props {
    settings: AppSettings;
    onSave: (settings: AppSettings) => Promise<void> | void;
    onClose: () => void;
    onRemoteGitCredentialChanges?: (args: {
        upsertProfiles: GitCredentialProfile[];
        deletedProfileIds: string[];
    }) => Promise<void>;
}

export default function SettingsScreen({
    settings,
    onSave,
    onClose,
    onRemoteGitCredentialChanges,
}: Props) {
    const [draft, setDraft] = useState<AppSettings>({ ...settings });
    const [pairingCode, setPairingCode] = useState("");
    const [isPairing, setIsPairing] = useState(false);
    const [gitSecretDrafts, setGitSecretDrafts] = useState<Record<string, string>>({});
    const [clearedGitProfileIds, setClearedGitProfileIds] = useState<string[]>([]);

    const updateDraft = (partial: Partial<AppSettings>) => {
        setDraft((prev) => ({ ...prev, ...partial }));
    };

    const localModeDisabled = Platform.OS === "ios";

    const updateApiKey = (
        key: keyof AppSettings["apiKeys"],
        value: string
    ) => {
        setDraft((prev) => ({
            ...prev,
            apiKeys: { ...prev.apiKeys, [key]: value },
        }));
    };

    const updateGitProfile = (id: string, partial: Partial<GitCredentialProfile>) => {
        setDraft((prev) => {
            const gitCredentialProfiles = prev.gitCredentialProfiles.map((profile) =>
                profile.id === id ? { ...profile, ...partial } : profile
            );
            return { ...prev, gitCredentialProfiles };
        });
    };

    const updateGitSecretDraft = (id: string, value: string) => {
        setGitSecretDrafts((previous) => ({ ...previous, [id]: value }));
        if (value.trim()) {
            setClearedGitProfileIds((previous) => previous.filter((profileId) => profileId !== id));
        }
    };

    const clearGitCredential = (id: string) => {
        setGitSecretDrafts((previous) => ({ ...previous, [id]: "" }));
        setClearedGitProfileIds((previous) =>
            previous.includes(id) ? previous : [...previous, id]
        );
        updateGitProfile(id, { hasSecret: false });
    };

    const addCustomGitLabProfile = () => {
        const id = `gitlab-custom-${randomUUID()}`;
        const profile: GitCredentialProfile = {
            id,
            label: "Custom GitLab",
            provider: "gitlab",
            authKind: "pat",
            origin: "https://gitlab.example.com",
            username: "oauth2",
            secretRef: secretRefForGitCredentialProfile(id),
            hasSecret: false,
        };
        setDraft((previous) => ({
            ...previous,
            gitCredentialProfiles: [...previous.gitCredentialProfiles, profile],
        }));
    };

    const removeCustomGitLabProfile = (id: string) => {
        setDraft((previous) => ({
            ...previous,
            gitCredentialProfiles: previous.gitCredentialProfiles.filter(
                (profile) => profile.id !== id
            ),
        }));
        setGitSecretDrafts((previous) => {
            const next = { ...previous };
            delete next[id];
            return next;
        });
        setClearedGitProfileIds((previous) =>
            previous.includes(id) ? previous : [...previous, id]
        );
    };

    const handleSave = async () => {
        try {
            const normalizedProfiles = draft.gitCredentialProfiles.map(normalizeGitCredentialProfile);
            const persistedProfiles = await persistGitCredentialProfileChanges({
                profiles: normalizedProfiles,
                secretDrafts: gitSecretDrafts,
                clearedProfileIds: clearedGitProfileIds,
                persistMetadata: async (gitCredentialProfiles) => {
                    await onSave({ ...draft, gitCredentialProfiles });
                },
            });
            if (onRemoteGitCredentialChanges) {
                const upsertIds = new Set(
                    Object.entries(gitSecretDrafts)
                        .filter(([, secret]) => !!secret.trim())
                        .map(([id]) => id)
                );
                try {
                    await onRemoteGitCredentialChanges({
                        upsertProfiles: persistedProfiles.filter((profile) => upsertIds.has(profile.id)),
                        deletedProfileIds: clearedGitProfileIds.filter((id) => !upsertIds.has(id)),
                    });
                } catch (error) {
                    Alert.alert(
                        "Key 已保存，远端同步失败",
                        error instanceof Error ? error.message : "请连接远端后重试"
                    );
                }
            }
            onClose();
        } catch (error) {
            Alert.alert(
                "设置未保存",
                error instanceof Error ? error.message : "写者切换失败，请稍后重试"
            );
        }
    };

    const handleClearHistory = () => {
        Alert.alert("清除所有对话", "确定要清除所有对话记录吗？此操作不可撤销。", [
            { text: "取消", style: "cancel" },
            {
                text: "清除",
                style: "destructive",
                onPress: async () => {
                    await clearAllHistory();
                    Alert.alert("已清除", "所有对话记录已删除。");
                },
            },
        ]);
    };

    const isGeek = draft.mode === "geek";
    const isServerWorkspace = draft.workspaceMode === "server";
    const isRelayWorkspace = draft.workspaceMode === "relay";

    const handlePairRelay = async () => {
        if (!pairingCode || pairingCode.length !== 8) {
            Alert.alert("错误", "请输入 8 位配对码");
            return;
        }

        if (!draft.relayServerUrl) {
            Alert.alert("错误", "请先输入 Relay 服务器地址");
            return;
        }

        setIsPairing(true);
        
        let client: RelayClient | undefined;
        try {
            // Use a temporary client just for the pairing flow
            const pairingClient = new RelayClient({
                relayUrl: draft.relayServerUrl,
                machineId: "", // Target unspecified initially
                deviceId: draft.deviceId || "unknown",
                deviceName: "Pocket Code App",
            });
            client = pairingClient;

            // Wait for connection
            await new Promise<void>((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error("连接中继服务器超时")), 5000);
                pairingClient.onopen = () => {
                    clearTimeout(timeout);
                    resolve();
                };
                pairingClient.onerror = () => {
                    clearTimeout(timeout);
                    reject(new Error("连接中继服务器失败"));
                };
                pairingClient.connect();
            });

            // Send Pair Request
            const response = await pairingClient.pairDevice(pairingCode);
            
            if (response.success && response.token && response.machineId) {
                if (!response.publicKey || !response.keyId) {
                    throw new Error("Daemon 版本不支持 Git Key 端到端加密，请更新 Daemon 后重新配对");
                }
                // Success! 立即持久化(不只是 draft),并让运行中的连接刷新:
                // onSave 会更新上层 settings,App 监听 relay 身份变化后用新 machineId 重连。
                const merged: AppSettings = {
                    ...draft,
                    relayToken: response.token,
                    relayMachineId: response.machineId,
                    relayCredentialPublicKey: response.publicKey,
                    relayCredentialKeyId: response.keyId,
                };
                updateDraft({
                    relayToken: response.token,
                    relayMachineId: response.machineId,
                    relayCredentialPublicKey: response.publicKey,
                    relayCredentialKeyId: response.keyId,
                });
                await onSave(merged);
                Alert.alert("配对成功", `已连接到机器: ${response.machineName || response.machineId}`);
                setPairingCode("");
            } else {
                Alert.alert("配对失败", response.error || "未知错误");
            }
            
        } catch (err: any) {
            Alert.alert("配对失败", err.message);
        } finally {
            client?.close();
            setIsPairing(false);
        }
    };

    return (
        <View style={styles.container}>
            {/* Header */}
            <View style={styles.header}>
                <TouchableOpacity onPress={onClose}>
                    <Text style={styles.cancelBtn}>取消</Text>
                </TouchableOpacity>
                <Text style={styles.title}>设置</Text>
                <TouchableOpacity onPress={handleSave}>
                    <Text style={styles.saveBtn}>保存</Text>
                </TouchableOpacity>
            </View>

            <ScrollView
                style={styles.scrollView}
                contentContainerStyle={styles.content}
                keyboardShouldPersistTaps="handled"
            >
                {/* ── Mode Switch ─────────────────────────── */}
                <Text style={styles.sectionTitle}>运行模式</Text>
                <View style={styles.card}>
                    <TouchableOpacity
                        style={[styles.modeOption, !isGeek && styles.modeOptionActive]}
                        onPress={() => updateDraft({ mode: "cloud" })}
                    >
                        <View style={styles.modeHeader}>
                            <Text style={styles.modeIcon}>☁️</Text>
                            <Text
                                style={[
                                    styles.modeLabel,
                                    !isGeek && styles.modeLabelActive,
                                ]}
                            >
                                云端模式
                            </Text>
                            {!isGeek && <Text style={styles.checkmark}>✓</Text>}
                        </View>
                        <Text style={styles.modeDesc}>
                            通过云端 Server 中转 AI 调用和工具执行
                        </Text>
                    </TouchableOpacity>

                    <View style={styles.separator} />

                    <TouchableOpacity
                        style={[styles.modeOption, isGeek && styles.modeOptionActive]}
                        onPress={() => updateDraft({ mode: "geek" })}
                    >
                        <View style={styles.modeHeader}>
                            <Text style={styles.modeIcon}>⚡</Text>
                            <Text
                                style={[styles.modeLabel, isGeek && styles.modeLabelActive]}
                            >
                                极客模式
                            </Text>
                            {isGeek && <Text style={styles.checkmark}>✓</Text>}
                        </View>
                        <Text style={styles.modeDesc}>
                            App 直调 AI API，本地 Server 仅执行工具
                        </Text>
                    </TouchableOpacity>
                </View>

                {/* ── Cloud mode settings ─────────────────── */}
                {!isGeek && (
                    <>
                        <Text style={styles.sectionTitle}>工作区 (云端连接方式)</Text>
                        <View style={styles.card}>
                            <TouchableOpacity
                                style={[styles.modeOption, isServerWorkspace && styles.modeOptionActive]}
                                onPress={() => updateDraft({ workspaceMode: "server" })}
                            >
                                <View style={styles.modeHeader}>
                                    <Text style={styles.modeIcon}>🖥️</Text>
                                    <Text style={[styles.modeLabel, isServerWorkspace && styles.modeLabelActive]}>
                                        局域网直连 (Server)
                                    </Text>
                                    {isServerWorkspace && <Text style={styles.checkmark}>✓</Text>}
                                </View>
                                <Text style={styles.modeDesc}>
                                    直接连接到部署在内网的 Pocket Code Server
                                </Text>
                            </TouchableOpacity>

                            <View style={styles.separator} />

                            <TouchableOpacity
                                style={[styles.modeOption, isRelayWorkspace && styles.modeOptionActive]}
                                onPress={() => updateDraft({ workspaceMode: "relay" })}
                            >
                                <View style={styles.modeHeader}>
                                    <Text style={styles.modeIcon}>🌍</Text>
                                    <Text style={[styles.modeLabel, isRelayWorkspace && styles.modeLabelActive]}>
                                        公网中继 (Relay)
                                    </Text>
                                    {isRelayWorkspace && <Text style={styles.checkmark}>✓</Text>}
                                </View>
                                <Text style={styles.modeDesc}>
                                    通过公共中继服务器安全连接到内网机器，无需公网 IP
                                </Text>
                            </TouchableOpacity>
                        </View>

                        {/* 直连 Server 地址 */}
                        {isServerWorkspace && (
                            <>
                                <Text style={styles.sectionTitle}>云端 Server</Text>
                                <View style={styles.card}>
                                    <Text style={styles.inputLabel}>Server 地址</Text>
                                    <TextInput
                                        style={styles.input}
                                        value={draft.cloudServerUrl}
                                        onChangeText={(v) => updateDraft({ cloudServerUrl: v })}
                                        placeholder="ws://your-server:3100"
                                        placeholderTextColor="#636366"
                                        autoCapitalize="none"
                                        autoCorrect={false}
                                    />
                                </View>
                            </>
                        )}

                        {/* Relay mode settings */}
                        {isRelayWorkspace && (
                            <>
                                <Text style={styles.sectionTitle}>Relay 中继设置</Text>
                                <View style={styles.card}>
                                    <Text style={styles.inputLabel}>中继服务器地址</Text>
                                    <TextInput
                                        style={styles.input}
                                        value={draft.relayServerUrl}
                                        onChangeText={(v) => updateDraft({ relayServerUrl: v })}
                                        placeholder="wss://relay.your-vps.com"
                                        placeholderTextColor="#636366"
                                        autoCapitalize="none"
                                        autoCorrect={false}
                                    />

                                    {draft.relayToken ? (
                                        <View style={styles.pairedContainer}>
                                            <Text style={styles.pairedText}>✅ 已配对机器</Text>
                                            <Text style={styles.machineIdText}>{draft.relayMachineId}</Text>
                                            <TouchableOpacity 
                                                style={styles.unpairBtn}
                                                onPress={() => updateDraft({
                                                    relayToken: undefined,
                                                    relayMachineId: undefined,
                                                    relayCredentialPublicKey: undefined,
                                                    relayCredentialKeyId: undefined,
                                                })}
                                            >
                                                <Text style={styles.unpairBtnText}>解除配对</Text>
                                            </TouchableOpacity>
                                        </View>
                                    ) : (
                                        <View style={styles.pairingContainer}>
                                            <Text style={styles.inputLabel}>设备配对码</Text>
                                            <View style={styles.pairingRow}>
                                                <TextInput
                                                    style={[styles.input, styles.pairingInput]}
                                                    value={pairingCode}
                                                    onChangeText={setPairingCode}
                                                    placeholder="8位配对码"
                                                    placeholderTextColor="#636366"
                                                    autoCapitalize="characters"
                                                    maxLength={8}
                                                />
                                                <TouchableOpacity 
                                                    style={[styles.pairBtn, isPairing && styles.pairBtnDisabled]}
                                                    onPress={handlePairRelay}
                                                    disabled={isPairing}
                                                >
                                                    <Text style={styles.pairBtnText}>{isPairing ? "配对中" : "配对"}</Text>
                                                </TouchableOpacity>
                                            </View>
                                            <Text style={styles.inputHint}>
                                                在要控制的机器上运行 Daemon 可获取一次性配对码
                                            </Text>
                                        </View>
                                    )}
                                </View>
                            </>
                        )}
                    </>
                )}

                {/* ── Geek mode settings ──────────────────── */}
                {isGeek && (
                    <>
                        {/* Workspace mode */}
                        {/* 工作区 (本地模式配置) */}
                        <Text style={styles.sectionTitle}>工作区 (本地模式配置)</Text>
                        <View style={styles.card}>
                            <TouchableOpacity
                                style={[
                                    styles.modeOption,
                                    draft.workspaceMode === "local" && styles.modeOptionActive,
                                    localModeDisabled && styles.modeOptionDisabled,
                                ]}
                                disabled={localModeDisabled}
                                onPress={() => updateDraft({ workspaceMode: "local" })}
                            >
                                <View style={styles.modeHeader}>
                                    <Text style={styles.modeIcon}>📱</Text>
                                    <Text style={[styles.modeLabel, draft.workspaceMode === "local" && styles.modeLabelActive]}>
                                        本地文件
                                    </Text>
                                    {draft.workspaceMode === "local" && <Text style={styles.checkmark}>✓</Text>}
                                </View>
                                <Text style={styles.modeDesc}>
                                    {localModeDisabled ? "本地终端仅 Android 支持" : "文件存储在 App 沙盒中"}
                                </Text>
                            </TouchableOpacity>

                            <View style={styles.separator} />

                            <TouchableOpacity
                                style={[styles.modeOption, draft.workspaceMode === "server" && styles.modeOptionActive]}
                                onPress={() => updateDraft({ workspaceMode: "server" })}
                            >
                                <View style={styles.modeHeader}>
                                    <Text style={styles.modeIcon}>🚀</Text>
                                    <Text style={[styles.modeLabel, draft.workspaceMode === "server" && styles.modeLabelActive]}>
                                        依赖 Termux Server
                                    </Text>
                                    {draft.workspaceMode === "server" && <Text style={styles.checkmark}>✓</Text>}
                                </View>
                                <Text style={styles.modeDesc}>
                                    所有工具执行依赖本地运行的 Pocket Code Server
                                </Text>
                            </TouchableOpacity>
                        </View>



                        {/* Local/Server Tool Server URL */}
                        {draft.workspaceMode === "server" && (
                            <>
                                <Text style={styles.sectionTitle}>工具 Server</Text>
                                <View style={styles.card}>
                                    <Text style={styles.inputLabel}>Server 地址</Text>
                                    <TextInput
                                        style={styles.input}
                                        value={draft.toolServerUrl}
                                        onChangeText={(v) => updateDraft({ toolServerUrl: v })}
                                        placeholder="ws://localhost:3100"
                                        placeholderTextColor="#636366"
                                        autoCapitalize="none"
                                        autoCorrect={false}
                                    />
                                    <Text style={styles.inputHint}>
                                        极客模式下与 Termux Server 通信的地址
                                    </Text>
                                </View>
                            </>
                        )}

                        <Text style={styles.sectionTitle}>API Keys</Text>
                        <View style={styles.card}>
                            {(
                                [
                                    ["siliconflow", "SiliconFlow", "DeepSeek / Qwen"],
                                    ["anthropic", "Anthropic", "Claude"],
                                    ["openai", "OpenAI", "GPT-4o"],
                                    ["google", "Google", "Gemini"],
                                    ["iflow", "iFlow", "GLM-4.6"],
                                ] as const
                            ).map(([key, label, desc], idx) => (
                                <View key={key}>
                                    {idx > 0 && <View style={styles.separator} />}
                                    <Text style={styles.inputLabel}>
                                        {label}{" "}
                                        <Text style={styles.inputLabelDim}>({desc})</Text>
                                    </Text>
                                    <TextInput
                                        style={styles.input}
                                        value={draft.apiKeys[key] || ""}
                                        onChangeText={(v) => updateApiKey(key, v)}
                                        placeholder={`${label} API Key`}
                                        placeholderTextColor="#636366"
                                        secureTextEntry
                                        autoCapitalize="none"
                                        autoCorrect={false}
                                    />
                                </View>
                            ))}
                        </View>
                    </>
                )}

                {/* ── Git 认证 ─────────────────────────────── */}
                <Text style={styles.sectionTitle}>Git 认证</Text>
                {draft.gitCredentialProfiles.map((profile) => {
                    const isCustomGitLab = profile.provider === "gitlab" &&
                        profile.id !== "gitlab-com-pat";
                    const hasPendingSecret = !!gitSecretDrafts[profile.id]?.trim();
                    return (
                        <View style={styles.card} key={profile.id}>
                            <View style={styles.gitProfileHeader}>
                                <Text style={styles.gitProfileTitle}>{profile.label}</Text>
                                <Text style={profile.hasSecret || hasPendingSecret
                                    ? styles.gitProfileReady
                                    : styles.gitProfileMissing}>
                                    {profile.hasSecret || hasPendingSecret ? "Key 已配置" : "未配置"}
                                </Text>
                            </View>
                            {isCustomGitLab ? (
                                <>
                                    <Text style={styles.inputLabel}>配置名称</Text>
                                    <TextInput
                                        style={styles.input}
                                        value={profile.label}
                                        onChangeText={(label) => updateGitProfile(profile.id, { label })}
                                        placeholder="Company GitLab"
                                        placeholderTextColor="#636366"
                                    />
                                    <Text style={styles.inputLabel}>HTTPS Origin</Text>
                                    <TextInput
                                        style={styles.input}
                                        value={profile.origin}
                                        onChangeText={(origin) => updateGitProfile(profile.id, { origin })}
                                        placeholder="https://gitlab.company.com:8443"
                                        placeholderTextColor="#636366"
                                        autoCapitalize="none"
                                        autoCorrect={false}
                                    />
                                    <Text style={styles.inputLabel}>路径前缀（可选）</Text>
                                    <TextInput
                                        style={styles.input}
                                        value={profile.pathPrefix || ""}
                                        onChangeText={(pathPrefix) =>
                                            updateGitProfile(profile.id, { pathPrefix })
                                        }
                                        placeholder="/gitlab 或 /team-a"
                                        placeholderTextColor="#636366"
                                        autoCapitalize="none"
                                        autoCorrect={false}
                                    />
                                </>
                            ) : (
                                <Text style={styles.gitProfileOrigin}>{profile.origin}</Text>
                            )}
                            <Text style={styles.inputLabel}>用户名</Text>
                            <TextInput
                                style={styles.input}
                                value={profile.username || ""}
                                onChangeText={(username) =>
                                    updateGitProfile(profile.id, { username })
                                }
                                placeholder={profile.provider === "gitee" ? "Gitee 用户名" : "oauth2"}
                                placeholderTextColor="#636366"
                                autoCapitalize="none"
                                autoCorrect={false}
                            />
                            {profile.provider === "gitee" && (
                                <Text style={styles.inputHint}>
                                    Gitee 环境可能要求真实用户名，请在测试仓库前填写。
                                </Text>
                            )}
                            <Text style={styles.inputLabel}>API Key / Personal Access Token</Text>
                            <TextInput
                                style={styles.input}
                                value={gitSecretDrafts[profile.id] || ""}
                                onChangeText={(value) => updateGitSecretDraft(profile.id, value)}
                                placeholder={profile.hasSecret
                                    ? "已安全保存；留空不会修改"
                                    : "输入 API Key / PAT"}
                                placeholderTextColor="#636366"
                                secureTextEntry
                                autoCapitalize="none"
                                autoCorrect={false}
                            />
                            <View style={styles.gitProfileActions}>
                                {(profile.hasSecret || hasPendingSecret) && (
                                    <TouchableOpacity
                                        style={styles.gitClearBtn}
                                        onPress={() => clearGitCredential(profile.id)}
                                    >
                                        <Text style={styles.gitClearText}>清除 Key</Text>
                                    </TouchableOpacity>
                                )}
                                {isCustomGitLab && (
                                    <TouchableOpacity
                                        style={styles.gitRemoveBtn}
                                        onPress={() => removeCustomGitLabProfile(profile.id)}
                                    >
                                        <Text style={styles.gitRemoveText}>删除配置</Text>
                                    </TouchableOpacity>
                                )}
                            </View>
                        </View>
                    );
                })}
                <View style={styles.card}>
                    <TouchableOpacity
                        style={styles.githubLoginBtn}
                        onPress={addCustomGitLabProfile}
                    >
                        <Text style={styles.githubLoginText}>＋ 添加自定义 GitLab</Text>
                    </TouchableOpacity>
                    <Text style={styles.inputHint}>
                        Key 仅保存在系统 Keychain/Keystore，不会回填到输入框或写入项目设置。
                    </Text>
                    <Text style={styles.inputHint}>
                        权限以目标仓库实际 Clone/Pull/Push 测试结果为准。
                    </Text>
                </View>

                {/* ── General ─────────────────────────────── */}
                <Text style={styles.sectionTitle}>通用</Text>
                <View style={styles.card}>
                    <TouchableOpacity
                        style={styles.dangerRow}
                        onPress={handleClearHistory}
                    >
                        <Text style={styles.dangerText}>清除所有对话记录</Text>
                    </TouchableOpacity>
                </View>

                <View style={{ height: 40 }} />
            </ScrollView>
        </View>
    );
}

// ── Styles ─────────────────────────────────────────────

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: "#000000",
    },
    header: {
        flexDirection: "row",
        justifyContent: "space-between",
        alignItems: "center",
        paddingHorizontal: 16,
        paddingVertical: 14,
        borderBottomWidth: 0.5,
        borderBottomColor: "#38383A",
    },
    title: {
        color: "#FFFFFF",
        fontSize: 17,
        fontWeight: "700",
    },
    cancelBtn: {
        color: "#8E8E93",
        fontSize: 16,
    },
    saveBtn: {
        color: "#007AFF",
        fontSize: 16,
        fontWeight: "600",
    },
    scrollView: {
        flex: 1,
    },
    content: {
        padding: 16,
    },
    sectionTitle: {
        color: "#8E8E93",
        fontSize: 13,
        fontWeight: "600",
        textTransform: "uppercase",
        letterSpacing: 0.5,
        marginTop: 24,
        marginBottom: 8,
        marginLeft: 4,
    },
    card: {
        backgroundColor: "#1C1C1E",
        borderRadius: 12,
        padding: 16,
    },
    // ── Mode selector ──
    modeOption: {
        paddingVertical: 12,
        paddingHorizontal: 4,
        borderRadius: 8,
    },
    modeOptionActive: {
        backgroundColor: "#2C2C2E",
        marginHorizontal: -8,
        paddingHorizontal: 12,
    },
    modeOptionDisabled: {
        opacity: 0.4,
    },
    modeHeader: {
        flexDirection: "row",
        alignItems: "center",
    },
    modeIcon: {
        fontSize: 18,
        marginRight: 8,
    },
    modeLabel: {
        color: "#E5E5EA",
        fontSize: 16,
        fontWeight: "600",
        flex: 1,
    },
    modeLabelActive: {
        color: "#007AFF",
    },
    modeDesc: {
        color: "#636366",
        fontSize: 13,
        marginTop: 4,
        marginLeft: 26,
    },
    checkmark: {
        color: "#007AFF",
        fontSize: 18,
        fontWeight: "700",
    },
    separator: {
        height: 0.5,
        backgroundColor: "#38383A",
        marginVertical: 8,
    },
    // ── Input fields ──
    inputLabel: {
        color: "#E5E5EA",
        fontSize: 14,
        fontWeight: "500",
        marginBottom: 6,
    },
    inputLabelDim: {
        color: "#636366",
        fontWeight: "400",
    },
    input: {
        backgroundColor: "#2C2C2E",
        color: "#FFFFFF",
        fontSize: 14,
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderRadius: 8,
        marginBottom: 12,
    },
    inputHint: {
        color: "#636366",
        fontSize: 12,
        marginTop: -8,
        marginBottom: 4,
    },
    // ── Relay Pairing ──
    pairingContainer: {
        marginTop: 8,
        borderTopWidth: 0.5,
        borderTopColor: "#38383A",
        paddingTop: 16,
    },
    pairingRow: {
        flexDirection: "row",
        alignItems: "center",
        marginBottom: 12,
    },
    pairingInput: {
        flex: 1,
        marginBottom: 0,
        marginRight: 12,
        letterSpacing: 2,
        fontWeight: "600",
    },
    pairBtn: {
        backgroundColor: "#007AFF",
        paddingHorizontal: 20,
        paddingVertical: 12,
        borderRadius: 8,
        justifyContent: "center",
    },
    pairBtnDisabled: {
        backgroundColor: "#3A3A3C",
    },
    pairBtnText: {
        color: "#FFFFFF",
        fontWeight: "600",
        fontSize: 14,
    },
    pairedContainer: {
        marginTop: 8,
        borderTopWidth: 0.5,
        borderTopColor: "#38383A",
        paddingTop: 16,
        alignItems: "center",
    },
    pairedText: {
        color: "#30D158",
        fontSize: 15,
        fontWeight: "600",
        marginBottom: 4,
    },
    machineIdText: {
        color: "#8E8E93",
        fontSize: 13,
        marginBottom: 16,
    },
    unpairBtn: {
        backgroundColor: "#2C2C2E",
        paddingHorizontal: 16,
        paddingVertical: 8,
        borderRadius: 8,
    },
    unpairBtnText: {
        color: "#FF453A",
        fontSize: 13,
        fontWeight: "500",
    },
    gitProfileHeader: {
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        marginBottom: 8,
    },
    gitProfileTitle: {
        color: "#FFFFFF",
        fontSize: 16,
        fontWeight: "600",
        flex: 1,
    },
    gitProfileReady: {
        color: "#30D158",
        fontSize: 12,
        marginLeft: 8,
    },
    gitProfileMissing: {
        color: "#8E8E93",
        fontSize: 12,
        marginLeft: 8,
    },
    gitProfileOrigin: {
        color: "#8E8E93",
        fontSize: 12,
        marginBottom: 12,
    },
    gitProfileActions: {
        flexDirection: "row",
        justifyContent: "flex-end",
        gap: 8,
    },
    gitClearBtn: {
        paddingHorizontal: 12,
        paddingVertical: 7,
        borderRadius: 7,
        backgroundColor: "#2C2C2E",
    },
    gitClearText: {
        color: "#FF9F0A",
        fontSize: 13,
    },
    gitRemoveBtn: {
        paddingHorizontal: 12,
        paddingVertical: 7,
        borderRadius: 7,
        backgroundColor: "#2C2C2E",
    },
    gitRemoveText: {
        color: "#FF453A",
        fontSize: 13,
    },
    // ── GitHub ──
    githubRow: {
        flexDirection: "row",
        alignItems: "center",
        marginBottom: 8,
    },
    githubAvatar: {
        width: 40,
        height: 40,
        borderRadius: 20,
        marginRight: 12,
    },
    githubAvatarPlaceholder: {
        backgroundColor: "#2C2C2E",
        justifyContent: "center",
        alignItems: "center",
    },
    githubAvatarText: {
        color: "#FFFFFF",
        fontSize: 18,
        fontWeight: "600",
    },
    githubInfo: {
        flex: 1,
    },
    githubName: {
        color: "#FFFFFF",
        fontSize: 16,
        fontWeight: "600",
    },
    githubHint: {
        color: "#8E8E93",
        fontSize: 12,
        marginTop: 2,
    },
    githubLogoutBtn: {
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: 8,
        backgroundColor: "#2C2C2E",
    },
    githubLogoutText: {
        color: "#FF453A",
        fontSize: 14,
    },
    githubLoginBtn: {
        backgroundColor: "#2C2C2E",
        borderRadius: 8,
        paddingVertical: 12,
        alignItems: "center",
        marginBottom: 8,
    },
    githubLoginText: {
        color: "#FFFFFF",
        fontSize: 15,
        fontWeight: "600",
    },
    // ── Danger ──
    dangerRow: {
        paddingVertical: 4,
    },
    dangerText: {
        color: "#FF453A",
        fontSize: 15,
        textAlign: "center",
    },
});
