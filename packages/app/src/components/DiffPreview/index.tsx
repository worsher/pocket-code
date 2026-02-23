import React, { useState } from "react";
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from "react-native";

interface DiffPreviewProps {
  path: string;
  isNew: boolean;
  oldContent?: string;
  newContent: string;
}

/** Simple line-by-line diff display */
export default function DiffPreview({
  path,
  isNew,
  oldContent,
  newContent,
}: DiffPreviewProps) {
  const [expanded, setExpanded] = useState(false);

  if (isNew) {
    // New file — show summary only
    const lineCount = newContent.split("\n").length;
    return (
      <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.headerIcon}>+</Text>
          <Text style={styles.headerPath} numberOfLines={1}>
            {path}
          </Text>
          <Text style={styles.headerBadge}>新文件</Text>
        </View>
        {expanded ? (
          <>
            <ScrollView horizontal style={styles.codeScroll}>
              <Text selectable style={[styles.codeLine, styles.addedLine]}>
                {newContent}
              </Text>
            </ScrollView>
            <TouchableOpacity
              style={styles.toggleBtn}
              onPress={() => setExpanded(false)}
            >
              <Text style={styles.toggleText}>收起 ▲</Text>
            </TouchableOpacity>
          </>
        ) : (
          <TouchableOpacity
            style={styles.toggleBtn}
            onPress={() => setExpanded(true)}
          >
            <Text style={styles.toggleText}>
              查看内容 ({lineCount} 行) ▼
            </Text>
          </TouchableOpacity>
        )}
      </View>
    );
  }

  // Modified file — compute simple diff
  const oldLines = (oldContent || "").split("\n");
  const newLines = newContent.split("\n");
  const diffLines = computeSimpleDiff(oldLines, newLines);

  const addedCount = diffLines.filter((d) => d.type === "add").length;
  const removedCount = diffLines.filter((d) => d.type === "remove").length;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerIcon}>~</Text>
        <Text style={styles.headerPath} numberOfLines={1}>
          {path}
        </Text>
        <Text style={[styles.headerStats, styles.addedText]}>+{addedCount}</Text>
        <Text style={[styles.headerStats, styles.removedText]}>-{removedCount}</Text>
      </View>
      {expanded ? (
        <>
          <ScrollView horizontal style={styles.codeScroll}>
            <View>
              {diffLines.slice(0, 200).map((line, i) => (
                <Text
                  key={i}
                  selectable
                  style={[
                    styles.codeLine,
                    line.type === "add" && styles.addedLine,
                    line.type === "remove" && styles.removedLine,
                  ]}
                >
                  {line.type === "add" ? "+ " : line.type === "remove" ? "- " : "  "}
                  {line.text}
                </Text>
              ))}
              {diffLines.length > 200 && (
                <Text style={styles.truncated}>
                  ... 还有 {diffLines.length - 200} 行
                </Text>
              )}
            </View>
          </ScrollView>
          <TouchableOpacity
            style={styles.toggleBtn}
            onPress={() => setExpanded(false)}
          >
            <Text style={styles.toggleText}>收起 ▲</Text>
          </TouchableOpacity>
        </>
      ) : (
        <TouchableOpacity
          style={styles.toggleBtn}
          onPress={() => setExpanded(true)}
        >
          <Text style={styles.toggleText}>
            查看差异 (+{addedCount} -{removedCount}) ▼
          </Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

// ── Simple diff algorithm ───────────────────────────────

interface DiffLine {
  type: "same" | "add" | "remove";
  text: string;
}

function computeSimpleDiff(oldLines: string[], newLines: string[]): DiffLine[] {
  const result: DiffLine[] = [];
  const maxLen = Math.max(oldLines.length, newLines.length);

  // Simple line-by-line comparison (not a proper LCS diff, but good enough for mobile display)
  let oi = 0;
  let ni = 0;

  while (oi < oldLines.length || ni < newLines.length) {
    if (oi >= oldLines.length) {
      result.push({ type: "add", text: newLines[ni++] });
    } else if (ni >= newLines.length) {
      result.push({ type: "remove", text: oldLines[oi++] });
    } else if (oldLines[oi] === newLines[ni]) {
      result.push({ type: "same", text: oldLines[oi] });
      oi++;
      ni++;
    } else {
      // Look ahead to find a match
      let foundOld = -1;
      let foundNew = -1;
      const lookAhead = Math.min(10, maxLen);

      for (let k = 1; k <= lookAhead; k++) {
        if (ni + k < newLines.length && oldLines[oi] === newLines[ni + k]) {
          foundNew = ni + k;
          break;
        }
        if (oi + k < oldLines.length && oldLines[oi + k] === newLines[ni]) {
          foundOld = oi + k;
          break;
        }
      }

      if (foundNew >= 0) {
        // Lines were added
        while (ni < foundNew) {
          result.push({ type: "add", text: newLines[ni++] });
        }
      } else if (foundOld >= 0) {
        // Lines were removed
        while (oi < foundOld) {
          result.push({ type: "remove", text: oldLines[oi++] });
        }
      } else {
        // Replace
        result.push({ type: "remove", text: oldLines[oi++] });
        result.push({ type: "add", text: newLines[ni++] });
      }
    }
  }

  return result;
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: "#1C1C1E",
    borderRadius: 8,
    marginTop: 8,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "#38383A",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: "#2C2C2E",
    gap: 6,
  },
  headerIcon: {
    color: "#FF9F0A",
    fontSize: 14,
    fontWeight: "700",
    fontFamily: "monospace",
  },
  headerPath: {
    color: "#E5E5EA",
    fontSize: 12,
    fontFamily: "monospace",
    flex: 1,
  },
  headerBadge: {
    color: "#30D158",
    fontSize: 11,
    fontWeight: "500",
  },
  headerStats: {
    fontSize: 11,
    fontFamily: "monospace",
    fontWeight: "500",
  },
  addedText: {
    color: "#30D158",
  },
  removedText: {
    color: "#FF453A",
  },
  codeScroll: {
    maxHeight: 300,
  },
  codeLine: {
    color: "#8E8E93",
    fontFamily: "monospace",
    fontSize: 11,
    lineHeight: 16,
    paddingHorizontal: 10,
  },
  addedLine: {
    color: "#30D158",
    backgroundColor: "rgba(48, 209, 88, 0.1)",
  },
  removedLine: {
    color: "#FF453A",
    backgroundColor: "rgba(255, 69, 58, 0.1)",
  },
  truncated: {
    color: "#636366",
    fontSize: 11,
    fontFamily: "monospace",
    padding: 10,
  },
  toggleBtn: {
    paddingVertical: 6,
    alignItems: "center",
    borderTopWidth: 1,
    borderTopColor: "#38383A",
  },
  toggleText: {
    color: "#007AFF",
    fontSize: 12,
    fontWeight: "500",
  },
});
