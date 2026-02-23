import React, { useState, useEffect, useRef } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  Modal,
  Animated,
  Dimensions,
  Alert,
} from "react-native";
import {
  listSessions,
  deleteSession,
  type SessionInfo,
} from "../../store/chatHistory";
import ProjectDrawer from "../ProjectDrawer";

const SCREEN_WIDTH = Dimensions.get("window").width;
const DRAWER_WIDTH = SCREEN_WIDTH * 0.8;

interface Props {
  visible: boolean;
  currentSessionId: string | null;
  onClose: () => void;
  onSelectSession: (sessionId: string) => void;
  onNewSession: () => void;
  onEditPrompt?: () => void;
}

export default function SessionDrawer({
  visible,
  currentSessionId,
  onClose,
  onSelectSession,
  onNewSession,
  onEditPrompt,
}: Props) {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const slideAnim = useRef(new Animated.Value(-DRAWER_WIDTH)).current;

  useEffect(() => {
    if (visible) {
      loadSessions();
      Animated.timing(slideAnim, {
        toValue: 0,
        duration: 250,
        useNativeDriver: true,
      }).start();
    } else {
      Animated.timing(slideAnim, {
        toValue: -DRAWER_WIDTH,
        duration: 200,
        useNativeDriver: true,
      }).start();
    }
  }, [visible]);

  const loadSessions = async () => {
    const list = await listSessions();
    setSessions(list);
  };

  const handleDelete = (session: SessionInfo) => {
    Alert.alert("删除对话", `确定删除「${session.title}」？`, [
      { text: "取消", style: "cancel" },
      {
        text: "删除",
        style: "destructive",
        onPress: async () => {
          await deleteSession(session.id);
          loadSessions();
        },
      },
    ]);
  };

  const handleSelect = (sessionId: string) => {
    onClose();
    // Small delay for animation
    setTimeout(() => onSelectSession(sessionId), 200);
  };

  const handleNew = () => {
    onClose();
    setTimeout(() => onNewSession(), 200);
  };

  const formatTime = (ts: number) => {
    const d = new Date(ts);
    const now = new Date();
    const isToday =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate();
    if (isToday) {
      return d.toLocaleTimeString("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
      });
    }
    return d.toLocaleDateString("zh-CN", {
      month: "short",
      day: "numeric",
    });
  };

  const renderItem = ({ item }: { item: SessionInfo }) => {
    const isActive = item.id === currentSessionId;
    return (
      <TouchableOpacity
        style={[styles.sessionItem, isActive && styles.sessionItemActive]}
        onPress={() => handleSelect(item.id)}
        onLongPress={() => handleDelete(item)}
      >
        <View style={styles.sessionInfo}>
          <Text
            style={[styles.sessionTitle, isActive && styles.sessionTitleActive]}
            numberOfLines={1}
          >
            {item.title}
          </Text>
          <View style={styles.sessionMeta}>
            <Text style={styles.sessionTime}>{formatTime(item.lastUpdated)}</Text>
            <Text style={styles.sessionCount}>{item.messageCount} 条</Text>
          </View>
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      onRequestClose={onClose}
    >
      <View style={styles.overlay}>
        {/* Backdrop */}
        <TouchableOpacity
          style={styles.backdrop}
          activeOpacity={1}
          onPress={onClose}
        />

        {/* Drawer */}
        <Animated.View
          style={[
            styles.drawer,
            { transform: [{ translateX: slideAnim }] },
          ]}
        >
          {/* Project Selector */}
          <ProjectDrawer onEditPrompt={onEditPrompt} />

          {/* Divider */}
          <View style={styles.divider} />

          {/* Header */}
          <View style={styles.header}>
            <Text style={styles.headerTitle}>对话记录</Text>
            <TouchableOpacity style={styles.newBtn} onPress={handleNew}>
              <Text style={styles.newBtnText}>+ 新对话</Text>
            </TouchableOpacity>
          </View>

          {/* Session List */}
          {sessions.length === 0 ? (
            <View style={styles.empty}>
              <Text style={styles.emptyText}>暂无对话记录</Text>
            </View>
          ) : (
            <FlatList
              data={sessions}
              renderItem={renderItem}
              keyExtractor={(item) => item.id}
              contentContainerStyle={styles.list}
              showsVerticalScrollIndicator={false}
            />
          )}

          {/* Hint */}
          <Text style={styles.hint}>长按可删除对话</Text>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    flexDirection: "row",
  },
  backdrop: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0,0,0,0.5)",
  },
  drawer: {
    width: DRAWER_WIDTH,
    backgroundColor: "#1C1C1E",
    flex: 1,
    paddingTop: 60,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: 0.5,
    borderBottomColor: "#38383A",
  },
  headerTitle: {
    color: "#FFFFFF",
    fontSize: 18,
    fontWeight: "700",
  },
  newBtn: {
    backgroundColor: "#007AFF",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
  },
  newBtnText: {
    color: "#FFFFFF",
    fontSize: 13,
    fontWeight: "600",
  },
  list: {
    padding: 8,
  },
  sessionItem: {
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderRadius: 10,
    marginBottom: 4,
  },
  sessionItemActive: {
    backgroundColor: "#2C2C2E",
  },
  sessionInfo: {
    flex: 1,
  },
  sessionTitle: {
    color: "#E5E5EA",
    fontSize: 14,
    fontWeight: "500",
    marginBottom: 4,
  },
  sessionTitleActive: {
    color: "#007AFF",
  },
  sessionMeta: {
    flexDirection: "row",
    gap: 12,
  },
  sessionTime: {
    color: "#636366",
    fontSize: 12,
  },
  sessionCount: {
    color: "#636366",
    fontSize: 12,
  },
  empty: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  emptyText: {
    color: "#636366",
    fontSize: 14,
  },
  divider: {
    height: 0.5,
    backgroundColor: "#38383A",
  },
  hint: {
    color: "#48484A",
    fontSize: 11,
    textAlign: "center",
    paddingVertical: 12,
  },
});
