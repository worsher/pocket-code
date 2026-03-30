import React, { useEffect } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  ActivityIndicator,
} from "react-native";
import { useFileTree, type FileItem } from "../../../hooks/useFileTree";

interface Props {
  requestFileList: (path: string) => Promise<any>;
  onFilePress: (item: FileItem) => void;
  searchQuery?: string;
}

export default function FileTreeView({
  requestFileList,
  onFilePress,
  searchQuery,
}: Props) {
  const {
    flatFiles,
    loading,
    loadError,
    loadRootFiles,
    toggleDirectory,
  } = useFileTree({ requestFileList });

  useEffect(() => {
    loadRootFiles();
  }, [loadRootFiles]);

  // Client-side search filter
  const displayFiles = searchQuery
    ? flatFiles.filter(({ item }) =>
        item.name.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : flatFiles;

  const renderItem = ({
    item: { item, depth },
  }: {
    item: { item: FileItem; depth: number };
  }) => {
    const isDir = item.type === "directory";
    const icon = isDir ? (item.expanded ? "📂" : "📁") : "📄";

    return (
      <TouchableOpacity
        style={[styles.fileRow, { paddingLeft: 16 + depth * 20 }]}
        onPress={() => (isDir ? toggleDirectory(item) : onFilePress(item))}
      >
        <Text style={styles.fileIcon}>{icon}</Text>
        <Text
          style={[styles.fileName, isDir && styles.dirName]}
          numberOfLines={1}
        >
          {item.name}
          {isDir ? "/" : ""}
        </Text>
      </TouchableOpacity>
    );
  };

  if (loading) {
    return (
      <View style={styles.centerContainer}>
        <ActivityIndicator color="#007AFF" />
        <Text style={styles.hintText}>加载中...</Text>
      </View>
    );
  }

  if (loadError) {
    return (
      <View style={styles.centerContainer}>
        <Text style={styles.errorText}>加载失败</Text>
        <Text style={styles.hintText}>{loadError}</Text>
        <TouchableOpacity style={styles.retryBtn} onPress={loadRootFiles}>
          <Text style={styles.retryText}>重试</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (displayFiles.length === 0) {
    return (
      <View style={styles.centerContainer}>
        <Text style={styles.errorText}>
          {searchQuery ? "无匹配文件" : "工作区为空"}
        </Text>
        <Text style={styles.hintText}>
          {searchQuery
            ? "尝试其他关键词"
            : "通过对话让 AI 创建文件后刷新查看"}
        </Text>
        {!searchQuery && (
          <TouchableOpacity style={styles.retryBtn} onPress={loadRootFiles}>
            <Text style={styles.retryText}>刷新</Text>
          </TouchableOpacity>
        )}
      </View>
    );
  }

  return (
    <FlatList
      data={displayFiles}
      renderItem={renderItem}
      keyExtractor={(item) => item.item.path}
      contentContainerStyle={styles.list}
      showsVerticalScrollIndicator={false}
    />
  );
}

const styles = StyleSheet.create({
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
  centerContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
  },
  errorText: {
    color: "#636366",
    fontSize: 15,
    marginBottom: 8,
  },
  hintText: {
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
