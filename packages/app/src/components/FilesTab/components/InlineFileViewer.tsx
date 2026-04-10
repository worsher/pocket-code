import React, { useState, useEffect, useMemo } from "react";
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
import CodeHighlighter from "react-native-code-highlighter";
import type { FileItem } from "../../../hooks/useFileTree";
import { detectLanguage } from "../../../utils/languageDetect";

// Inlined Atom One Dark theme (same as CodeBlock)
const atomOneDarkReasonable: Record<string, any> = {
  hljs: { display: "block", overflowX: "auto", padding: "0.5em", color: "#abb2bf", background: "#282c34" },
  "hljs-keyword": { color: "#F92672" },
  "hljs-operator": { color: "#F92672" },
  "hljs-pattern-match": { color: "#F92672" },
  "hljs-function": { color: "#61aeee" },
  "hljs-comment": { color: "#b18eb1", fontStyle: "italic" },
  "hljs-quote": { color: "#b18eb1", fontStyle: "italic" },
  "hljs-doctag": { color: "#c678dd" },
  "hljs-section": { color: "#e06c75" },
  "hljs-name": { color: "#e06c75" },
  "hljs-selector-tag": { color: "#e06c75" },
  "hljs-deletion": { color: "#e06c75" },
  "hljs-subst": { color: "#e06c75" },
  "hljs-literal": { color: "#56b6c2" },
  "hljs-string": { color: "#98c379" },
  "hljs-regexp": { color: "#98c379" },
  "hljs-addition": { color: "#98c379" },
  "hljs-attribute": { color: "#98c379" },
  "hljs-meta-string": { color: "#98c379" },
  "hljs-built_in": { color: "#e6c07b" },
  "hljs-attr": { color: "#d19a66" },
  "hljs-variable": { color: "#d19a66" },
  "hljs-template-variable": { color: "#d19a66" },
  "hljs-type": { color: "#d19a66" },
  "hljs-selector-class": { color: "#d19a66" },
  "hljs-number": { color: "#d19a66" },
  "hljs-symbol": { color: "#61aeee" },
  "hljs-bullet": { color: "#61aeee" },
  "hljs-link": { color: "#61aeee" },
  "hljs-meta": { color: "#61aeee" },
  "hljs-selector-id": { color: "#61aeee" },
  "hljs-title": { color: "#61aeee" },
  "hljs-emphasis": { fontStyle: "italic" },
  "hljs-strong": { fontWeight: "bold" },
};

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

  const language = useMemo(() => detectLanguage(file.name), [file.name]);

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

  const lineCount = content ? content.split("\n").length : 0;

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={onBack} style={styles.backBtn}>
          <Text style={styles.backText}>{"<-"} 返回</Text>
        </TouchableOpacity>
        <Text style={styles.fileName} numberOfLines={1}>
          {file.name}
        </Text>
        <View style={styles.headerActions}>
          {!isEditing && content !== null && (
            <Text style={styles.langBadge}>{language}</Text>
          )}
          {editable && !isEditing && content !== null && (
            <TouchableOpacity
              onPress={() => setIsEditing(true)}
              style={styles.actionBtn}
            >
              <Text style={styles.actionText}>编辑</Text>
            </TouchableOpacity>
          )}
          {editable && isEditing && (
            <>
              <TouchableOpacity
                onPress={() => { setIsEditing(false); setEditedContent(content || ""); setHasChanges(false); }}
                style={styles.actionBtn}
              >
                <Text style={styles.actionText}>取消</Text>
              </TouchableOpacity>
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
            </>
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
          showsVerticalScrollIndicator
        >
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View style={styles.codeContainer}>
              {/* Line numbers gutter */}
              <View style={styles.lineNumbers}>
                {Array.from({ length: lineCount }, (_, i) => (
                  <Text key={i} style={styles.lineNumber}>
                    {i + 1}
                  </Text>
                ))}
              </View>
              {/* Highlighted code */}
              <View style={styles.codeContent}>
                {/* @ts-ignore — children prop exists at runtime */}
                <CodeHighlighter
                  hljsStyle={atomOneDarkReasonable}
                  language={language}
                  textStyle={styles.codeText}
                  scrollViewProps={{ scrollEnabled: false }}
                >
                  {content || ""}
                </CodeHighlighter>
              </View>
            </View>
          </ScrollView>
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
    alignItems: "center",
  },
  langBadge: {
    color: "#636366",
    fontSize: 11,
    fontFamily: "monospace",
    backgroundColor: "#1C1C1E",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
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
  codeContainer: {
    flexDirection: "row",
    paddingVertical: 8,
  },
  lineNumbers: {
    paddingLeft: 8,
    paddingRight: 8,
    borderRightWidth: 1,
    borderRightColor: "#38383A",
    minWidth: 40,
    alignItems: "flex-end",
  },
  lineNumber: {
    color: "#636366",
    fontSize: 13,
    fontFamily: "monospace",
    lineHeight: 20,
  },
  codeContent: {
    flex: 1,
    paddingLeft: 8,
  },
  codeText: {
    fontFamily: "monospace",
    fontSize: 13,
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
