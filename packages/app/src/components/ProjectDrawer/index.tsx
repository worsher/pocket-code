// ── Project Drawer ───────────────────────────────────────
// A slide-out drawer for switching between projects.

import React, { useState } from "react";
import { View, Text, TouchableOpacity, FlatList, TextInput, StyleSheet, Alert } from "react-native";
import { randomUUID } from "expo-crypto";
import { useProject } from "../../contexts/ProjectContext";
import type { Project } from "../../store/projects";
import type { AppSettings } from "../../store/settings";
import { getWorkspaceConnectionKey } from "../../services/workspaceConnection";
import type { LinkedWorkspaceImportResponse } from "@pocket-code/client-core";

interface Props {
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
}

type ProjectImportUiResult =
  | null
  | { status: "imported"; committed: Project }
  | { status: "blocked" | "confirmation-required"; existingProjectId: string };

export default function ProjectDrawer({
  onSelectProject,
  onEditPrompt,
  onDeleteWorkspace,
  settings,
  onBindLinkedWorkspace,
}: Props) {
  const {
    projects,
    currentProject,
    switchProject,
    createProject,
    deleteProject,
    importDirectoryProject,
    importArchiveProject,
    importGitProject,
    registerLinkedProject,
  } = useProject();

  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [isImporting, setIsImporting] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [gitUrl, setGitUrl] = useState("");
  const [linkedPath, setLinkedPath] = useState("");
  const [linkedName, setLinkedName] = useState("");
  const [pendingLinkedProjectId, setPendingLinkedProjectId] = useState<string | null>(null);

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
      const result = await importGitProject(gitUrl.trim(), settings, allowWeakDuplicate);
      handleImportResult(result, () => void finishGitImport(true));
    } catch (error) {
      showImportError(error);
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

  const renderItem = ({ item }: { item: Project }) => {
    const isActive = currentProject?.id === item.id;
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
  checkmark: {
    color: "#007AFF",
    fontSize: 16,
    fontWeight: "700",
    marginLeft: 8,
  },
});
