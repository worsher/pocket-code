import React from "react";
import {
  View,
  Text,
  TouchableOpacity,
  TextInput,
  StyleSheet,
  ActivityIndicator,
} from "react-native";

interface Props {
  searchQuery: string;
  onSearchChange: (query: string) => void;
  onRefresh: () => void;
  onSync?: () => Promise<void>;
  syncAvailable?: boolean;
  syncing?: boolean;
  lastSyncTime?: number;
}

export default function FilesToolbar({
  searchQuery,
  onSearchChange,
  onRefresh,
  onSync,
  syncAvailable = false,
  syncing = false,
  lastSyncTime,
}: Props) {
  const handleSync = async () => {
    if (!onSync || syncing) return;
    await onSync();
  };

  return (
    <View style={styles.container}>
      {/* Search input */}
      <View style={styles.searchContainer}>
        <Text style={styles.searchIcon}>🔍</Text>
        <TextInput
          style={styles.searchInput}
          placeholder="搜索文件..."
          placeholderTextColor="#636366"
          value={searchQuery}
          onChangeText={onSearchChange}
          autoCapitalize="none"
          autoCorrect={false}
          clearButtonMode="while-editing"
        />
      </View>

      {/* Actions */}
      <View style={styles.actions}>
        <TouchableOpacity style={styles.actionBtn} onPress={onRefresh}>
          <Text style={styles.actionIcon}>🔄</Text>
        </TouchableOpacity>

        {syncAvailable && (
          <TouchableOpacity
            style={[styles.actionBtn, styles.syncBtn]}
            onPress={handleSync}
            disabled={syncing}
          >
            {syncing ? (
              <ActivityIndicator size="small" color="#007AFF" />
            ) : (
              <Text style={styles.actionIcon}>☁️</Text>
            )}
          </TouchableOpacity>
        )}
      </View>

      {/* Last sync info */}
      {lastSyncTime && (
        <Text style={styles.syncInfo}>
          上次同步: {new Date(lastSyncTime).toLocaleString()}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: 0.5,
    borderBottomColor: "#38383A",
  },
  searchContainer: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#1C1C1E",
    borderRadius: 8,
    paddingHorizontal: 10,
    height: 36,
  },
  searchIcon: {
    fontSize: 14,
    marginRight: 6,
  },
  searchInput: {
    flex: 1,
    color: "#FFFFFF",
    fontSize: 14,
    padding: 0,
  },
  actions: {
    flexDirection: "row",
    marginTop: 8,
    gap: 8,
  },
  actionBtn: {
    width: 36,
    height: 36,
    borderRadius: 8,
    backgroundColor: "#1C1C1E",
    justifyContent: "center",
    alignItems: "center",
  },
  syncBtn: {
    width: 36,
  },
  actionIcon: {
    fontSize: 16,
  },
  syncInfo: {
    color: "#636366",
    fontSize: 11,
    marginTop: 4,
  },
});
