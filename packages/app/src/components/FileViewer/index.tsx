import React from "react";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  Modal,
  Platform,
} from "react-native";

interface Props {
  visible: boolean;
  path: string;
  content: string | null;
  error?: string;
  onClose: () => void;
}

export default function FileViewer({
  visible,
  path,
  content,
  error,
  onClose,
}: Props) {
  const fileName = path.split("/").pop() || path;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      onRequestClose={onClose}
    >
      <View style={styles.container}>
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity onPress={onClose}>
            <Text style={styles.backBtn}>← 返回</Text>
          </TouchableOpacity>
          <Text style={styles.fileName} numberOfLines={1}>
            {fileName}
          </Text>
          <View style={{ width: 50 }} />
        </View>

        {/* Path */}
        <Text style={styles.filePath} numberOfLines={1}>
          {path}
        </Text>

        {/* Content */}
        {error ? (
          <View style={styles.errorContainer}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : content === null ? (
          <View style={styles.loadingContainer}>
            <Text style={styles.loadingText}>加载中...</Text>
          </View>
        ) : (
          <ScrollView
            style={styles.codeScroll}
            horizontal
            contentContainerStyle={styles.codeScrollContent}
          >
            <ScrollView contentContainerStyle={styles.codeInner}>
              <Text style={styles.codeText} selectable>
                {content}
              </Text>
            </ScrollView>
          </ScrollView>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#000000",
    paddingTop: 50,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 0.5,
    borderBottomColor: "#38383A",
  },
  backBtn: {
    color: "#007AFF",
    fontSize: 16,
  },
  fileName: {
    color: "#FFFFFF",
    fontSize: 16,
    fontWeight: "600",
    flex: 1,
    textAlign: "center",
    marginHorizontal: 8,
  },
  filePath: {
    color: "#636366",
    fontSize: 12,
    paddingHorizontal: 16,
    paddingVertical: 6,
    backgroundColor: "#1C1C1E",
  },
  codeScroll: {
    flex: 1,
  },
  codeScrollContent: {
    minWidth: "100%",
  },
  codeInner: {
    padding: 12,
  },
  codeText: {
    color: "#E5E5EA",
    fontSize: 12,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    lineHeight: 18,
  },
  errorContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
  },
  errorText: {
    color: "#FF453A",
    fontSize: 14,
    textAlign: "center",
  },
  loadingContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  loadingText: {
    color: "#8E8E93",
    fontSize: 14,
  },
});
