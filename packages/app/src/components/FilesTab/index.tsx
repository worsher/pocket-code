import React, { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { View, Text, StyleSheet, Alert, ActivityIndicator } from "react-native";
import FileTreeView from "./components/FileTreeView";
import InlineFileViewer from "./components/InlineFileViewer";
import FilesToolbar from "./components/FilesToolbar";
import FileTabBar from "./components/FileTabBar";
import type { FileItem } from "../../hooks/useFileTree";
import type { WorkspaceMode, AppSettings } from "../../store/settings";
import { syncRemoteToLocal } from "../../services/workspaceSync";
import { getProjectWorkspaceRoot } from "../../services/localFileSystem";
import { useWorkspace } from "../../contexts/WorkspaceContext";

interface Props {
  requestFileList: (path: string) => Promise<any>;
  requestFileContent: (path: string) => Promise<any>;
  writeFile?: (path: string, content: string) => Promise<{ success: boolean; error?: string }>;
  workspaceMode: WorkspaceMode;
  settings: AppSettings;
  projectId?: string;
}

/**
 * Check whether we have enough config to connect to a remote server for sync.
 * Works with: Relay (relayToken), Cloud server (authToken), or Tool server.
 */
function canSyncRemote(settings: AppSettings): boolean {
  const hasRelay = !!settings.relayToken && !!settings.relayMachineId && !!settings.relayServerUrl;
  const hasCloud = !!settings.cloudServerUrl && !!settings.authToken;
  const hasTool = !!settings.toolServerUrl;
  return hasRelay || hasCloud || hasTool;
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
  const [openFiles, setOpenFiles] = useState<FileItem[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [lastSyncTime, setLastSyncTime] = useState<number | undefined>();
  const [refreshKey, setRefreshKey] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | undefined>();

  // Track which projects have already been auto-sync checked
  const autoSyncChecked = useRef<Set<string>>(new Set());

  const { fileChanges, pendingFilePath, clearPendingFile } = useWorkspace();

  // Auto-refresh file tree when AI modifies files
  const lastChangeCountRef = useRef(fileChanges.length);
  useEffect(() => {
    if (fileChanges.length > lastChangeCountRef.current) {
      lastChangeCountRef.current = fileChanges.length;
      // Debounce: only refresh once per batch of changes
      setRefreshKey((k) => k + 1);
    }
  }, [fileChanges.length]);

  const isLocal = workspaceMode === "local";
  const isEditable = isLocal && !!writeFile;

  const syncAvailable = isLocal && !!projectId && canSyncRemote(settings);

  const localWorkspaceRoot = useMemo(
    () => getProjectWorkspaceRoot(projectId),
    [projectId]
  );

  const doSync = useCallback(async (silent: boolean = false) => {
    if (!projectId) return false;
    setSyncing(true);

    try {
      const result = await syncRemoteToLocal(
        settings,
        projectId,
        localWorkspaceRoot,
        (msg) => setSyncMessage(msg)
      );

      if (result.success) {
        setLastSyncTime(Date.now());
        setRefreshKey((k) => k + 1);
        if (!silent) {
          Alert.alert("同步成功", `已同步 ${result.fileCount || 0} 个文件`);
        }
        return true;
      } else {
        if (!silent) {
          Alert.alert("同步失败", result.error || "未知错误");
        }
        return false;
      }
    } catch (err: any) {
      if (!silent) {
        Alert.alert("同步失败", err.message);
      }
      return false;
    } finally {
      setSyncing(false);
      setSyncMessage(undefined);
    }
  }, [settings, projectId, localWorkspaceRoot]);

  // Auto-sync: when entering local mode with sync available, check if workspace is empty
  useEffect(() => {
    if (!syncAvailable || !projectId) return;
    if (autoSyncChecked.current.has(projectId)) return;

    autoSyncChecked.current.add(projectId);

    (async () => {
      try {
        const result = await requestFileList(".");
        const items = result?.items || [];
        if (items.length === 0) {
          await doSync(true);
        }
      } catch {
        // Workspace doesn't exist → trigger sync
        await doSync(true);
      }
    })();
  }, [syncAvailable, projectId, requestFileList, doSync]);

  const MAX_OPEN_FILES = 5;

  const openFile = useCallback((item: FileItem) => {
    setSelectedFile(item);
    setViewState("viewer");
    setOpenFiles((prev) => {
      if (prev.some((f) => f.path === item.path)) return prev;
      const updated = [...prev, item];
      return updated.length > MAX_OPEN_FILES ? updated.slice(-MAX_OPEN_FILES) : updated;
    });
  }, []);

  const handleFilePress = useCallback((item: FileItem) => {
    openFile(item);
  }, [openFile]);

  const handleTabSelect = useCallback((file: FileItem) => {
    setSelectedFile(file);
  }, []);

  const handleTabClose = useCallback((file: FileItem) => {
    setOpenFiles((prev) => {
      const updated = prev.filter((f) => f.path !== file.path);
      // If closing the active file, switch to the previous tab or tree
      if (selectedFile?.path === file.path) {
        if (updated.length > 0) {
          setSelectedFile(updated[updated.length - 1]);
        } else {
          setSelectedFile(null);
          setViewState("tree");
        }
      }
      return updated;
    });
  }, [selectedFile]);

  // Navigate to file when pendingFilePath is set (from chat file path click)
  useEffect(() => {
    if (!pendingFilePath) return;
    const fileName = pendingFilePath.split("/").pop() || pendingFilePath;
    openFile({ name: fileName, type: "file", path: pendingFilePath });
    clearPendingFile();
  }, [pendingFilePath, clearPendingFile, openFile]);

  const handleBack = useCallback(() => {
    setViewState("tree");
    setSelectedFile(null);
  }, []);

  const handleRefresh = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  const handleManualSync = useCallback(async () => {
    await doSync(false);
  }, [doSync]);

  return (
    <View style={styles.container}>
      {/* Syncing overlay */}
      {syncing && (
        <View style={styles.syncOverlay}>
          <ActivityIndicator size="large" color="#007AFF" />
          <Text style={styles.syncOverlayText}>{syncMessage || "同步中..."}</Text>
        </View>
      )}

      {viewState === "tree" ? (
        <>
          <FilesToolbar
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            onRefresh={handleRefresh}
            onSync={syncAvailable ? handleManualSync : undefined}
            syncAvailable={syncAvailable}
            syncing={syncing}
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
        <>
          <FileTabBar
            openFiles={openFiles}
            activeFile={selectedFile}
            onSelectFile={handleTabSelect}
            onCloseFile={handleTabClose}
          />
          <InlineFileViewer
            file={selectedFile}
            requestFileContent={requestFileContent}
            onBack={handleBack}
            editable={isEditable}
            onSave={writeFile}
          />
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#000000",
  },
  syncOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 10,
    backgroundColor: "rgba(0,0,0,0.7)",
    justifyContent: "center",
    alignItems: "center",
    gap: 12,
  },
  syncOverlayText: {
    color: "#FFFFFF",
    fontSize: 15,
    fontWeight: "500",
    textAlign: "center",
    paddingHorizontal: 24,
  },
});
