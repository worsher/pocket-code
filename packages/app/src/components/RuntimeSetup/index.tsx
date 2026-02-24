/**
 * RuntimeSetup/index.tsx
 *
 * 运行时安装向导 UI。
 * 在 Terminal Tab 首次使用时，如果 rootfs 未安装则显示引导界面。
 * 已安装后显示已装包列表 + 手动安装额外包的入口。
 */
import React, { useEffect, useState, useCallback } from "react";
import {
    View,
    Text,
    TouchableOpacity,
    StyleSheet,
    ActivityIndicator,
    ScrollView,
    TextInput,
    Alert,
} from "react-native";
import {
    getRuntimeStatus,
    bootstrapRootfs,
    installPackage,
    type RuntimeStatus,
} from "../../services/runtimeManager";

// ── Common packages to suggest ────────────────────────────────────────────────

const SUGGESTED_PACKAGES = [
    { name: "python3", desc: "Python 3 运行时" },
    { name: "nodejs", desc: "Node.js 运行时" },
    { name: "npm", desc: "Node.js 包管理器" },
    { name: "git", desc: "版本控制" },
    { name: "curl", desc: "HTTP 客户端" },
    { name: "busybox-extras", desc: "更多 Linux 工具" },
];

// ── Types ─────────────────────────────────────────────────────────────────────

interface RuntimeSetupProps {
    /** Called when setup is complete and user can enter the terminal */
    onComplete?: () => void;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function RuntimeSetup({ onComplete }: RuntimeSetupProps) {
    const [status, setStatus] = useState<RuntimeStatus | null>(null);
    const [loading, setLoading] = useState(true);
    const [progress, setProgress] = useState(0);
    const [progressMsg, setProgressMsg] = useState("");
    const [installing, setInstalling] = useState<string | null>(null);
    const [customPkg, setCustomPkg] = useState("");

    const refreshStatus = useCallback(async () => {
        setLoading(true);
        const s = await getRuntimeStatus();
        setStatus(s);
        setLoading(false);
    }, []);

    useEffect(() => {
        refreshStatus();
    }, [refreshStatus]);

    // ── Bootstrap ──────────────────────────────────────────────────────────────

    const handleBootstrap = useCallback(async () => {
        setLoading(true);
        setProgress(0);
        try {
            await bootstrapRootfs((pct, msg) => {
                setProgress(pct);
                setProgressMsg(msg ?? "");
            });
            await refreshStatus();
            Alert.alert("✅ 安装完成", "Alpine Linux 环境已就绪，现在可以安装 Python/Node.js 等工具。");
        } catch (e: any) {
            Alert.alert("❌ 安装失败", e.message ?? String(e));
            setLoading(false);
        }
    }, [refreshStatus]);

    // ── Install package ────────────────────────────────────────────────────────

    const handleInstall = useCallback(
        async (pkg: string) => {
            if (!pkg.trim()) return;
            setInstalling(pkg);
            const result = await installPackage([pkg.trim()]);
            setInstalling(null);
            if (result.success) {
                await refreshStatus();
            } else {
                Alert.alert(`安装 ${pkg} 失败`, result.output.slice(0, 500));
            }
        },
        [refreshStatus]
    );

    // ── Render ──────────────────────────────────────────────────────────────────

    if (loading) {
        return (
            <View style={styles.center}>
                <ActivityIndicator size="large" color="#007AFF" />
                {progress > 0 && (
                    <View style={styles.progressWrap}>
                        <View style={styles.progressBar}>
                            <View style={[styles.progressFill, { width: `${progress}%` }]} />
                        </View>
                        <Text style={styles.progressText}>{progressMsg || `${progress}%`}</Text>
                    </View>
                )}
            </View>
        );
    }

    if (!status) return null;

    // proot 不可用 → 显示提示
    if (!status.prootAvailable) {
        return (
            <View style={styles.center}>
                <Text style={styles.icon}>⚠️</Text>
                <Text style={styles.title}>proot 不可用</Text>
                <Text style={styles.desc}>
                    `libproot.so` 未找到。请使用包含 proot 支持的构建版本。
                </Text>
            </View>
        );
    }

    // rootfs 未安装 → 安装向导
    if (!status.rootfsInstalled) {
        return (
            <View style={styles.center}>
                <Text style={styles.icon}>🐧</Text>
                <Text style={styles.title}>安装 Linux 环境</Text>
                <Text style={styles.desc}>
                    下载 Alpine Linux minirootfs (~4MB)，获得完整的包管理能力（python3、nodejs、npm、git…）
                </Text>
                <TouchableOpacity style={styles.primaryBtn} onPress={handleBootstrap}>
                    <Text style={styles.primaryBtnText}>立即安装</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.skipBtn} onPress={onComplete}>
                    <Text style={styles.skipBtnText}>跳过，使用基础 Shell</Text>
                </TouchableOpacity>
            </View>
        );
    }

    // rootfs 已安装 → 显示已装包 + 安装更多
    return (
        <ScrollView style={styles.container} contentContainerStyle={styles.content}>
            <Text style={styles.sectionTitle}>🐧 Alpine {status.rootfsVersion}</Text>

            {/* Installed packages */}
            <View style={styles.card}>
                <Text style={styles.cardTitle}>已安装</Text>
                {status.installedPackages.length === 0 ? (
                    <Text style={styles.emptyHint}>尚未安装任何额外包</Text>
                ) : (
                    <View style={styles.tagWrap}>
                        {status.installedPackages.map((pkg) => (
                            <View key={pkg} style={styles.tag}>
                                <Text style={styles.tagText}>{pkg}</Text>
                            </View>
                        ))}
                    </View>
                )}
            </View>

            {/* Suggested packages */}
            <View style={styles.card}>
                <Text style={styles.cardTitle}>推荐安装</Text>
                {SUGGESTED_PACKAGES.filter(
                    (p) => !status.installedPackages.includes(p.name)
                ).map((p) => (
                    <TouchableOpacity
                        key={p.name}
                        style={styles.suggestRow}
                        onPress={() => handleInstall(p.name)}
                        disabled={installing != null}
                    >
                        <View style={styles.suggestLeft}>
                            <Text style={styles.suggestName}>{p.name}</Text>
                            <Text style={styles.suggestDesc}>{p.desc}</Text>
                        </View>
                        {installing === p.name ? (
                            <ActivityIndicator size="small" color="#007AFF" />
                        ) : (
                            <Text style={styles.installBtn}>安装</Text>
                        )}
                    </TouchableOpacity>
                ))}
                {SUGGESTED_PACKAGES.every((p) => status.installedPackages.includes(p.name)) && (
                    <Text style={styles.emptyHint}>所有推荐包已安装 ✅</Text>
                )}
            </View>

            {/* Custom package input */}
            <View style={styles.card}>
                <Text style={styles.cardTitle}>安装其他包</Text>
                <View style={styles.inputRow}>
                    <TextInput
                        style={styles.customInput}
                        placeholder="输入包名，例如 go"
                        placeholderTextColor="#636366"
                        value={customPkg}
                        onChangeText={setCustomPkg}
                        autoCapitalize="none"
                        autoCorrect={false}
                    />
                    <TouchableOpacity
                        style={styles.customInstallBtn}
                        onPress={() => {
                            handleInstall(customPkg);
                            setCustomPkg("");
                        }}
                        disabled={!customPkg.trim() || installing != null}
                    >
                        <Text style={styles.customInstallBtnText}>apk add</Text>
                    </TouchableOpacity>
                </View>
            </View>

            <TouchableOpacity style={styles.primaryBtn} onPress={onComplete}>
                <Text style={styles.primaryBtnText}>进入终端</Text>
            </TouchableOpacity>
        </ScrollView>
    );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: "#000" },
    content: { padding: 20, paddingBottom: 40 },
    center: {
        flex: 1,
        backgroundColor: "#000",
        alignItems: "center",
        justifyContent: "center",
        padding: 32,
    },
    icon: { fontSize: 48, marginBottom: 16 },
    title: {
        color: "#FFFFFF",
        fontSize: 20,
        fontWeight: "700",
        textAlign: "center",
        marginBottom: 12,
    },
    desc: {
        color: "#8E8E93",
        fontSize: 14,
        textAlign: "center",
        lineHeight: 20,
        marginBottom: 32,
    },
    progressWrap: { width: "100%", marginTop: 24 },
    progressBar: {
        height: 6,
        backgroundColor: "#2C2C2E",
        borderRadius: 3,
        overflow: "hidden",
    },
    progressFill: {
        height: "100%",
        backgroundColor: "#007AFF",
        borderRadius: 3,
    },
    progressText: { color: "#8E8E93", fontSize: 12, marginTop: 8, textAlign: "center" },
    primaryBtn: {
        backgroundColor: "#007AFF",
        paddingHorizontal: 32,
        paddingVertical: 14,
        borderRadius: 12,
        marginTop: 8,
        width: "100%",
        alignItems: "center",
    },
    primaryBtnText: { color: "#FFFFFF", fontSize: 16, fontWeight: "700" },
    skipBtn: { paddingVertical: 12, marginTop: 8 },
    skipBtnText: { color: "#636366", fontSize: 14 },
    sectionTitle: {
        color: "#FFFFFF",
        fontSize: 18,
        fontWeight: "700",
        marginBottom: 16,
    },
    card: {
        backgroundColor: "#1C1C1E",
        borderRadius: 12,
        padding: 16,
        marginBottom: 16,
    },
    cardTitle: { color: "#8E8E93", fontSize: 12, fontWeight: "600", marginBottom: 12, letterSpacing: 0.5 },
    emptyHint: { color: "#636366", fontSize: 13 },
    tagWrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
    tag: { backgroundColor: "#2C2C2E", paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8 },
    tagText: { color: "#E5E5EA", fontSize: 13 },
    suggestRow: {
        flexDirection: "row",
        alignItems: "center",
        paddingVertical: 10,
        borderBottomWidth: 0.5,
        borderBottomColor: "#2C2C2E",
    },
    suggestLeft: { flex: 1 },
    suggestName: { color: "#E5E5EA", fontSize: 15, fontWeight: "500" },
    suggestDesc: { color: "#636366", fontSize: 12, marginTop: 2 },
    installBtn: { color: "#007AFF", fontSize: 14, fontWeight: "600" },
    inputRow: { flexDirection: "row", gap: 8 },
    customInput: {
        flex: 1,
        backgroundColor: "#2C2C2E",
        color: "#FFFFFF",
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 8,
        fontSize: 14,
    },
    customInstallBtn: {
        backgroundColor: "#007AFF",
        paddingHorizontal: 14,
        paddingVertical: 8,
        borderRadius: 8,
        justifyContent: "center",
    },
    customInstallBtnText: { color: "#FFFFFF", fontSize: 13, fontWeight: "600" },
});
