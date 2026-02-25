import React, { useEffect, useRef, useState } from "react";
import {
    View,
    Text,
    StyleSheet,
    ScrollView,
    TouchableOpacity,
} from "react-native";
import * as Clipboard from "expo-clipboard";
import { subscribeProcesses, killProcess, type ProcessInfo } from "../../services/processManager";

interface ProcessOutputProps {
    processId: number;
    command: string;
}

export default function ProcessOutput({ processId, command }: ProcessOutputProps) {
    const [info, setInfo] = useState<ProcessInfo | undefined>();
    const [copied, setCopied] = useState(false);
    const scrollRef = useRef<ScrollView>(null);

    useEffect(() => {
        return subscribeProcesses((processes) => {
            setInfo(processes.get(processId));
        });
    }, [processId]);

    const handleStop = () => killProcess(processId);

    const handleCopy = async () => {
        const text = info?.outputLines.join("\n") ?? "";
        await Clipboard.setStringAsync(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    const status = info?.status ?? "running";
    const lines = info?.outputLines ?? [];

    const statusColor =
        status === "running" ? "#30D158" :
        status === "killed"  ? "#FF9F0A" :
        info?.exitCode === 0 ? "#30D158" : "#FF453A";

    const statusLabel =
        status === "running" ? "运行中" :
        status === "killed"  ? "已停止" :
        `已退出 (${info?.exitCode ?? ""})`;

    return (
        <View style={styles.container}>
            {/* Header */}
            <View style={styles.header}>
                <View style={styles.headerLeft}>
                    <View style={[styles.dot, { backgroundColor: statusColor }]} />
                    <Text style={styles.command} numberOfLines={1}>$ {command}</Text>
                </View>
                <View style={styles.headerRight}>
                    <Text style={[styles.statusLabel, { color: statusColor }]}>{statusLabel}</Text>
                    <TouchableOpacity onPress={handleCopy} style={styles.actionBtn}>
                        <Text style={styles.actionText}>{copied ? "已复制" : "复制"}</Text>
                    </TouchableOpacity>
                    {status === "running" && (
                        <TouchableOpacity onPress={handleStop} style={[styles.actionBtn, styles.stopBtn]}>
                            <Text style={styles.stopText}>停止</Text>
                        </TouchableOpacity>
                    )}
                </View>
            </View>

            {/* Output */}
            <ScrollView
                ref={scrollRef}
                style={styles.outputScroll}
                onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
            >
                {lines.length === 0 ? (
                    <Text style={styles.waiting}>等待输出...</Text>
                ) : (
                    <Text selectable style={styles.output}>
                        {lines.join("\n")}
                    </Text>
                )}
            </ScrollView>
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        backgroundColor: "#0D0D0D",
        borderRadius: 8,
        marginTop: 8,
        overflow: "hidden",
        borderWidth: 1,
        borderColor: "#333",
    },
    header: {
        flexDirection: "row",
        justifyContent: "space-between",
        alignItems: "center",
        paddingHorizontal: 10,
        paddingVertical: 6,
        backgroundColor: "#1A1A1A",
    },
    headerLeft: {
        flexDirection: "row",
        alignItems: "center",
        flex: 1,
        gap: 6,
    },
    dot: {
        width: 7,
        height: 7,
        borderRadius: 4,
    },
    command: {
        color: "#00D4AA",
        fontSize: 12,
        fontFamily: "monospace",
        flex: 1,
    },
    headerRight: {
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
    },
    statusLabel: {
        fontSize: 11,
        fontWeight: "600",
    },
    actionBtn: {
        paddingHorizontal: 8,
        paddingVertical: 2,
    },
    actionText: {
        color: "#636366",
        fontSize: 11,
    },
    stopBtn: {
        backgroundColor: "#3A1A1A",
        borderRadius: 4,
    },
    stopText: {
        color: "#FF453A",
        fontSize: 11,
        fontWeight: "600",
    },
    outputScroll: {
        maxHeight: 300,
    },
    output: {
        color: "#CCCCCC",
        fontFamily: "monospace",
        fontSize: 11,
        lineHeight: 16,
        padding: 10,
    },
    waiting: {
        color: "#636366",
        fontFamily: "monospace",
        fontSize: 11,
        padding: 10,
        fontStyle: "italic",
    },
});
