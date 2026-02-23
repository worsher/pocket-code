import React from "react";
import { View, Text, StyleSheet } from "react-native";
import type { ToolCall } from "../../hooks/useAgent";

interface FileChange {
  path: string;
  isNew: boolean;
}

interface Props {
  toolCalls: ToolCall[];
}

function extractChanges(toolCalls: ToolCall[]): FileChange[] {
  const seen = new Set<string>();
  const changes: FileChange[] = [];

  for (const tc of toolCalls) {
    if (tc.toolName !== "writeFile" || !tc.result) continue;
    const result = tc.result as Record<string, any>;
    if (!result.success) continue;

    const path = result.path || (tc.args as any).path || "";
    if (!path || seen.has(path)) continue;
    seen.add(path);

    changes.push({
      path,
      isNew: result.isNew ?? false,
    });
  }

  return changes;
}

export default function FileChangeSummary({ toolCalls }: Props) {
  const changes = extractChanges(toolCalls);
  if (changes.length === 0) return null;

  return (
    <View style={styles.container}>
      <Text style={styles.title}>文件变更 ({changes.length})</Text>
      {changes.map((change) => (
        <View key={change.path} style={styles.item}>
          <Text style={[styles.badge, change.isNew ? styles.badgeNew : styles.badgeModified]}>
            {change.isNew ? "+" : "~"}
          </Text>
          <Text style={styles.path} numberOfLines={1}>
            {change.path}
          </Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginTop: 8,
    backgroundColor: "#2C2C2E",
    borderRadius: 8,
    padding: 10,
  },
  title: {
    color: "#8E8E93",
    fontSize: 11,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  item: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 3,
    gap: 6,
  },
  badge: {
    width: 18,
    height: 18,
    borderRadius: 4,
    textAlign: "center",
    lineHeight: 18,
    fontSize: 12,
    fontWeight: "700",
    fontFamily: "monospace",
    overflow: "hidden",
  },
  badgeNew: {
    backgroundColor: "#1B3A1B",
    color: "#34C759",
  },
  badgeModified: {
    backgroundColor: "#3A2F1B",
    color: "#FF9F0A",
  },
  path: {
    flex: 1,
    color: "#E5E5EA",
    fontSize: 12,
    fontFamily: "monospace",
  },
});
