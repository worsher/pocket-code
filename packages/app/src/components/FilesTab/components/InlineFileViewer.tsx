import React, { useState, useEffect } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  TextInput,
  StyleSheet,
  ActivityIndicator,
  Alert,
} from "react-native";
import type { FileItem } from "../../../hooks/useFileTree";

interface Props {
  file: FileItem;
  requestFileContent: (path: string) => Promise<any>;
  onBack: () => void;
  editable?: boolean;
  onSave?: (path: string, content: string) => Promise<{ success: boolean; error?: string }>;
}

export default function InlineFileViewer({
  file,
  requestFileContent,
  onBack,
  editable = false,
  onSave,
}: Props) {
  const [content, setContent] = useState<string | null>(null);
  const [editedContent, setEditedContent] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);

  useEffect(() => {
    loadFile();
  }, [file.path]);

  const loadFile = async () => {
    setLoading(true);
    setError(undefined);
    setIsEditing(false);
    setHasChanges(false);
    try {
      const result = await requestFileContent(file.path);
      if (result.success) {
        setContent(result.content);
        setEditedContent(result.content);
      } else {
        setError(result.error || "Unable to read file");
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    if (!onSave || !hasChanges) return;
    setSaving(true);
    try {
      const result = await onSave(file.path, editedContent);
      if (result.success) {
        setContent(editedContent);
        setHasChanges(false);
        setIsEditing(false);
      } else {
        Alert.alert("保存失败", result.error || "Unknown error");
      }
    } catch (err: any) {
      Alert.alert("保存失败", err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleContentChange = (text: string) => {
    setEditedContent(text);
    setHasChanges(text !== content);
  };

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={onBack} style={styles.backBtn}>
          <Text style={styles.backText}>← 返回</Text>
        </TouchableOpacity>
        <Text style={styles.fileName} numberOfLines={1}>
          {file.name}
        </Text>
        <View style={styles.headerActions}>
          {editable && !isEditing && content !== null && (
            <TouchableOpacity
              onPress={() => setIsEditing(true)}
              style={styles.actionBtn}
            >
              <Text style={styles.actionText}>编辑</Text>
            </TouchableOpacity>
          )}
          {editable && isEditing && (
            <TouchableOpacity
              onPress={handleSave}
              style={[styles.actionBtn, !hasChanges && styles.actionBtnDisabled]}
              disabled={!hasChanges || saving}
            >
              <Text
                style={[
                  styles.actionText,
                  styles.saveText,
                  !hasChanges && styles.actionTextDisabled,
                ]}
              >
                {saving ? "保存中..." : "保存"}
              </Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* Content */}
      {loading ? (
        <View style={styles.centerContainer}>
          <ActivityIndicator color="#007AFF" />
          <Text style={styles.hintText}>加载中...</Text>
        </View>
      ) : error ? (
        <View style={styles.centerContainer}>
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity style={styles.retryBtn} onPress={loadFile}>
            <Text style={styles.retryText}>重试</Text>
          </TouchableOpacity>
        </View>
      ) : isEditing ? (
        <TextInput
          style={styles.editor}
          value={editedContent}
          onChangeText={handleContentChange}
          multiline
          textAlignVertical="top"
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
        />
      ) : (
        <ScrollView
          style={styles.scrollView}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator
        >
          <Text style={styles.codeText} selectable>
            {content}
          </Text>
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#000000",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 0.5,
    borderBottomColor: "#38383A",
    gap: 8,
  },
  backBtn: {
    paddingVertical: 4,
    paddingRight: 8,
  },
  backText: {
    color: "#007AFF",
    fontSize: 14,
    fontWeight: "500",
  },
  fileName: {
    color: "#FFFFFF",
    fontSize: 14,
    fontWeight: "600",
    flex: 1,
  },
  headerActions: {
    flexDirection: "row",
    gap: 8,
  },
  actionBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: "#2C2C2E",
  },
  actionBtnDisabled: {
    opacity: 0.5,
  },
  actionText: {
    color: "#007AFF",
    fontSize: 13,
    fontWeight: "500",
  },
  actionTextDisabled: {
    color: "#636366",
  },
  saveText: {
    color: "#34C759",
  },
  centerContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
  },
  hintText: {
    color: "#8E8E93",
    fontSize: 14,
    marginTop: 8,
  },
  errorText: {
    color: "#FF453A",
    fontSize: 14,
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
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    padding: 12,
  },
  codeText: {
    color: "#E5E5EA",
    fontSize: 13,
    fontFamily: "monospace",
    lineHeight: 20,
  },
  editor: {
    flex: 1,
    color: "#E5E5EA",
    fontSize: 13,
    fontFamily: "monospace",
    lineHeight: 20,
    padding: 12,
    textAlignVertical: "top",
  },
});
