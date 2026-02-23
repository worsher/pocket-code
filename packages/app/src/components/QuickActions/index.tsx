import React, { useState, useEffect, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActionSheetIOS,
  Platform,
  Alert,
} from "react-native";
import { useProject } from "../../contexts/ProjectContext";
import {
  loadQuickActions,
  saveQuickActions,
  createAction,
  type CustomAction,
} from "../../store/quickActions";
import QuickActionEditor from "../QuickActionEditor";

interface QuickActionsProps {
  onSend: (message: string) => void;
  disabled?: boolean;
}

export default function QuickActions({ onSend, disabled }: QuickActionsProps) {
  const { currentProject } = useProject();
  const [actions, setActions] = useState<CustomAction[]>([]);
  const [showEditor, setShowEditor] = useState(false);
  const [editingAction, setEditingAction] = useState<CustomAction | null>(null);

  const projectId = currentProject?.id || "default";

  useEffect(() => {
    loadQuickActions(projectId).then(setActions);
  }, [projectId]);

  const save = useCallback(
    async (updated: CustomAction[]) => {
      setActions(updated);
      await saveQuickActions(projectId, updated);
    },
    [projectId],
  );

  const handleAdd = () => {
    setEditingAction(null);
    setShowEditor(true);
  };

  const handleLongPress = (action: CustomAction) => {
    const options = action.isDefault
      ? ["编辑", "取消"]
      : ["编辑", "删除", "取消"];
    const cancelIndex = options.length - 1;
    const destructiveIndex = action.isDefault ? undefined : 1;

    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        { options, cancelButtonIndex: cancelIndex, destructiveButtonIndex: destructiveIndex },
        (idx) => handleMenuAction(action, idx),
      );
    } else {
      const alertOptions = action.isDefault
        ? [
            { text: "编辑", onPress: () => handleMenuAction(action, 0) },
            { text: "取消", style: "cancel" as const },
          ]
        : [
            { text: "编辑", onPress: () => handleMenuAction(action, 0) },
            { text: "删除", style: "destructive" as const, onPress: () => handleMenuAction(action, 1) },
            { text: "取消", style: "cancel" as const },
          ];
      Alert.alert("操作", undefined, alertOptions);
    }
  };

  const handleMenuAction = (action: CustomAction, index: number) => {
    if (index === 0) {
      setEditingAction(action);
      setShowEditor(true);
    } else if (index === 1 && !action.isDefault) {
      save(actions.filter((a) => a.id !== action.id));
    }
  };

  const handleEditorSave = (label: string, prompt: string, icon: string) => {
    if (editingAction) {
      const updated = actions.map((a) =>
        a.id === editingAction.id ? { ...a, label, prompt, icon } : a,
      );
      save(updated);
    } else {
      const newAction = createAction(label, prompt, icon, actions.length);
      save([...actions, newAction]);
    }
  };

  return (
    <>
      <View style={styles.container}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.scrollContent}
        >
          {actions.map((action) => (
            <TouchableOpacity
              key={action.id}
              style={[styles.button, disabled && styles.buttonDisabled]}
              onPress={() => !disabled && onSend(action.prompt)}
              onLongPress={() => handleLongPress(action)}
              disabled={disabled}
              activeOpacity={0.7}
            >
              <Text style={styles.icon}>{action.icon}</Text>
              <Text style={[styles.label, disabled && styles.labelDisabled]}>
                {action.label}
              </Text>
            </TouchableOpacity>
          ))}
          <TouchableOpacity
            style={[styles.addButton, disabled && styles.buttonDisabled]}
            onPress={handleAdd}
            disabled={disabled}
          >
            <Text style={styles.addIcon}>+</Text>
          </TouchableOpacity>
        </ScrollView>
      </View>

      <QuickActionEditor
        visible={showEditor}
        action={editingAction}
        onSave={handleEditorSave}
        onClose={() => setShowEditor(false)}
      />
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: "#1C1C1E",
    borderTopWidth: 1,
    borderTopColor: "#38383A",
  },
  scrollContent: {
    paddingHorizontal: 8,
    paddingVertical: 6,
    gap: 6,
  },
  button: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#2C2C2E",
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 6,
    gap: 4,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  icon: {
    fontSize: 12,
  },
  label: {
    color: "#E5E5EA",
    fontSize: 13,
    fontWeight: "500",
  },
  labelDisabled: {
    color: "#636366",
  },
  addButton: {
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#2C2C2E",
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: "#48484A",
    borderStyle: "dashed",
  },
  addIcon: {
    color: "#8E8E93",
    fontSize: 16,
    fontWeight: "600",
  },
});
