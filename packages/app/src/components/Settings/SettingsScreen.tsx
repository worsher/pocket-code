import React, { useState } from "react";
import {
    View,
    Text,
    TextInput,
    TouchableOpacity,
    ScrollView,
    StyleSheet,
    Alert,
    Image,
} from "react-native";
import type { AppSettings } from "../../store/settings";
import { GIT_PLATFORMS, type GitCredential } from "../../store/settings";
import { clearAllHistory } from "../../store/chatHistory";
import { startGitHubOAuth } from "../../services/oauth";
import { RelayClient } from "../../services/relayClient";

interface Props {
    settings: AppSettings;
    onSave: (settings: AppSettings) => void;
    onClose: () => void;
}

export default function SettingsScreen({ settings, onSave, onClose }: Props) {
    const [draft, setDraft] = useState<AppSettings>({ ...settings });
    const [pairingCode, setPairingCode] = useState("");
    const [isPairing, setIsPairing] = useState(false);

    const updateDraft = (partial: Partial<AppSettings>) => {
        setDraft((prev) => ({ ...prev, ...partial }));
    };

    const updateApiKey = (
        key: keyof AppSettings["apiKeys"],
        value: string
    ) => {
        setDraft((prev) => ({
            ...prev,
            apiKeys: { ...prev.apiKeys, [key]: value },
        }));
    };

    const updateGitToken = (platform: GitCredential["platform"], host: string, token: string) => {
        setDraft((prev) => {
            const existing = prev.gitCredentials.filter((c) => c.platform !== platform);
            if (token) {
                existing.push({ platform, host, username: "oauth2", token });
            }
            return { ...prev, gitCredentials: existing };
        });
    };

    const handleSave = () => {
        onSave(draft);
        onClose();
    };

    const [oauthLoading, setOauthLoading] = useState(false);

    const handleGitHubLogin = async () => {
        const serverUrl = draft.cloudServerUrl;
        if (!serverUrl) {
            Alert.alert("请先设置 Server 地址");
            return;
        }
        setOauthLoading(true);
        try {
            const result = await startGitHubOAuth(serverUrl);
            if (result) {
                setDraft((prev) => ({
                    ...prev,
                    authToken: result.token,
                    userId: result.userId,
                    githubLogin: result.githubLogin,
                    avatarUrl: result.avatarUrl,
                }));
                Alert.alert("登录成功", `已登录为 ${result.githubLogin}`);
            }
        } catch (err: any) {
            Alert.alert("登录失败", err.message);
        } finally {
            setOauthLoading(false);
        }
    };

    const handleGitHubLogout = () => {
        setDraft((prev) => ({
            ...prev,
            authToken: undefined,
            userId: undefined,
            githubLogin: undefined,
            avatarUrl: undefined,
        }));
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
        
        try {
            // Use a temporary client just for the pairing flow
            const client = new RelayClient({
                relayUrl: draft.relayServerUrl,
                machineId: "", // Target unspecified initially
                deviceId: draft.deviceId || "unknown",
                deviceName: "Pocket Code App",
            });

            // Wait for connection
            await new Promise<void>((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error("连接中继服务器超时")), 5000);
                client.onopen = () => {
                    clearTimeout(timeout);
                    resolve();
                };
                client.onerror = () => {
                    clearTimeout(timeout);
                    reject(new Error("连接中继服务器失败"));
                };
                client.connect();
            });

            // Send Pair Request
            const response = await client.pairDevice(pairingCode);
            
            if (response.success && response.token && response.machineId) {
                // Success! Save the token and machine ID to draft
                updateDraft({
                    relayToken: response.token,
                    relayMachineId: response.machineId,
                });
                Alert.alert("配对成功", `已连接到机器: ${response.machineName || response.machineId}`);
                setPairingCode("");
            } else {
                Alert.alert("配对失败", response.error || "未知错误");
            }
            
            client.close();
            
        } catch (err: any) {
            Alert.alert("配对失败", err.message);
        } finally {
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
                                                onPress={() => updateDraft({ relayToken: undefined, relayMachineId: undefined })}
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
                                style={[styles.modeOption, draft.workspaceMode === "local" && styles.modeOptionActive]}
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
                                    文件存储在 App 沙盒中
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
                <View style={styles.card}>
                    {GIT_PLATFORMS.map((p, idx) => {
                        const cred = draft.gitCredentials.find(
                            (c) => c.platform === p.platform
                        );
                        return (
                            <View key={p.platform}>
                                {idx > 0 && <View style={styles.separator} />}
                                <Text style={styles.inputLabel}>
                                    {p.label}{" "}
                                    <Text style={styles.inputLabelDim}>({p.host})</Text>
                                </Text>
                                <TextInput
                                    style={styles.input}
                                    value={cred?.token || ""}
                                    onChangeText={(v) =>
                                        updateGitToken(p.platform, p.host, v)
                                    }
                                    placeholder={`${p.label} Personal Access Token`}
                                    placeholderTextColor="#636366"
                                    secureTextEntry
                                    autoCapitalize="none"
                                    autoCorrect={false}
                                />
                            </View>
                        );
                    })}
                    <Text style={styles.inputHint}>
                        PAT 用于 git clone/push 操作的认证，会同步到连接的 Server
                    </Text>
                </View>

                {/* ── GitHub Account ──────────────────────── */}
                <Text style={styles.sectionTitle}>GitHub 账号</Text>
                <View style={styles.card}>
                    {draft.githubLogin ? (
                        <View style={styles.githubRow}>
                            {draft.avatarUrl ? (
                                <Image
                                    source={{ uri: draft.avatarUrl }}
                                    style={styles.githubAvatar}
                                />
                            ) : (
                                <View style={[styles.githubAvatar, styles.githubAvatarPlaceholder]}>
                                    <Text style={styles.githubAvatarText}>
                                        {draft.githubLogin.charAt(0).toUpperCase()}
                                    </Text>
                                </View>
                            )}
                            <View style={styles.githubInfo}>
                                <Text style={styles.githubName}>{draft.githubLogin}</Text>
                                <Text style={styles.githubHint}>已通过 GitHub 登录</Text>
                            </View>
                            <TouchableOpacity
                                style={styles.githubLogoutBtn}
                                onPress={handleGitHubLogout}
                            >
                                <Text style={styles.githubLogoutText}>退出</Text>
                            </TouchableOpacity>
                        </View>
                    ) : (
                        <TouchableOpacity
                            style={styles.githubLoginBtn}
                            onPress={handleGitHubLogin}
                            disabled={oauthLoading}
                        >
                            <Text style={styles.githubLoginText}>
                                {oauthLoading ? "登录中..." : "使用 GitHub 登录"}
                            </Text>
                        </TouchableOpacity>
                    )}
                    <Text style={styles.inputHint}>
                        登录后可自动获取 Git 认证和高级配额
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
