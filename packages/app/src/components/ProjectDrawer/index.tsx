// ── Project Drawer ───────────────────────────────────────
// A slide-out drawer for switching between projects.

import React, { useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  FlatList,
  TextInput,
  StyleSheet,
  Alert,
} from "react-native";
import { useProject } from "../../contexts/ProjectContext";
import type { Project } from "../../store/projects";

interface Props {
  onSelectProject?: (projectId: string) => void;
  onEditPrompt?: () => void;
}

export default function ProjectDrawer({ onSelectProject, onEditPrompt }: Props) {
  const {
    projects,
    currentProject,
    switchProject,
    createProject,
    deleteProject,
  } = useProject();

  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");

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
        text: "删除",
        style: "destructive",
        onPress: () => deleteProject(project.id),
      },
    ]);
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
  checkmark: {
    color: "#007AFF",
    fontSize: 16,
    fontWeight: "700",
    marginLeft: 8,
  },
});
