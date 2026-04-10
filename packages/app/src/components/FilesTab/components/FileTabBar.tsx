import React from "react";
import { View, Text, ScrollView, TouchableOpacity, StyleSheet } from "react-native";
import type { FileItem } from "../../../hooks/useFileTree";

interface Props {
  openFiles: FileItem[];
  activeFile: FileItem | null;
  onSelectFile: (file: FileItem) => void;
  onCloseFile: (file: FileItem) => void;
}

export default function FileTabBar({ openFiles, activeFile, onSelectFile, onCloseFile }: Props) {
  if (openFiles.length <= 1) return null;

  return (
    <View style={styles.container}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
      >
        {openFiles.map((file) => {
          const isActive = activeFile?.path === file.path;
          return (
            <TouchableOpacity
              key={file.path}
              style={[styles.tab, isActive && styles.tabActive]}
              onPress={() => onSelectFile(file)}
              activeOpacity={0.7}
            >
              <Text
                style={[styles.tabText, isActive && styles.tabTextActive]}
                numberOfLines={1}
              >
                {file.name}
              </Text>
              <TouchableOpacity
                style={styles.closeBtn}
                onPress={(e) => {
                  e.stopPropagation?.();
                  onCloseFile(file);
                }}
                hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
              >
                <Text style={[styles.closeText, isActive && styles.closeTextActive]}>
                  x
                </Text>
              </TouchableOpacity>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderBottomWidth: 0.5,
    borderBottomColor: "#38383A",
    backgroundColor: "#1C1C1E",
  },
  scrollContent: {
    paddingHorizontal: 4,
    paddingVertical: 4,
    gap: 2,
  },
  tab: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    gap: 6,
    maxWidth: 150,
  },
  tabActive: {
    backgroundColor: "#2C2C2E",
  },
  tabText: {
    color: "#8E8E93",
    fontSize: 12,
    fontFamily: "monospace",
    flexShrink: 1,
  },
  tabTextActive: {
    color: "#FFFFFF",
    fontWeight: "500",
  },
  closeBtn: {
    padding: 2,
  },
  closeText: {
    color: "#636366",
    fontSize: 12,
    fontWeight: "600",
    fontFamily: "monospace",
  },
  closeTextActive: {
    color: "#8E8E93",
  },
});
