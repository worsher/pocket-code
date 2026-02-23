import React, { useState, useEffect } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  Modal,
  StyleSheet,
} from "react-native";
import type { CustomAction } from "../../store/quickActions";

interface Props {
  visible: boolean;
  action?: CustomAction | null; // null = create new
  onSave: (label: string, prompt: string, icon: string) => void;
  onClose: () => void;
}

const EMOJI_OPTIONS = ["🚀", "📝", "🔧", "🧪", "📦", "🔍", "💡", "🎯"];

export default function QuickActionEditor({ visible, action, onSave, onClose }: Props) {
  const [label, setLabel] = useState("");
  const [prompt, setPrompt] = useState("");
  const [icon, setIcon] = useState("🚀");

  useEffect(() => {
    if (visible) {
      if (action) {
        setLabel(action.label);
        setPrompt(action.prompt);
        setIcon(action.icon);
      } else {
        setLabel("");
        setPrompt("");
        setIcon("🚀");
      }
    }
  }, [visible, action]);

  const handleSave = () => {
    if (!label.trim() || !prompt.trim()) return;
    onSave(label.trim(), prompt.trim(), icon);
    onClose();
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <TouchableOpacity
        style={styles.overlay}
        activeOpacity={1}
        onPress={onClose}
      >
        <View style={styles.content} onStartShouldSetResponder={() => true}>
          <Text style={styles.title}>
            {action ? "编辑指令" : "新建快捷指令"}
          </Text>

          <Text style={styles.fieldLabel}>图标</Text>
          <View style={styles.emojiRow}>
            {EMOJI_OPTIONS.map((e) => (
              <TouchableOpacity
                key={e}
                style={[styles.emojiBtn, icon === e && styles.emojiBtnActive]}
                onPress={() => setIcon(e)}
              >
                <Text style={styles.emoji}>{e}</Text>
              </TouchableOpacity>
            ))}
          </View>

          <Text style={styles.fieldLabel}>名称</Text>
          <TextInput
            style={styles.input}
            value={label}
            onChangeText={setLabel}
            placeholder="例如: Deploy"
            placeholderTextColor="#636366"
            maxLength={20}
          />

          <Text style={styles.fieldLabel}>指令内容</Text>
          <TextInput
            style={[styles.input, styles.textArea]}
            value={prompt}
            onChangeText={setPrompt}
            placeholder="例如: 请部署到生产环境..."
            placeholderTextColor="#636366"
            multiline
            maxLength={500}
            textAlignVertical="top"
          />

          <View style={styles.actions}>
            <TouchableOpacity style={styles.cancelBtn} onPress={onClose}>
              <Text style={styles.cancelText}>取消</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.saveBtn, (!label.trim() || !prompt.trim()) && styles.saveBtnDisabled]}
              onPress={handleSave}
              disabled={!label.trim() || !prompt.trim()}
            >
              <Text style={styles.saveText}>保存</Text>
            </TouchableOpacity>
          </View>
        </View>
      </TouchableOpacity>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  content: {
    width: "100%",
    backgroundColor: "#1C1C1E",
    borderRadius: 16,
    padding: 20,
  },
  title: {
    color: "#FFFFFF",
    fontSize: 18,
    fontWeight: "700",
    marginBottom: 16,
    textAlign: "center",
  },
  fieldLabel: {
    color: "#8E8E93",
    fontSize: 13,
    fontWeight: "600",
    marginBottom: 6,
    marginTop: 8,
  },
  emojiRow: {
    flexDirection: "row",
    gap: 8,
    flexWrap: "wrap",
  },
  emojiBtn: {
    width: 36,
    height: 36,
    borderRadius: 8,
    backgroundColor: "#2C2C2E",
    justifyContent: "center",
    alignItems: "center",
  },
  emojiBtnActive: {
    backgroundColor: "#007AFF",
  },
  emoji: {
    fontSize: 18,
  },
  input: {
    backgroundColor: "#2C2C2E",
    color: "#FFFFFF",
    fontSize: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 8,
  },
  textArea: {
    minHeight: 80,
  },
  actions: {
    flexDirection: "row",
    gap: 12,
    marginTop: 20,
  },
  cancelBtn: {
    flex: 1,
    backgroundColor: "#2C2C2E",
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: "center",
  },
  cancelText: {
    color: "#E5E5EA",
    fontSize: 14,
    fontWeight: "500",
  },
  saveBtn: {
    flex: 1,
    backgroundColor: "#007AFF",
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: "center",
  },
  saveBtnDisabled: {
    backgroundColor: "#38383A",
  },
  saveText: {
    color: "#FFFFFF",
    fontSize: 14,
    fontWeight: "600",
  },
});
