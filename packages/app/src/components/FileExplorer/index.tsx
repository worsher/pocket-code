import React, { useState, useEffect, useRef } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  Modal,
  Animated,
  Dimensions,
  ActivityIndicator,
} from "react-native";
import FileViewer from "../FileViewer";
import { useFileTree, type FileItem } from "../../hooks/useFileTree";

const SCREEN_WIDTH = Dimensions.get("window").width;
const PANEL_WIDTH = SCREEN_WIDTH * 0.85;

interface Props {
  visible: boolean;
  onClose: () => void;
  requestFileList: (path: string) => Promise<any>;
  requestFileContent: (path: string) => Promise<any>;
}

export default function FileExplorer({
  visible,
  onClose,
  requestFileList,
  requestFileContent,
}: Props) {
  const {
    flatFiles,
    loading,
    loadError,
    loadRootFiles,
    toggleDirectory,
  } = useFileTree({ requestFileList });

  const [viewerVisible, setViewerVisible] = useState(false);
  const [viewerPath, setViewerPath] = useState("");
  const [viewerContent, setViewerContent] = useState<string | null>(null);
  const [viewerError, setViewerError] = useState<string | undefined>();
  const slideAnim = useRef(new Animated.Value(PANEL_WIDTH)).current;

  useEffect(() => {
    if (visible) {
      loadRootFiles();
      Animated.timing(slideAnim, {
        toValue: 0,
        duration: 250,
        useNativeDriver: true,
      }).start();
    } else {
      Animated.timing(slideAnim, {
        toValue: PANEL_WIDTH,
        duration: 200,
        useNativeDriver: true,
      }).start();
    }
  }, [visible]);

  const openFile = async (item: FileItem) => {
    setViewerPath(item.path);
    setViewerContent(null);
    setViewerError(undefined);
    setViewerVisible(true);

    try {
      const result = await requestFileContent(item.path);
      if (result.success) {
        setViewerContent(result.content);
      } else {
        setViewerError(result.error || "Unable to read file");
      }
    } catch (err: any) {
      setViewerError(err.message);
    }
  };

  const renderItem = ({ item: { item, depth } }: { item: { item: FileItem; depth: number } }) => {
    const isDir = item.type === "directory";
    const icon = isDir ? (item.expanded ? "📂" : "📁") : "📄";

    return (
      <TouchableOpacity
        style={[styles.fileRow, { paddingLeft: 16 + depth * 20 }]}
        onPress={() => (isDir ? toggleDirectory(item) : openFile(item))}
      >
        <Text style={styles.fileIcon}>{icon}</Text>
        <Text style={[styles.fileName, isDir && styles.dirName]} numberOfLines={1}>
          {item.name}{isDir ? "/" : ""}
        </Text>
      </TouchableOpacity>
    );
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      onRequestClose={onClose}
    >
      <View style={styles.overlay}>
        {/* Backdrop */}
        <TouchableOpacity
          style={styles.backdrop}
          activeOpacity={1}
          onPress={onClose}
        />

        {/* Panel (slides from right) */}
        <Animated.View
          style={[
            styles.panel,
            { transform: [{ translateX: slideAnim }] },
          ]}
        >
          {/* Header */}
          <View style={styles.header}>
            <Text style={styles.headerTitle}>文件</Text>
            <TouchableOpacity onPress={loadRootFiles}>
              <Text style={styles.refreshBtn}>刷新</Text>
            </TouchableOpacity>
          </View>

          {/* File List */}
          {loading ? (
            <View style={styles.loadingContainer}>
              <ActivityIndicator color="#007AFF" />
              <Text style={styles.loadingText}>加载中...</Text>
            </View>
          ) : loadError ? (
            <View style={styles.emptyContainer}>
              <Text style={styles.emptyText}>加载失败</Text>
              <Text style={styles.emptyHint}>{loadError}</Text>
              <TouchableOpacity style={styles.retryBtn} onPress={loadRootFiles}>
                <Text style={styles.retryText}>重试</Text>
              </TouchableOpacity>
            </View>
          ) : flatFiles.length === 0 ? (
            <View style={styles.emptyContainer}>
              <Text style={styles.emptyText}>工作区为空</Text>
              <Text style={styles.emptyHint}>
                通过对话让 AI 创建文件后刷新查看
              </Text>
            </View>
          ) : (
            <FlatList
              data={flatFiles}
              renderItem={renderItem}
              keyExtractor={(item) => item.item.path}
              contentContainerStyle={styles.list}
              showsVerticalScrollIndicator={false}
            />
          )}
        </Animated.View>
      </View>

      {/* File Viewer */}
      <FileViewer
        visible={viewerVisible}
        path={viewerPath}
        content={viewerContent}
        error={viewerError}
        onClose={() => setViewerVisible(false)}
      />
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    flexDirection: "row",
  },
  backdrop: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0,0,0,0.5)",
  },
  panel: {
    position: "absolute",
    right: 0,
    top: 0,
    bottom: 0,
    width: PANEL_WIDTH,
    backgroundColor: "#1C1C1E",
    paddingTop: 60,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: 0.5,
    borderBottomColor: "#38383A",
  },
  headerTitle: {
    color: "#FFFFFF",
    fontSize: 18,
    fontWeight: "700",
  },
  refreshBtn: {
    color: "#007AFF",
    fontSize: 14,
    fontWeight: "500",
  },
  list: {
    padding: 4,
  },
  fileRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    paddingRight: 16,
  },
  fileIcon: {
    fontSize: 16,
    marginRight: 8,
  },
  fileName: {
    color: "#E5E5EA",
    fontSize: 14,
    flex: 1,
  },
  dirName: {
    color: "#007AFF",
    fontWeight: "500",
  },
  loadingContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    gap: 8,
  },
  loadingText: {
    color: "#8E8E93",
    fontSize: 14,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
  },
  emptyText: {
    color: "#636366",
    fontSize: 15,
    marginBottom: 8,
  },
  emptyHint: {
    color: "#48484A",
    fontSize: 13,
    textAlign: "center",
  },
  retryBtn: {
    marginTop: 16,
    backgroundColor: "#007AFF",
    paddingHorizontal: 20,
    paddingVertical: 8,
    borderRadius: 8,
  },
  retryText: {
    color: "#FFFFFF",
    fontSize: 14,
    fontWeight: "500",
  },
});
