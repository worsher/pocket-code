import React, { useState, useCallback, useMemo } from "react";
import { View, StyleSheet, Alert } from "react-native";
import FileTreeView from "./components/FileTreeView";
import InlineFileViewer from "./components/InlineFileViewer";
import FilesToolbar from "./components/FilesToolbar";
import type { FileItem } from "../../hooks/useFileTree";
import type { WorkspaceMode, AppSettings } from "../../store/settings";
import { syncWorkspaceFromServer } from "../../services/fileTransfer";
import { getProjectWorkspaceRoot } from "../../services/localFileSystem";

interface Props {
  requestFileList: (path: string) => Promise<any>;
  requestFileContent: (path: string) => Promise<any>;
  writeFile?: (path: string, content: string) => Promise<{ success: boolean; error?: string }>;
  workspaceMode: WorkspaceMode;
  settings: AppSettings;
  projectId?: string;
}

/** Get the server URL to use for sync based on settings */
function getSyncServerUrl(settings: AppSettings): string | undefined {
  // Prefer cloud server URL, fall back to tool server URL
  if (settings.cloudServerUrl) return settings.cloudServerUrl;
  if (settings.toolServerUrl) return settings.toolServerUrl;
  return undefined;
}

export default function FilesTab({
  requestFileList,
  requestFileContent,
  writeFile,
  workspaceMode,
  settings,
  projectId,
}: Props) {
  const [viewState, setViewState] = useState<"tree" | "viewer">("tree");
  const [selectedFile, setSelectedFile] = useState<FileItem | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [lastSyncTime, setLastSyncTime] = useState<number | undefined>();
  const [refreshKey, setRefreshKey] = useState(0);

  const isLocal = workspaceMode === "local";
  const isEditable = isLocal && !!writeFile;

  const syncServerUrl = useMemo(() => getSyncServerUrl(settings), [settings]);

  // Check if sync from cloud is available (local mode + has server URL + has auth)
  const syncAvailable = isLocal && !!syncServerUrl && !!settings.authToken && !!projectId;

  const handleFilePress = useCallback((item: FileItem) => {
    setSelectedFile(item);
    setViewState("viewer");
  }, []);

  const handleBack = useCallback(() => {
    setViewState("tree");
    setSelectedFile(null);
  }, []);

  const handleRefresh = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  const localWorkspaceRoot = useMemo(
    () => getProjectWorkspaceRoot(projectId),
    [projectId]
  );

  const handleSync = useCallback(async () => {
    if (!syncServerUrl || !projectId) return;

    try {
      const result = await syncWorkspaceFromServer(
        syncServerUrl,
        settings.authToken || "",
        projectId,
        localWorkspaceRoot
      );

      if (result.success) {
        setLastSyncTime(Date.now());
        setRefreshKey((k) => k + 1);
        Alert.alert("同步成功", `已同步 ${result.fileCount || 0} 个文件`);
      } else {
        Alert.alert("同步失败", result.error || "Unknown error");
      }
    } catch (err: any) {
      Alert.alert("同步失败", err.message);
    }
  }, [syncServerUrl, settings.authToken, projectId, localWorkspaceRoot]);

  return (
    <View style={styles.container}>
      {viewState === "tree" ? (
        <>
          <FilesToolbar
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            onRefresh={handleRefresh}
            onSync={syncAvailable ? handleSync : undefined}
            syncAvailable={syncAvailable}
            lastSyncTime={lastSyncTime}
          />
          <FileTreeView
            key={refreshKey}
            requestFileList={requestFileList}
            onFilePress={handleFilePress}
            searchQuery={searchQuery || undefined}
          />
        </>
      ) : selectedFile ? (
        <InlineFileViewer
          file={selectedFile}
          requestFileContent={requestFileContent}
          onBack={handleBack}
          editable={isEditable}
          onSave={writeFile}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#000000",
  },
});
