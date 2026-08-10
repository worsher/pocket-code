import React, { useState, useCallback, useEffect, useRef } from "react";
import { View, Text, StyleSheet, Alert, ActivityIndicator } from "react-native";
import FileTreeView from "./components/FileTreeView";
import InlineFileViewer from "./components/InlineFileViewer";
import FilesToolbar from "./components/FilesToolbar";
import FileTabBar from "./components/FileTabBar";
import type { FileItem } from "../../hooks/useFileTree";
import type { WorkspaceMode, AppSettings } from "../../store/settings";
import { syncRemoteToLocal } from "../../services/workspaceSync";
import { listLocalFiles, readLocalFile } from "../../services/localFileSystem";
import type { MobileWorkspaceTarget } from "../../services/localFileSystem";
import { pullFromDevMachine } from "../../services/codeSync";
import { useWorkspace } from "../../contexts/WorkspaceContext";
import { useProject } from "../../contexts/ProjectContext";
import type { WorkspaceHandle } from "@pocket-code/workspace-core";
import { getProjectSyncEdge, type RemoteReplicaCatalogEntry } from "../../store/projectCatalog";
import { getWorkspaceConnectionKey } from "../../services/workspaceConnection";
import { WORKSPACE_FEATURE_FLAGS } from "../../services/workspaceFeatureFlags";

interface Props {
  requestFileList: (path: string) => Promise<any>;
  requestFileContent: (path: string) => Promise<any>;
  writeFile?: (path: string, content: string) => Promise<{ success: boolean; error?: string }>;
  /** 影子快照同步(server/relay 模式从开发机拉代码到手机本地工作区)。 */
  requestSyncPull?: (sinceCommit?: string) => Promise<any>;
  requestSyncFile?: (commit: string, path: string) => Promise<any>;
  /** agent 是否正在流式输出;用于"一轮结束自动增量同步"(活动文件快路径)。 */
  isStreaming?: boolean;
  workspaceMode: WorkspaceMode;
  settings: AppSettings;
  projectId?: string;
  localWorkspaceTarget: MobileWorkspaceTarget;
  localWorkspaceHandle: WorkspaceHandle | null;
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
  requestSyncPull,
  requestSyncFile,
  isStreaming,
  workspaceMode,
  settings,
  projectId,
  localWorkspaceTarget,
  localWorkspaceHandle,
}: Props) {
  const { currentProject, updateProject, updateSyncEdge, saveLocalReplicaCopy } = useProject();
  const [viewState, setViewState] = useState<"tree" | "viewer">("tree");
  const [selectedFile, setSelectedFile] = useState<FileItem | null>(null);
  const [openFiles, setOpenFiles] = useState<FileItem[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [lastSyncTime, setLastSyncTime] = useState<number | undefined>();
  const [refreshKey, setRefreshKey] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | undefined>();
  // 影子同步成功后浏览手机本地副本(而非远端),让同步的文件在 UI 可见。
  const [browseLocal, setBrowseLocal] = useState(false);

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

  // 影子快照同步:已连接开发机(server/relay 模式)且 useAgent 提供了 sync 请求函数
  const connectionKey = getWorkspaceConnectionKey(settings);
  const remoteReplica: RemoteReplicaCatalogEntry | undefined = currentProject?.remoteReplicas
    ?.filter((replica) => replica.connectionKey === connectionKey)
    .sort((left, right) => right.updatedAt - left.updatedAt)[0];
  const syncEdge =
    currentProject && remoteReplica
      ? getProjectSyncEdge(currentProject, remoteReplica.id)
      : undefined;
  const shadowSyncAvailable =
    !isLocal &&
    currentProject?.importSource?.mode !== "git" &&
    !!projectId &&
    !!requestSyncPull &&
    !!requestSyncFile &&
    !!localWorkspaceHandle &&
    !!remoteReplica;
  const syncAvailable =
    WORKSPACE_FEATURE_FLAGS.syncV2 &&
    currentProject?.importSource?.mode !== "git" &&
    ((isLocal && !!projectId && canSyncRemote(settings)) || shadowSyncAvailable);

  // 浏览源:browseLocal(影子同步后)用手机本地副本,否则用传入的远端/本地函数。
  const effectiveRequestFileList = useCallback(
    (path: string) =>
      browseLocal ? listLocalFiles(path, localWorkspaceTarget) : requestFileList(path),
    [browseLocal, localWorkspaceTarget, requestFileList]
  );
  const effectiveRequestFileContent = useCallback(
    (path: string) =>
      browseLocal ? readLocalFile(path, localWorkspaceTarget) : requestFileContent(path),
    [browseLocal, localWorkspaceTarget, requestFileContent]
  );

  const doSync = useCallback(
    async (silent: boolean = false) => {
      if (!projectId) return false;
      setSyncing(true);

      try {
        // ── 影子快照同步:server/relay 模式从开发机拉代码到手机本地工作区 ──
        if (
          !isLocal &&
          requestSyncPull &&
          requestSyncFile &&
          localWorkspaceHandle &&
          remoteReplica
        ) {
          const runPull = (options?: {
            forceRemote?: boolean;
            conflictResolution?: "keep-local" | "keep-remote" | "save-copy";
          }) =>
            pullFromDevMachine({
              requestSyncPull,
              requestSyncFile,
              projectId,
              workspaceHandle: localWorkspaceHandle,
              remoteReplica,
              edge: syncEdge,
              legacyRemoteRef: currentProject?.lastSyncedCommit ?? null,
              persistEdge: (edge) => updateSyncEdge(projectId, edge),
              forceRemote: options?.forceRemote,
              conflictResolution: options?.conflictResolution,
              onProgress: (m) => setSyncMessage(m),
            });
          const result = await runPull();
          if (result.commit) {
            await updateProject(projectId, {
              // Retained for mixed-version clients only. New sync reads edge.baseRemoteRef.
              lastSyncedCommit: result.commit,
              lastSyncTime: Date.now(),
            });
            setLastSyncTime(Date.now());
            setBrowseLocal(true); // 同步后浏览本地副本
            setRefreshKey((k) => k + 1);
          }
          if (result.conflict && !silent) {
            const keepLocal = async () => {
              if (result.edge) {
                await updateSyncEdge(projectId, {
                  ...result.edge,
                  conflict: { ...result.conflict!, resolution: "keep-local" },
                  updatedAt: Date.now(),
                });
              }
              setBrowseLocal(true);
              Alert.alert("已保留本地", "自动同步保持冻结；切换写者或导出前不会覆盖远端。 ");
            };
            const acceptRemote = async (resolution: "keep-remote" | "save-copy") => {
              try {
                if (resolution === "save-copy") {
                  const copy = await saveLocalReplicaCopy(projectId);
                  Alert.alert("已另存本地副本", `已创建“${copy.name}”，原项目将继续使用远端版本。`);
                }
                const forced = await runPull({ forceRemote: true, conflictResolution: resolution });
                if (!forced.success) throw new Error(forced.error ?? "远端版本应用失败");
                await updateProject(projectId, {
                  lastSyncedCommit: forced.commit,
                  lastSyncTime: Date.now(),
                });
                setBrowseLocal(true);
                setRefreshKey((key) => key + 1);
              } catch (error) {
                Alert.alert("冲突处理失败", error instanceof Error ? error.message : "未知错误");
              }
            };
            Alert.alert("检测到同步冲突", "本地副本与远端都已变化，自动写入已冻结。", [
              { text: "保留本地", onPress: () => void keepLocal() },
              {
                text: "使用远端",
                style: "destructive",
                onPress: () => void acceptRemote("keep-remote"),
              },
              { text: "本地另存副本", onPress: () => void acceptRemote("save-copy") },
            ]);
            return false;
          }
          if (!silent) {
            if (result.success || result.commit) {
              const tail = result.failed.length ? `，失败 ${result.failed.length}` : "";
              Alert.alert("同步成功", `写入 ${result.applied}，删除 ${result.deleted}${tail}`);
            } else {
              Alert.alert("同步失败", result.error || "未知错误");
            }
          }
          return result.success;
        }

        // ── geek+local 模式:原有远端→本地同步 ──
        const result = await syncRemoteToLocal(settings, projectId, localWorkspaceTarget, (msg) =>
          setSyncMessage(msg)
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
    },
    [
      settings,
      projectId,
      localWorkspaceTarget,
      localWorkspaceHandle,
      isLocal,
      requestSyncPull,
      requestSyncFile,
      currentProject,
      updateProject,
      updateSyncEdge,
      saveLocalReplicaCopy,
      remoteReplica,
      syncEdge,
    ]
  );

  // Auto-sync: when entering local mode with sync available, check if workspace is empty
  useEffect(() => {
    if (!syncAvailable || !projectId) return;
    const syncCheckKey = `${projectId}:${connectionKey ?? "local"}`;
    if (autoSyncChecked.current.has(syncCheckKey)) return;

    autoSyncChecked.current.add(syncCheckKey);

    (async () => {
      try {
        const result = shadowSyncAvailable
          ? await listLocalFiles(".", localWorkspaceTarget)
          : await requestFileList(".");
        const items = result?.items || [];
        if (items.length === 0) {
          await doSync(true);
        }
      } catch {
        // Workspace doesn't exist → trigger sync
        await doSync(true);
      }
    })();
  }, [
    syncAvailable,
    shadowSyncAvailable,
    projectId,
    connectionKey,
    localWorkspaceTarget,
    requestFileList,
    doSync,
  ]);

  // ── 活动文件快路径 ──
  // agent 一轮结束(isStreaming true→false)后,若已在浏览本地副本,自动增量同步,
  // 把开发机的改动很快反映到手机本地视图。用 ref 持有最新条件/动作,effect 只
  // 依赖 isStreaming,从而仅在流式状态切换时触发、且不读到陈旧闭包。
  const liveSyncRef = useRef<{ enabled: boolean; run: () => void }>({
    enabled: false,
    run: () => {},
  });
  liveSyncRef.current = {
    enabled:
      browseLocal &&
      !isLocal &&
      !!requestSyncPull &&
      !!requestSyncFile &&
      !!currentProject?.lastSyncedCommit &&
      !syncing,
    run: () => {
      doSync(true);
    },
  };
  const prevStreamingRef = useRef(isStreaming);
  useEffect(() => {
    const justFinished = prevStreamingRef.current && !isStreaming;
    prevStreamingRef.current = isStreaming;
    if (justFinished && liveSyncRef.current.enabled) {
      liveSyncRef.current.run();
    }
  }, [isStreaming]);

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

  const handleFilePress = useCallback(
    (item: FileItem) => {
      openFile(item);
    },
    [openFile]
  );

  const handleTabSelect = useCallback((file: FileItem) => {
    setSelectedFile(file);
  }, []);

  const handleTabClose = useCallback(
    (file: FileItem) => {
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
    },
    [selectedFile]
  );

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
            requestFileList={effectiveRequestFileList}
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
            requestFileContent={effectiveRequestFileContent}
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
