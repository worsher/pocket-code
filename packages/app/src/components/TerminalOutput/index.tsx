import React, { useState } from "react";
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from "react-native";
import * as Clipboard from "expo-clipboard";

const COLLAPSE_LINE_THRESHOLD = 20;

interface TerminalOutputProps {
  command: string;
  stdout?: string;
  stderr?: string;
  success?: boolean;
  error?: string;
}

export default function TerminalOutput({
  command,
  stdout,
  stderr,
  success,
  error,
}: TerminalOutputProps) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const output = stdout || "";
  const lines = output.split("\n");
  const totalLines = lines.length;
  const shouldCollapse = totalLines > COLLAPSE_LINE_THRESHOLD && !expanded;

  const displayText = shouldCollapse
    ? lines.slice(0, COLLAPSE_LINE_THRESHOLD).join("\n")
    : output;

  const handleCopy = async () => {
    await Clipboard.setStringAsync(output + (stderr ? "\n" + stderr : ""));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Text style={[styles.statusDot, success === false ? styles.errorDot : styles.successDot]}>
            {success === false ? "✗" : "▶"}
          </Text>
          <Text style={styles.command} numberOfLines={1}>
            $ {command}
          </Text>
        </View>
        <TouchableOpacity onPress={handleCopy} style={styles.copyBtn}>
          <Text style={styles.copyText}>{copied ? "已复制 ✓" : "复制"}</Text>
        </TouchableOpacity>
      </View>

      {/* Output */}
      {displayText ? (
        <ScrollView horizontal style={styles.outputScroll}>
          <Text selectable style={styles.output}>
            {displayText}
          </Text>
        </ScrollView>
      ) : null}

      {/* Stderr */}
      {stderr ? (
        <View style={styles.stderrContainer}>
          <ScrollView horizontal>
            <Text selectable style={styles.stderr}>
              {stderr.slice(0, 2000)}
            </Text>
          </ScrollView>
        </View>
      ) : null}

      {/* Error message */}
      {error && !stderr ? (
        <Text style={styles.errorText}>{error}</Text>
      ) : null}

      {/* Collapse/Expand */}
      {totalLines > COLLAPSE_LINE_THRESHOLD && (
        <TouchableOpacity
          style={styles.toggleBtn}
          onPress={() => setExpanded(!expanded)}
        >
          <Text style={styles.toggleText}>
            {expanded
              ? "收起 ▲"
              : `展开全部 (${totalLines} 行) ▼`}
          </Text>
        </TouchableOpacity>
      )}
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
  statusDot: {
    fontSize: 12,
    fontWeight: "700",
  },
  successDot: {
    color: "#30D158",
  },
  errorDot: {
    color: "#FF453A",
  },
  command: {
    color: "#00D4AA",
    fontSize: 12,
    fontFamily: "monospace",
    flex: 1,
  },
  copyBtn: {
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  copyText: {
    color: "#636366",
    fontSize: 11,
  },
  outputScroll: {
    maxHeight: 400,
  },
  output: {
    color: "#CCCCCC",
    fontFamily: "monospace",
    fontSize: 11,
    lineHeight: 16,
    padding: 10,
  },
  stderrContainer: {
    borderTopWidth: 1,
    borderTopColor: "#333",
  },
  stderr: {
    color: "#FF9F0A",
    fontFamily: "monospace",
    fontSize: 11,
    lineHeight: 16,
    padding: 10,
  },
  errorText: {
    color: "#FF453A",
    fontSize: 11,
    fontFamily: "monospace",
    padding: 10,
  },
  toggleBtn: {
    paddingVertical: 6,
    alignItems: "center",
    borderTopWidth: 1,
    borderTopColor: "#333",
  },
  toggleText: {
    color: "#007AFF",
    fontSize: 12,
    fontWeight: "500",
  },
});
