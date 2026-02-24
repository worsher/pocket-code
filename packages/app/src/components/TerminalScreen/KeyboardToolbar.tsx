import React from "react";
import { View, Text, TouchableOpacity, FlatList, StyleSheet } from "react-native";

export interface KeyAction {
    label: string;
    sequence: string;
}

export const DEFAULT_KEY_ACTIONS: KeyAction[] = [
    { label: "ESC", sequence: "\x1b" },
    { label: "TAB", sequence: "\t" },
    { label: "CTRL-C", sequence: "\x03" },
    { label: "CTRL-D", sequence: "\x04" },
    { label: "CTRL-Z", sequence: "\x1a" },
    { label: "CTRL-A", sequence: "\x01" },
    { label: "CTRL-E", sequence: "\x05" },
    { label: "CTRL-L", sequence: "\x0c" },
    { label: "UP", sequence: "\x1b[A" },
    { label: "DN", sequence: "\x1b[B" },
    { label: "LT", sequence: "\x1b[D" },
    { label: "RT", sequence: "\x1b[C" },
    { label: "HOME", sequence: "\x1b[H" },
    { label: "END", sequence: "\x1b[F" },
    { label: "PgUp", sequence: "\x1b[5~" },
    { label: "PgDn", sequence: "\x1b[6~" },
];

interface KeyboardToolbarProps {
    onKey: (sequence: string) => void;
    keyActions?: KeyAction[];
}

export default function KeyboardToolbar({
    onKey,
    keyActions = DEFAULT_KEY_ACTIONS,
}: KeyboardToolbarProps) {
    return (
        <View style={styles.container}>
            <FlatList
                horizontal
                showsHorizontalScrollIndicator={false}
                data={keyActions}
                keyExtractor={(item) => item.label}
                contentContainerStyle={styles.listContent}
                renderItem={({ item }) => (
                    <TouchableOpacity
                        style={styles.keyBtn}
                        onPress={() => onKey(item.sequence)}
                        activeOpacity={0.7}
                    >
                        <Text style={styles.keyLabel}>{item.label}</Text>
                    </TouchableOpacity>
                )}
            />
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        backgroundColor: "#1C1C1E",
        borderTopWidth: 0.5,
        borderTopColor: "#38383A",
        paddingVertical: 6,
    },
    listContent: {
        paddingHorizontal: 10,
        gap: 6,
    },
    keyBtn: {
        backgroundColor: "#2C2C2E",
        paddingHorizontal: 12,
        paddingVertical: 7,
        borderRadius: 6,
        borderWidth: 0.5,
        borderColor: "#3A3A3C",
    },
    keyLabel: {
        color: "#E5E5EA",
        fontSize: 13,
        fontWeight: "600",
        letterSpacing: 0.2,
    },
});
