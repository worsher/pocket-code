// ── Project Drawer ───────────────────────────────────────
// A slide-out drawer for switching between projects.

import React, { useEffect, useRef, useState } from "react";
import { View, Text, TouchableOpacity, FlatList, TextInput, StyleSheet, Alert } from "react-native";
import { randomUUID } from "expo-crypto";
import { useProject } from "../../contexts/ProjectContext";
import type { Project } from "../../store/projects";
import type { AppSettings, GitCredentialProfile } from "../../store/settings";
import {
  getWorkspaceConnectionKey,
  usesRemoteWorkspace,
} from "../../services/workspaceConnection";
import type {
  LinkedWorkspaceImportResponse,
  GitCredentialResponse,
  GitOperationResponse,
  WorkspaceLegacyCleanupResponse,
  WorkspaceSourceStatusResponse,
} from "@pocket-code/client-core";
import { recordWorkspaceMetric } from "../../services/workspaceTelemetry";
import {
  matchingGitCredentialProfiles,
  normalizeGitRemoteHttpsUrl,
  resolveGitCredentialProfile,
} from "../../services/gitCredentialProfiles";

interface Props {
  monitoringEnabled: boolean;
  onSelectProject?: (projectId: string) => void;
  onEditPrompt?: () => void;
  onDeleteWorkspace?: (projectId: string) => void;
  settings: AppSettings;
  onBindLinkedWorkspace: (args: {
    projectId: string;
    displayName?: string;
    path: string;
    allowWeakDuplicate?: boolean;
  }) => Promise<LinkedWorkspaceImportResponse>;
  onInspectLinkedSource: (projectId: string) => Promise<WorkspaceSourceStatusResponse>;
  onCleanupLegacyWorkspace: (
    projectId: string,
    legacyProjectId: string
  ) => Promise<WorkspaceLegacyCleanupResponse>;
  onTestGitCredential: (args: {
    profile: GitCredentialProfile;
    repositoryUrl: string;
    capability?: "read" | "write";
  }) => Promise<GitCredentialResponse>;
  onImportGitWorkspace: (args: {
    projectId: string;
    displayName?: string;
    repositoryUrl: string;
    profile: GitCredentialProfile;
    branch?: string;
  }) => Promise<LinkedWorkspaceImportResponse>;
  onRunGitWorkspaceOperation: (args: {
    projectId: string;
    operation: "status" | "pull" | "commit" | "push";
    profile: GitCredentialProfile;
    commitMessage?: string;
  }) => Promise<GitOperationResponse>;
}

type ProjectImportUiResult =
  | null
  | { status: "imported"; committed: Project }
  | { status: "blocked" | "confirmation-required"; existingProjectId: string };

export default function ProjectDrawer({
  monitoringEnabled,
  onSelectProject,
  onEditPrompt,
  onDeleteWorkspace,
  settings,
  onBindLinkedWorkspace,
  onInspectLinkedSource,
  onCleanupLegacyWorkspace,
  onTestGitCredential,
  onImportGitWorkspace,
  onRunGitWorkspaceOperation,
}: Props) {
  const {
    projects,
    currentProject,
    switchProject,
    updateProject,
    createProject,
    deleteProject,
    importDirectoryProject,
    importArchiveProject,
    importGitProject,
    registerLinkedProject,
    previewCopySource,
    applyCopySource,
    commitAndPushGitProject,
    pullGitProject,
    legacyCleanupAvailable,
    cleanupLegacyStorage,
  } = useProject();

  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [isImporting, setIsImporting] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [gitUrl, setGitUrl] = useState("");
  const [gitCredentialProfileId, setGitCredentialProfileId] = useState<string | undefined>();
  const [linkedPath, setLinkedPath] = useState("");
  const [linkedName, setLinkedName] = useState("");
  const [gitCommitMessage, setGitCommitMessage] = useState("Update from Pocket Code");
  const [gitTestCapability, setGitTestCapability] = useState<"read" | "write">("read");
  const [pendingLinkedProjectId, setPendingLinkedProjectId] = useState<string | null>(null);
  const [linkedSourceStatus, setLinkedSourceStatus] = useState<
    WorkspaceSourceStatusResponse | undefined
  >();
  const linkedStatusStateRef = useRef<WorkspaceSourceStatusResponse["state"] | undefined>(
    undefined
  );
  const remoteWorkspace = usesRemoteWorkspace(settings);

  useEffect(() => {
    if (
      !monitoringEnabled ||
      currentProject?.importSource?.mode !== "linked" ||
      settings.workspaceMode !== "relay"
    ) {
      linkedStatusStateRef.current = undefined;
      setLinkedSourceStatus(undefined);
      return;
    }
    linkedStatusStateRef.current = undefined;
    let active = true;
    const inspect = async () => {
      try {
        const status = await onInspectLinkedSource(currentProject.id);
        if (active) {
          if (
            status.state === "permission-lost" &&
            linkedStatusStateRef.current !== "permission-lost"
          ) {
            void recordWorkspaceMetric("permission-lost").catch(() => undefined);
          }
          linkedStatusStateRef.current = status.state;
          setLinkedSourceStatus(status);
        }
      } catch (error) {
        if (!active) return;
        setLinkedSourceStatus({
          type: "workspace-source-status",
          _reqId: "local-monitor",
          projectId: currentProject.id,
          state: "unsupported",
          checkedAt: Date.now(),
          error: error instanceof Error ? error.message : "来源检查失败",
        });
      }
    };
    void inspect();
    const interval = setInterval(() => void inspect(), 30_000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [
    monitoringEnabled,
    currentProject?.id,
    currentProject?.importSource?.mode,
    settings.workspaceMode,
    onInspectLinkedSource,
  ]);

  const linkedStatusText = (status: WorkspaceSourceStatusResponse | undefined) => {
    switch (status?.state) {
      case "available":
        return "来源正常";
      case "permission-lost":
        return "权限已失效";
      case "moved":
        return "来源路径已移动";
      case "missing":
        return "来源已移动或删除";
      case "replaced":
        return "原路径已被其他目录替换";
      case "unsupported":
        return "当前连接无法检查来源";
      default:
        return "正在检查来源";
    }
  };

  const handleSelect = (projectId: string) => {
    switchProject(projectId);
    onSelectProject?.(projectId);
  };

  const handleCreate = () => {
    if (!newName.trim()) return;
    createProject(newName.trim(), newDesc.trim());
    setNewName("");
    setNewDesc("");
    setShowCreate(false);
  };

  const handleDelete = (project: Project) => {
    if (project.id === "default") return;
    Alert.alert(`删除项目`, `确定要删除 "${project.name}" 吗？`, [
      { text: "取消", style: "cancel" },
      {
        text: "删除（保留文件）",
        onPress: () => deleteProject(project.id),
      },
      {
        text:
          project.importSource?.mode === "linked" ? "移除绑定（保留原目录）" : "删除（含受管文件）",
        style: "destructive",
        onPress: () => {
          deleteProject(project.id);
          onDeleteWorkspace?.(project.id);
        },
      },
    ]);
  };

  const showImportError = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (/cancel/i.test(message)) return;
    const title = /permission|unavailable|EACCES|ENOENT/i.test(message)
      ? "来源不可用"
      : /free space|ENOSPC/i.test(message)
        ? "空间不足"
        : "导入失败";
    Alert.alert(title, message);
  };

  const handleImportResult = (result: ProjectImportUiResult, retry: () => void) => {
    if (!result) return;
    if (result.status === "imported") {
      onSelectProject?.(result.committed.id);
      setShowImport(false);
      return;
    }
    if (result.status === "blocked") {
      Alert.alert("来源已绑定", "该来源已被 linked 项目独占绑定，不能重复绑定。", [
        { text: "取消", style: "cancel" },
        { text: "打开已有项目", onPress: () => handleSelect(result.existingProjectId) },
      ]);
      return;
    }
    const existing = projects.find((project) => project.id === result.existingProjectId);
    Alert.alert(
      "可能重复导入",
      `该来源已用于项目“${existing?.name ?? "已有项目"}”。独立副本不会自动写回原路径；Git 项目仅通过 commit/push 回写。是否继续？`,
      [
        { text: "取消", style: "cancel" },
        { text: "继续导入", onPress: retry },
      ]
    );
  };

  const finishDirectoryImport = async (allowWeakDuplicate: boolean = false) => {
    setIsImporting(true);
    try {
      const result = await importDirectoryProject(allowWeakDuplicate);
      handleImportResult(result, () => void finishDirectoryImport(true));
    } catch (error) {
      showImportError(error);
    } finally {
      setIsImporting(false);
    }
  };

  const finishArchiveImport = async (allowWeakDuplicate: boolean = false) => {
    setIsImporting(true);
    try {
      const result = await importArchiveProject(allowWeakDuplicate);
      handleImportResult(result, () => void finishArchiveImport(true));
    } catch (error) {
      showImportError(error);
    } finally {
      setIsImporting(false);
    }
  };

  const finishGitImport = async (allowWeakDuplicate: boolean = false) => {
    if (!gitUrl.trim()) return;
    setIsImporting(true);
    try {
      if (remoteWorkspace) {
        const connectionKey = getWorkspaceConnectionKey(settings);
        if (!connectionKey) throw new Error("远端 Git 导入需要可用的 Server/Relay 连接");
        if (!gitCredentialProfileId) {
          throw new Error("远端 Git 导入一期必须选择已配置 Key 的凭据 Profile");
        }
        const repositoryUrl = normalizeGitRemoteHttpsUrl(gitUrl.trim());
        const profile = resolveGitCredentialProfile(
          repositoryUrl,
          settings.gitCredentialProfiles,
          gitCredentialProfileId
        );
        if (!profile) throw new Error("所选 Git Key 不可用");
        const projectId = randomUUID();
        const response = await onImportGitWorkspace({
          projectId,
          repositoryUrl,
          profile,
        });
        if (response.status === "error") throw new Error(response.error || "Git clone failed");
        if (response.status === "blocked") {
          Alert.alert("仓库已导入", "该远端仓库已绑定到现有项目。", [
            { text: "取消", style: "cancel" },
            ...(response.existingProjectId && projects.some((p) => p.id === response.existingProjectId)
              ? [{ text: "打开已有项目", onPress: () => handleSelect(response.existingProjectId!) }]
              : []),
          ]);
          return;
        }
        if (response.status !== "imported" || !response.project || !response.importSource) {
          throw new Error("远端未返回完整的 Git 项目元数据");
        }
        await registerLinkedProject({
          projectId: response.project.projectId,
          displayName: response.project.displayName,
          importSource: response.importSource,
          remoteReplica: {
            id: response.project.replicaId,
            generation: response.project.workspaceGeneration,
            kind: response.project.replicaKind,
            authorityId: response.project.authorityId,
            connectionKey,
            updatedAt: response.project.updatedAt,
          },
          gitUrl: repositoryUrl,
          gitCredentialProfileId: profile.id,
        });
        setShowImport(false);
        onSelectProject?.(response.project.projectId);
        return;
      }
      const result = await importGitProject(
        gitUrl.trim(),
        settings,
        gitCredentialProfileId,
        allowWeakDuplicate
      );
      handleImportResult(result, () => void finishGitImport(true));
    } catch (error) {
      showImportError(error);
    } finally {
      setIsImporting(false);
    }
  };

  const handleGitCredentialTest = async () => {
    if (!gitUrl.trim() || !gitCredentialProfileId) {
      Alert.alert("无法测试", "请输入 HTTPS 仓库 URL 并选择一个已保存 Key 的凭据。");
      return;
    }
    setIsImporting(true);
    try {
      const repositoryUrl = normalizeGitRemoteHttpsUrl(gitUrl.trim());
      const profile = resolveGitCredentialProfile(
        repositoryUrl,
        settings.gitCredentialProfiles,
        gitCredentialProfileId
      );
      if (!profile) throw new Error("所选 Git Key 不可用");
      const result = await onTestGitCredential({
        profile,
        repositoryUrl,
        capability: gitTestCapability,
      });
      const capabilities = result.capabilities;
      const detail = capabilities
        ? `读取 ${capabilities.read ? "通过" : "未通过"}，写入 ${capabilities.write ? "通过" : "未通过"}`
        : `${gitTestCapability === "write" ? "写入" : "读取"}权限已验证`;
      Alert.alert("Git Key 验证成功", detail);
    } catch (error) {
      Alert.alert(
        "Git Key 验证失败",
        error instanceof Error ? error.message : "请检查 Key 权限与仓库 URL"
      );
    } finally {
      setIsImporting(false);
    }
  };

  const finishLinkedImport = async (allowWeakDuplicate: boolean = false) => {
    if (!linkedPath.trim()) return;
    const connectionKey = getWorkspaceConnectionKey(settings);
    if (!connectionKey || settings.workspaceMode !== "relay") {
      Alert.alert("需要开发机连接", "linked 绑定仅支持已配对的 daemon/Relay 环境。");
      return;
    }
    setIsImporting(true);
    const projectId = pendingLinkedProjectId ?? randomUUID();
    setPendingLinkedProjectId(projectId);
    try {
      const result = await onBindLinkedWorkspace({
        projectId,
        displayName: linkedName.trim() || undefined,
        path: linkedPath.trim(),
        allowWeakDuplicate,
      });
      if (result.status === "error") throw new Error(result.error || "Linked binding failed");
      if (result.status === "blocked") {
        setPendingLinkedProjectId(null);
        Alert.alert("目录已绑定", "该物理目录已绑定到已有项目。", [
          { text: "取消", style: "cancel" },
          ...(result.existingProjectId && projects.some((p) => p.id === result.existingProjectId)
            ? [
                {
                  text: "打开已有项目",
                  onPress: () => handleSelect(result.existingProjectId!),
                },
              ]
            : []),
        ]);
        return;
      }
      if (result.status === "confirmation-required") {
        Alert.alert("可能重复绑定", "路径信号相同但缺少稳定文件 ID。是否仍要绑定？", [
          { text: "取消", style: "cancel" },
          { text: "继续绑定", onPress: () => void finishLinkedImport(true) },
        ]);
        return;
      }
      if (!result.project || !result.importSource) {
        throw new Error("Daemon returned incomplete linked project metadata");
      }
      await registerLinkedProject({
        projectId: result.project.projectId,
        displayName: result.project.displayName,
        importSource: result.importSource,
        remoteReplica: {
          id: result.project.replicaId,
          generation: result.project.workspaceGeneration,
          kind: result.project.replicaKind,
          authorityId: result.project.authorityId,
          connectionKey,
          updatedAt: result.project.updatedAt,
        },
      });
      setPendingLinkedProjectId(null);
      setShowImport(false);
      onSelectProject?.(result.project.projectId);
    } catch (error) {
      showImportError(error);
    } finally {
      setIsImporting(false);
    }
  };

  const summarizeCopyPreview = (
    direction: "reimport" | "write-back",
    preview: Awaited<ReturnType<typeof previewCopySource>>
  ) => {
    const counts = preview.changes.reduce(
      (value, change) => ({ ...value, [change.status]: value[change.status] + 1 }),
      { A: 0, M: 0, D: 0 }
    );
    const decision =
      preview.decision === "conflict"
        ? "受管副本和原始来源都已修改，继续会覆盖其中一侧。"
        : preview.decision === "workspace-ahead"
          ? direction === "reimport"
            ? "受管副本有新修改，重新导入会覆盖这些修改。"
            : "原始来源未变化，可以写回受管副本。"
          : preview.decision === "source-ahead"
            ? direction === "write-back"
              ? "原始来源有新修改，写回会覆盖这些修改。"
              : "受管副本未变化，可以重新导入来源。"
            : "两侧内容一致。";
    const examples = preview.changes
      .slice(0, 6)
      .map((change) => `${change.status} ${change.path}`)
      .join("\n");
    return `${decision}\n\n新增 ${counts.A}，修改 ${counts.M}，删除 ${counts.D}${examples ? `\n\n${examples}` : ""}`;
  };

  const handleCopySourceAction = async (project: Project, direction: "reimport" | "write-back") => {
    setIsImporting(true);
    try {
      const preview = await previewCopySource(project.id, direction);
      const title = direction === "reimport" ? "重新导入预览" : "写回原始来源预览";
      Alert.alert(title, summarizeCopyPreview(direction, preview), [
        { text: "取消", style: "cancel" },
        {
          text: direction === "reimport" ? "确认重新导入" : "确认写回",
          style: preview.changes.length ? "destructive" : "default",
          onPress: () => {
            setIsImporting(true);
            void applyCopySource(project.id, direction, true)
              .then(() => Alert.alert("来源同步完成", "写入与快照校验均已完成。"))
              .catch(showImportError)
              .finally(() => setIsImporting(false));
          },
        },
      ]);
    } catch (error) {
      showImportError(error);
    } finally {
      setIsImporting(false);
    }
  };

  const handleGitWriteBack = (project: Project) => {
    Alert.alert(
      "提交并推送 Git 项目",
      `将先暂存全部修改，创建提交“${gitCommitMessage.trim()}”，再推送 origin。不会使用文件覆盖协议。`,
      [
        { text: "取消", style: "cancel" },
        {
          text: "提交并推送",
          onPress: () => {
            setIsImporting(true);
            void (async () => {
              if (!remoteWorkspace) {
                return commitAndPushGitProject(project.id, settings, gitCommitMessage);
              }
              if (!project.gitUrl || !project.gitCredentialProfileId) {
                throw new Error("远端 Git 项目必须绑定一个可用的 Key Profile");
              }
              const profile = resolveGitCredentialProfile(
                project.gitUrl,
                settings.gitCredentialProfiles,
                project.gitCredentialProfileId
              );
              if (!profile) throw new Error("项目绑定的 Git Key 不可用");
              const committed = await onRunGitWorkspaceOperation({
                projectId: project.id,
                operation: "commit",
                profile,
                commitMessage: gitCommitMessage.trim(),
              });
              const pushed = await onRunGitWorkspaceOperation({
                projectId: project.id,
                operation: "push",
                profile,
              });
              const head = pushed.head ?? committed.head;
              if (!head) throw new Error("远端未返回 Git HEAD");
              if (project.importSource?.mode === "git") {
                await updateProject(project.id, {
                  importSource: {
                    ...project.importSource,
                    importedSnapshot: head,
                    importedAt: Date.now(),
                  },
                });
              }
              return head;
            })()
              .then((head) => Alert.alert("推送完成", `HEAD ${head.slice(0, 12)}`))
              .catch(showImportError)
              .finally(() => setIsImporting(false));
          },
        },
      ]
    );
  };

  const handleGitPull = (project: Project) => {
    setIsImporting(true);
    void (async () => {
      if (!remoteWorkspace) return pullGitProject(project.id, settings);
      if (!project.gitUrl || !project.gitCredentialProfileId) {
        throw new Error("远端 Git 项目必须绑定一个可用的 Key Profile");
      }
      const profile = resolveGitCredentialProfile(
        project.gitUrl,
        settings.gitCredentialProfiles,
        project.gitCredentialProfileId
      );
      if (!profile) throw new Error("项目绑定的 Git Key 不可用");
      const result = await onRunGitWorkspaceOperation({
        projectId: project.id,
        operation: "pull",
        profile,
      });
      if (!result.head) throw new Error("远端未返回 Git HEAD");
      if (project.importSource?.mode === "git") {
        await updateProject(project.id, {
          importSource: {
            ...project.importSource,
            importedSnapshot: result.head,
            importedAt: Date.now(),
          },
        });
      }
      return result.head;
    })()
      .then((head) => Alert.alert("拉取完成", `HEAD ${head.slice(0, 12)}`))
      .catch(showImportError)
      .finally(() => setIsImporting(false));
  };

  let matchingGitProfiles: AppSettings["gitCredentialProfiles"] = [];
  if (gitUrl.trim()) {
    try {
      matchingGitProfiles = matchingGitCredentialProfiles(
        gitUrl.trim(),
        settings.gitCredentialProfiles
      );
    } catch {
      matchingGitProfiles = [];
    }
  }

  const handleLegacyCleanup = (project: Project) => {
    const legacyProjectId = project.legacyId;
    if (!legacyProjectId) return;
    Alert.alert(
      "清理旧项目目录",
      "仅删除已完成迁移且已通过快照校验的旧目录；v2 受管目录和原始导入来源不会删除。此操作不可撤销。",
      [
        { text: "取消", style: "cancel" },
        {
          text: "确认清理",
          style: "destructive",
          onPress: () => {
            setIsImporting(true);
            void (async () => {
              const localCleaned = await cleanupLegacyStorage(project.id);
              const remoteNotice = await onCleanupLegacyWorkspace(project.id, legacyProjectId)
                .then((remote) => {
                  if (!remote.success) throw new Error(remote.error || "远端清理失败");
                  return remote.cleaned ? "，远端旧目录也已清理" : "，远端无待清理目录";
                })
                .catch(
                  (error) =>
                    `；远端旧目录保留：${error instanceof Error ? error.message : String(error)}`
                );
              Alert.alert("旧目录清理完成", `本机清理 ${localCleaned} 个迁移目录${remoteNotice}`);
            })()
              .catch(showImportError)
              .finally(() => setIsImporting(false));
          },
        },
      ]
    );
  };

  const renderItem = ({ item }: { item: Project }) => {
    const isActive = currentProject?.id === item.id;
    let projectGitProfiles: AppSettings["gitCredentialProfiles"] = [];
    if (item.gitUrl) {
      try {
        projectGitProfiles = matchingGitCredentialProfiles(
          item.gitUrl,
          settings.gitCredentialProfiles
        );
      } catch {
        projectGitProfiles = [];
      }
    }
    return (
      <TouchableOpacity
        style={[styles.projectItem, isActive && styles.projectItemActive]}
        onPress={() => handleSelect(item.id)}
        onLongPress={() => handleDelete(item)}
      >
        <View style={styles.projectInfo}>
          <Text style={[styles.projectName, isActive && styles.projectNameActive]}>
            {item.name}
          </Text>
          {item.description ? (
            <Text style={styles.projectDesc} numberOfLines={1}>
              {item.description}
            </Text>
          ) : null}
          {item.importSource ? (
            <Text style={styles.sourceBadge}>
              {item.importSource.mode === "copy"
                ? "独立副本 · 不自动写回"
                : item.importSource.mode === "linked"
                  ? "开发机绑定 · daemon 模式直接修改原目录"
                  : "Git · commit/push 回写"}
            </Text>
          ) : null}
          {isActive && item.importSource?.mode === "linked" ? (
            <View style={styles.linkedStatusRow}>
              <Text
                style={[
                  styles.sourceStatus,
                  linkedSourceStatus?.state !== "available" && styles.sourceStatusWarning,
                ]}
              >
                {linkedStatusText(linkedSourceStatus)}
              </Text>
              <TouchableOpacity
                style={styles.sourceActionBtn}
                onPress={() =>
                  void onInspectLinkedSource(item.id)
                    .then(setLinkedSourceStatus)
                    .catch(showImportError)
                }
              >
                <Text style={styles.sourceActionText}>重新检查</Text>
              </TouchableOpacity>
            </View>
          ) : null}
          {isActive && item.importSource?.mode === "copy" ? (
            <View style={styles.sourceActions}>
              <TouchableOpacity
                style={styles.sourceActionBtn}
                onPress={() => void handleCopySourceAction(item, "reimport")}
                disabled={isImporting}
              >
                <Text style={styles.sourceActionText}>预览重新导入</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.sourceActionBtn}
                onPress={() => void handleCopySourceAction(item, "write-back")}
                disabled={isImporting}
              >
                <Text style={styles.sourceActionText}>预览写回来源</Text>
              </TouchableOpacity>
            </View>
          ) : null}
          {isActive && item.importSource?.mode === "git" ? (
            <View style={styles.gitWriteBack}>
              <Text style={styles.gitCredentialLabel}>当前仓库凭据</Text>
              {projectGitProfiles.map((profile) => (
                <TouchableOpacity
                  key={profile.id}
                  style={[
                    styles.gitCredentialOption,
                    item.gitCredentialProfileId === profile.id &&
                      styles.gitCredentialOptionActive,
                  ]}
                  onPress={() =>
                    void updateProject(item.id, { gitCredentialProfileId: profile.id }).catch(
                      showImportError
                    )
                  }
                >
                  <Text style={styles.gitCredentialOptionText}>{profile.label}</Text>
                </TouchableOpacity>
              ))}
              {projectGitProfiles.length === 0 ? (
                <Text style={styles.gitCredentialHint}>
                  {remoteWorkspace
                    ? "远程模式一期的 Pull/Push 都需要配置并绑定匹配的 Key。"
                    : "没有匹配该仓库的已配置 Key；公开仓库仍可 Pull，Push 前请先配置并绑定。"}
                </Text>
              ) : null}
              <TouchableOpacity
                style={styles.gitPullBtn}
                onPress={() => handleGitPull(item)}
                disabled={isImporting}
              >
                <Text style={styles.gitPullBtnText}>Pull</Text>
              </TouchableOpacity>
              <TextInput
                style={styles.gitMessageInput}
                value={gitCommitMessage}
                onChangeText={setGitCommitMessage}
                placeholder="Git commit message"
                placeholderTextColor="#636366"
              />
              <TouchableOpacity
                style={styles.sourceActionBtn}
                onPress={() => handleGitWriteBack(item)}
                disabled={isImporting || !gitCommitMessage.trim()}
              >
                <Text style={styles.sourceActionText}>提交并推送</Text>
              </TouchableOpacity>
            </View>
          ) : null}
          {isActive && item.legacyId && legacyCleanupAvailable ? (
            <TouchableOpacity
              style={styles.legacyCleanupBtn}
              onPress={() => handleLegacyCleanup(item)}
              disabled={isImporting}
            >
              <Text style={styles.legacyCleanupText}>清理已迁移旧目录</Text>
            </TouchableOpacity>
          ) : null}
        </View>
        {isActive && <Text style={styles.checkmark}>✓</Text>}
      </TouchableOpacity>
    );
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>项目</Text>
        <View style={styles.headerActions}>
          {onEditPrompt && (
            <TouchableOpacity onPress={onEditPrompt}>
              <Text style={styles.addBtn}>指令</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity onPress={() => setShowImport(!showImport)} disabled={isImporting}>
            <Text style={styles.addBtn}>{isImporting ? "导入中…" : "导入"}</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setShowCreate(!showCreate)}>
            <Text style={styles.addBtn}>{showCreate ? "取消" : "+ 新建"}</Text>
          </TouchableOpacity>
        </View>
      </View>

      {showCreate && (
        <View style={styles.createForm}>
          <TextInput
            style={styles.input}
            value={newName}
            onChangeText={setNewName}
            placeholder="项目名称"
            placeholderTextColor="#636366"
            autoFocus
          />
          <TextInput
            style={styles.input}
            value={newDesc}
            onChangeText={setNewDesc}
            placeholder="描述（可选）"
            placeholderTextColor="#636366"
          />
          <TouchableOpacity
            style={[styles.createBtn, !newName.trim() && styles.createBtnDisabled]}
            onPress={handleCreate}
            disabled={!newName.trim()}
          >
            <Text style={styles.createBtnText}>创建</Text>
          </TouchableOpacity>
        </View>
      )}

      {showImport && (
        <View style={styles.createForm}>
          <View style={styles.importButtons}>
            <TouchableOpacity
              style={styles.secondaryBtn}
              onPress={() => void finishDirectoryImport()}
            >
              <Text style={styles.secondaryBtnText}>目录副本</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.secondaryBtn}
              onPress={() => void finishArchiveImport()}
            >
              <Text style={styles.secondaryBtnText}>ZIP 归档</Text>
            </TouchableOpacity>
          </View>
          <TextInput
            style={styles.input}
            value={gitUrl}
            onChangeText={setGitUrl}
            placeholder="Git HTTPS URL"
            placeholderTextColor="#636366"
            autoCapitalize="none"
            autoCorrect={false}
          />
          {gitUrl.trim() ? (
            <View style={styles.gitCredentialPicker}>
              <Text style={styles.gitCredentialLabel}>仓库凭据</Text>
              {!remoteWorkspace ? (
                <TouchableOpacity
                  style={[
                    styles.gitCredentialOption,
                    !gitCredentialProfileId && styles.gitCredentialOptionActive,
                  ]}
                  onPress={() => setGitCredentialProfileId(undefined)}
                >
                  <Text style={styles.gitCredentialOptionText}>公开仓库（不使用 Key）</Text>
                </TouchableOpacity>
              ) : null}
              {matchingGitProfiles.map((profile) => (
                <TouchableOpacity
                  key={profile.id}
                  style={[
                    styles.gitCredentialOption,
                    gitCredentialProfileId === profile.id && styles.gitCredentialOptionActive,
                  ]}
                  onPress={() => setGitCredentialProfileId(profile.id)}
                >
                  <Text style={styles.gitCredentialOptionText}>{profile.label}</Text>
                </TouchableOpacity>
              ))}
              {matchingGitProfiles.length === 0 ? (
                <Text style={styles.gitCredentialHint}>
                  没有与该 HTTPS Origin/路径匹配的已配置 Key；私有仓库请先到设置中添加。
                </Text>
              ) : null}
              {remoteWorkspace && gitCredentialProfileId ? (
                <View style={styles.gitTestRow}>
                  {(["read", "write"] as const).map((capability) => (
                    <TouchableOpacity
                      key={capability}
                      style={[
                        styles.gitTestCapability,
                        gitTestCapability === capability && styles.gitCredentialOptionActive,
                      ]}
                      onPress={() => setGitTestCapability(capability)}
                    >
                      <Text style={styles.gitCredentialOptionText}>
                        {capability === "read" ? "读权限" : "写权限"}
                      </Text>
                    </TouchableOpacity>
                  ))}
                  <TouchableOpacity
                    style={styles.gitTestButton}
                    onPress={() => void handleGitCredentialTest()}
                    disabled={isImporting}
                  >
                    <Text style={styles.gitTestButtonText}>测试 Key</Text>
                  </TouchableOpacity>
                </View>
              ) : null}
            </View>
          ) : null}
          <TouchableOpacity
            style={[styles.createBtn, !gitUrl.trim() && styles.createBtnDisabled]}
            disabled={!gitUrl.trim() || isImporting}
            onPress={() => void finishGitImport()}
          >
            <Text style={styles.createBtnText}>Clone Git 项目</Text>
          </TouchableOpacity>
          {settings.workspaceMode === "relay" && (
            <>
              <TextInput
                style={styles.input}
                value={linkedPath}
                onChangeText={setLinkedPath}
                placeholder="开发机现有项目绝对路径"
                placeholderTextColor="#636366"
                autoCapitalize="none"
                autoCorrect={false}
              />
              <TextInput
                style={styles.input}
                value={linkedName}
                onChangeText={setLinkedName}
                placeholder="项目名称（可选）"
                placeholderTextColor="#636366"
              />
              <TouchableOpacity
                style={[styles.createBtn, !linkedPath.trim() && styles.createBtnDisabled]}
                disabled={!linkedPath.trim() || isImporting}
                onPress={() => void finishLinkedImport()}
              >
                <Text style={styles.createBtnText}>绑定原目录（修改会直接写回）</Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      )}

      <FlatList
        data={projects}
        renderItem={renderItem}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginBottom: 8,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  title: {
    color: "#8E8E93",
    fontSize: 13,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  headerActions: {
    flexDirection: "row",
    gap: 14,
  },
  addBtn: {
    color: "#007AFF",
    fontSize: 14,
    fontWeight: "500",
  },
  legacyCleanupBtn: {
    alignSelf: "flex-start",
    marginTop: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#FF453A",
  },
  legacyCleanupText: {
    color: "#FF453A",
    fontSize: 12,
    fontWeight: "600",
  },
  createForm: {
    paddingHorizontal: 16,
    paddingBottom: 12,
    gap: 8,
  },
  input: {
    backgroundColor: "#2C2C2E",
    color: "#FFFFFF",
    fontSize: 14,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
  },
  createBtn: {
    backgroundColor: "#007AFF",
    borderRadius: 8,
    paddingVertical: 8,
    alignItems: "center",
  },
  createBtnDisabled: {
    backgroundColor: "#38383A",
  },
  createBtnText: {
    color: "#FFFFFF",
    fontSize: 14,
    fontWeight: "600",
  },
  importButtons: {
    flexDirection: "row",
    gap: 8,
  },
  secondaryBtn: {
    flex: 1,
    backgroundColor: "#2C2C2E",
    borderRadius: 8,
    paddingVertical: 8,
    alignItems: "center",
  },
  secondaryBtnText: {
    color: "#0A84FF",
    fontSize: 13,
    fontWeight: "600",
  },
  list: {
    paddingHorizontal: 8,
  },
  projectItem: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 8,
    marginBottom: 2,
  },
  projectItemActive: {
    backgroundColor: "#2C2C2E",
  },
  projectInfo: {
    flex: 1,
  },
  projectName: {
    color: "#E5E5EA",
    fontSize: 15,
    fontWeight: "500",
  },
  projectNameActive: {
    color: "#007AFF",
  },
  projectDesc: {
    color: "#636366",
    fontSize: 12,
    marginTop: 2,
  },
  sourceBadge: {
    color: "#8E8E93",
    fontSize: 11,
    marginTop: 2,
  },
  sourceActions: {
    flexDirection: "row",
    gap: 8,
    marginTop: 8,
  },
  linkedStatusRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
    marginTop: 8,
  },
  sourceStatus: {
    color: "#30D158",
    fontSize: 11,
  },
  sourceStatusWarning: {
    color: "#FF9F0A",
  },
  sourceActionBtn: {
    alignSelf: "flex-start",
    backgroundColor: "#3A3A3C",
    borderRadius: 6,
    paddingHorizontal: 9,
    paddingVertical: 6,
  },
  sourceActionText: {
    color: "#0A84FF",
    fontSize: 12,
    fontWeight: "600",
  },
  gitWriteBack: {
    gap: 6,
    marginTop: 8,
  },
  gitPullBtn: {
    backgroundColor: "#2C2C2E",
    borderRadius: 7,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  gitPullBtnText: {
    color: "#0A84FF",
    fontSize: 12,
    fontWeight: "600",
  },
  gitCredentialPicker: {
    gap: 6,
    marginBottom: 2,
  },
  gitCredentialLabel: {
    color: "#8E8E93",
    fontSize: 12,
  },
  gitCredentialOption: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#48484A",
    borderRadius: 7,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  gitCredentialOptionActive: {
    borderColor: "#0A84FF",
    backgroundColor: "#0A84FF22",
  },
  gitCredentialOptionText: {
    color: "#E5E5EA",
    fontSize: 12,
  },
  gitCredentialHint: {
    color: "#FF9F0A",
    fontSize: 11,
    lineHeight: 15,
  },
  gitTestRow: {
    flexDirection: "row",
    gap: 6,
  },
  gitTestCapability: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#48484A",
    borderRadius: 7,
    paddingHorizontal: 8,
    paddingVertical: 7,
  },
  gitTestButton: {
    flex: 1,
    alignItems: "center",
    backgroundColor: "#0A84FF",
    borderRadius: 7,
    paddingHorizontal: 8,
    paddingVertical: 7,
  },
  gitTestButtonText: {
    color: "#FFFFFF",
    fontSize: 12,
    fontWeight: "600",
  },
  gitMessageInput: {
    backgroundColor: "#1C1C1E",
    borderRadius: 6,
    color: "#FFFFFF",
    fontSize: 12,
    paddingHorizontal: 9,
    paddingVertical: 6,
  },
  checkmark: {
    color: "#007AFF",
    fontSize: 16,
    fontWeight: "700",
    marginLeft: 8,
  },
});
