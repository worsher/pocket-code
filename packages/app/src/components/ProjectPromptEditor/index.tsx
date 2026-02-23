import React, { useState, useEffect } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  Modal,
  ScrollView,
  StyleSheet,
  Alert,
} from "react-native";
import { useProject } from "../../contexts/ProjectContext";

interface ProjectPromptEditorProps {
  visible: boolean;
  onClose: () => void;
}

const TEMPLATES = [
  {
    label: "前端项目",
    prompt:
      "这是一个前端项目。请使用现代 JavaScript/TypeScript 最佳实践，遵循组件化开发模式。代码风格简洁，变量命名使用 camelCase。",
  },
  {
    label: "后端项目",
    prompt:
      "这是一个后端项目。请关注 API 设计、错误处理和安全性。使用 RESTful 风格，函数命名使用 camelCase。",
  },
  {
    label: "移动端项目",
    prompt:
      "这是一个 React Native 移动端项目。请注意平台兼容性和性能优化，使用函数式组件和 Hooks。",
  },
];

const MAX_LENGTH = 2000;

export default function ProjectPromptEditor({
  visible,
  onClose,
}: ProjectPromptEditorProps) {
  const { currentProject, updateProject } = useProject();
  const [prompt, setPrompt] = useState("");

  useEffect(() => {
    if (visible && currentProject) {
      setPrompt(currentProject.customPrompt || "");
    }
  }, [visible, currentProject]);

  const handleSave = () => {
    if (!currentProject) return;
    updateProject(currentProject.id, { customPrompt: prompt.trim() || undefined });
    Alert.alert("已保存", "项目指令已更新");
    onClose();
  };

  const handleApplyTemplate = (template: string) => {
    setPrompt(template);
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity onPress={onClose}>
            <Text style={styles.cancelText}>取消</Text>
          </TouchableOpacity>
          <Text style={styles.title}>
            {currentProject?.name || "项目"} — 指令
          </Text>
          <TouchableOpacity onPress={handleSave}>
            <Text style={styles.saveText}>保存</Text>
          </TouchableOpacity>
        </View>

        <ScrollView style={styles.body} keyboardShouldPersistTaps="handled">
          <Text style={styles.sectionTitle}>自定义 System Prompt</Text>
          <Text style={styles.hint}>
            AI 会在每次对话时自动遵循以下指令，类似 CLAUDE.md
          </Text>

          <TextInput
            style={styles.textArea}
            value={prompt}
            onChangeText={setPrompt}
            placeholder="例如：这是一个 React + TypeScript 项目，使用 pnpm 管理依赖，代码风格遵循 ESLint 配置..."
            placeholderTextColor="#636366"
            multiline
            maxLength={MAX_LENGTH}
            textAlignVertical="top"
          />

          <Text style={styles.charCount}>
            {prompt.length}/{MAX_LENGTH}
          </Text>

          <Text style={[styles.sectionTitle, { marginTop: 20 }]}>
            快速模板
          </Text>
          <View style={styles.templates}>
            {TEMPLATES.map((t) => (
              <TouchableOpacity
                key={t.label}
                style={styles.templateBtn}
                onPress={() => handleApplyTemplate(t.prompt)}
              >
                <Text style={styles.templateLabel}>{t.label}</Text>
              </TouchableOpacity>
            ))}
          </View>

          {prompt.trim() ? (
            <TouchableOpacity
              style={styles.clearBtn}
              onPress={() => setPrompt("")}
            >
              <Text style={styles.clearText}>清空指令</Text>
            </TouchableOpacity>
          ) : null}
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#000000",
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: "#1C1C1E",
    borderBottomWidth: 0.5,
    borderBottomColor: "#38383A",
  },
  cancelText: {
    color: "#007AFF",
    fontSize: 15,
  },
  title: {
    color: "#FFFFFF",
    fontSize: 16,
    fontWeight: "600",
  },
  saveText: {
    color: "#007AFF",
    fontSize: 15,
    fontWeight: "600",
  },
  body: {
    flex: 1,
    padding: 16,
  },
  sectionTitle: {
    color: "#FFFFFF",
    fontSize: 15,
    fontWeight: "600",
    marginBottom: 6,
  },
  hint: {
    color: "#8E8E93",
    fontSize: 13,
    marginBottom: 12,
    lineHeight: 18,
  },
  textArea: {
    backgroundColor: "#1C1C1E",
    borderRadius: 10,
    padding: 14,
    color: "#FFFFFF",
    fontSize: 14,
    lineHeight: 20,
    minHeight: 160,
    borderWidth: 1,
    borderColor: "#38383A",
  },
  charCount: {
    color: "#636366",
    fontSize: 12,
    textAlign: "right",
    marginTop: 4,
  },
  templates: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginTop: 8,
  },
  templateBtn: {
    backgroundColor: "#2C2C2E",
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 16,
  },
  templateLabel: {
    color: "#E5E5EA",
    fontSize: 13,
    fontWeight: "500",
  },
  clearBtn: {
    marginTop: 24,
    alignItems: "center",
    paddingVertical: 10,
  },
  clearText: {
    color: "#FF453A",
    fontSize: 14,
  },
});
