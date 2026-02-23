import React, { useEffect, useRef, useState, useCallback } from "react";
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
  AppState,
  Modal,
  type AppStateStatus,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import {
  SafeAreaProvider,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import { useAgent, type Message, AVAILABLE_MODELS } from "./src/hooks/useAgent";
import ChatMessage from "./src/components/ChatMessage";
import ChatInput from "./src/components/ChatInput";
import SettingsScreen from "./src/components/Settings/SettingsScreen";
import SessionDrawer from "./src/components/SessionDrawer";
import FileExplorer from "./src/components/FileExplorer";
import { listLocalFiles, readLocalFile } from "./src/services/localFileSystem";
import QuickActions from "./src/components/QuickActions";
import SearchDialog from "./src/components/SearchDialog";
import { PocketTerminal } from "pocket-terminal-module";
import {
  type AppSettings,
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
} from "./src/store/settings";
import { ProjectProvider, useProject } from "./src/contexts/ProjectContext";
import ProjectPromptEditor from "./src/components/ProjectPromptEditor";
import { requestNotificationPermissions } from "./src/services/notifications";

function MainScreen() {
  const insets = useSafeAreaInsets();
  const [currentModel, setCurrentModel] = useState("deepseek-v3");
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showSessionDrawer, setShowSessionDrawer] = useState(false);
  const [showFileExplorer, setShowFileExplorer] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [showPromptEditor, setShowPromptEditor] = useState(false);
  const [showTerminalDemo, setShowTerminalDemo] = useState(false);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [settingsLoaded, setSettingsLoaded] = useState(false);

  // Load settings on mount
  useEffect(() => {
    loadSettings().then((s) => {
      setSettings(s);
      setCurrentModel(s.defaultModel);
      setSettingsLoaded(true);
    });
    requestNotificationPermissions();
  }, []);

  const { currentProject } = useProject();

  const handleSaveSettings = useCallback(async (newSettings: AppSettings) => {
    setSettings(newSettings);
    await saveSettings(newSettings);
  }, []);

  const {
    messages,
    isConnected,
    isStreaming,
    streamingPhase,
    currentToolName,
    sessionId,
    needsAutoConnect,
    connect,
    disconnect,
    stopStreaming,
    sendMessage,
    editAndResend,
    loadSession,
    newSession,
    requestFileList,
    requestFileContent,
    deleteProjectWorkspace,
  } = useAgent({ settings, model: currentModel, customPrompt: currentProject?.customPrompt, projectId: currentProject?.id });

  const listRef = useRef<FlatList>(null);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);

  // Connect on mount (after settings loaded) and reconnect when settings change.
  // In geek+local mode, skip auto-connect (WS only needed for runCommand fallback).
  useEffect(() => {
    if (!settingsLoaded) return;
    if (!needsAutoConnect) {
      // Geek + local: disconnect if previously connected, don't auto-connect
      disconnect();
      return;
    }
    connect();
    return () => disconnect();
  }, [settingsLoaded, needsAutoConnect, connect]);

  // Auto-reconnect when app comes back to foreground
  useEffect(() => {
    if (!needsAutoConnect) return;
    const subscription = AppState.addEventListener("change", (nextState) => {
      if (
        appStateRef.current.match(/inactive|background/) &&
        nextState === "active"
      ) {
        if (!isConnected) {
          connect();
        }
      }
      appStateRef.current = nextState;
    });

    return () => subscription.remove();
  }, [needsAutoConnect, isConnected, connect]);

  const scrollToEnd = () => {
    if (messages.length > 0) {
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 100);
    }
  };

  useEffect(scrollToEnd, [messages]);

  const renderItem = ({ item, index }: { item: Message; index: number }) => {
    const isLast = index === messages.length - 1;
    return (
      <ChatMessage
        message={item}
        streamingPhase={isLast && isStreaming ? streamingPhase : undefined}
        currentToolName={isLast && isStreaming ? currentToolName : undefined}
        onEditResend={!isStreaming ? editAndResend : undefined}
      />
    );
  };

  const handleNewSession = useCallback(() => {
    newSession();
    // Reconnect after clearing
    setTimeout(() => connect(), 100);
  }, [newSession, connect]);

  const selectedModel = AVAILABLE_MODELS.find((m) => m.key === currentModel);
  const isGeek = settings.mode === "geek";

  // Don't render until settings loaded
  if (!settingsLoaded) {
    return (
      <View style={[styles.container, styles.emptyState]}>
        <Text style={styles.emptySubtitle}>Loading...</Text>
      </View>
    );
  }

  return (
    <View
      style={[
        styles.container,
        { paddingTop: insets.top, paddingBottom: insets.bottom },
      ]}
    >
      <StatusBar style="light" />

      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          {/* Hamburger menu */}
          <TouchableOpacity
            style={styles.menuBtn}
            onPress={() => setShowSessionDrawer(true)}
          >
            <Text style={styles.menuIcon}>☰</Text>
          </TouchableOpacity>
          <Text style={styles.title}>Pocket Code</Text>
          {isGeek && (
            <View style={styles.geekBadge}>
              <Text style={styles.geekBadgeText}>⚡ 极客</Text>
            </View>
          )}
        </View>
        <View style={styles.headerRight}>
          {/* Model Selector */}
          <TouchableOpacity
            style={styles.modelBadge}
            onPress={() => setShowModelPicker(true)}
          >
            <Text style={styles.modelBadgeText}>
              {selectedModel?.label ?? currentModel}
            </Text>
          </TouchableOpacity>
          {/* Terminal Demo Button */}
          <TouchableOpacity
            style={styles.settingsBtn}
            onPress={() => setShowTerminalDemo(true)}
          >
            <Text style={styles.settingsIcon}>💻</Text>
          </TouchableOpacity>
          {/* Search Button */}
          <TouchableOpacity
            style={styles.settingsBtn}
            onPress={() => setShowSearch(true)}
          >
            <Text style={styles.settingsIcon}>🔍</Text>
          </TouchableOpacity>
          {/* File Explorer Button */}
          <TouchableOpacity
            style={styles.settingsBtn}
            onPress={() => setShowFileExplorer(true)}
          >
            <Text style={styles.settingsIcon}>📁</Text>
          </TouchableOpacity>
          {/* Settings Button */}
          <TouchableOpacity
            style={styles.settingsBtn}
            onPress={() => setShowSettings(true)}
          >
            <Text style={styles.settingsIcon}>⚙️</Text>
          </TouchableOpacity>
          {/* Connection Status — hide in geek+local mode (no WS needed) */}
          {needsAutoConnect && (
            <TouchableOpacity
              style={[
                styles.statusBadge,
                isConnected ? styles.connected : styles.disconnected,
              ]}
              onPress={isConnected ? disconnect : connect}
            >
              <View
                style={[
                  styles.dot,
                  isConnected ? styles.dotGreen : styles.dotRed,
                ]}
              />
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* Content + Input */}
      <KeyboardAvoidingView
        style={styles.flex1}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        keyboardVerticalOffset={Platform.OS === "ios" ? insets.top : 0}
      >
        {/* Messages */}
        {messages.length === 0 ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyTitle}>Pocket Code</Text>
            <Text style={styles.emptySubtitle}>
              Your AI coding agent on mobile
            </Text>
            <Text style={styles.emptyHint}>
              {isGeek
                ? `极客模式已启用 ⚡\n直接调用 AI API`
                : `云端模式 ☁️\n通过 Server 中转`}
            </Text>
            <Text style={[styles.emptyHint, { marginTop: 16 }]}>
              Try: "Create a simple Express server" {"\n"}
              or: "Help me fix the bug in app.ts"
            </Text>
          </View>
        ) : (
          <FlatList
            ref={listRef}
            data={messages}
            renderItem={renderItem}
            keyExtractor={(item) => item.id}
            style={styles.messageList}
            contentContainerStyle={styles.messageListContent}
            keyboardShouldPersistTaps="handled"
          />
        )}

        {/* Quick Actions */}
        <QuickActions
          onSend={sendMessage}
          disabled={isStreaming || (!isGeek && !isConnected)}
        />

        {/* Input */}
        <ChatInput
          onSend={sendMessage}
          onStop={stopStreaming}
          isStreaming={isStreaming}
          disabled={isStreaming || (!isGeek && !isConnected)}
        />
      </KeyboardAvoidingView>

      {/* Search Dialog */}
      <SearchDialog
        visible={showSearch}
        onClose={() => setShowSearch(false)}
        onSelectSession={loadSession}
      />

      {/* Session Drawer */}
      <SessionDrawer
        visible={showSessionDrawer}
        currentSessionId={sessionId}
        onClose={() => setShowSessionDrawer(false)}
        onSelectSession={loadSession}
        onNewSession={handleNewSession}
        onEditPrompt={() => {
          setShowSessionDrawer(false);
          setTimeout(() => setShowPromptEditor(true), 250);
        }}
        onDeleteWorkspace={deleteProjectWorkspace}
      />

      {/* Project Prompt Editor */}
      <ProjectPromptEditor
        visible={showPromptEditor}
        onClose={() => setShowPromptEditor(false)}
      />

      {/* File Explorer */}
      <FileExplorer
        visible={showFileExplorer}
        onClose={() => setShowFileExplorer(false)}
        requestFileList={isGeek && settings.workspaceMode === "local" ? listLocalFiles : requestFileList}
        requestFileContent={isGeek && settings.workspaceMode === "local" ? readLocalFile : requestFileContent}
      />

      {/* Model Picker Modal */}
      <Modal
        visible={showModelPicker}
        transparent
        animationType="fade"
        onRequestClose={() => setShowModelPicker(false)}
      >
        <TouchableOpacity
          style={styles.modalOverlay}
          activeOpacity={1}
          onPress={() => setShowModelPicker(false)}
        >
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Select Model</Text>
            {AVAILABLE_MODELS.map((m) => (
              <TouchableOpacity
                key={m.key}
                style={[
                  styles.modelOption,
                  m.key === currentModel && styles.modelOptionActive,
                ]}
                onPress={() => {
                  setCurrentModel(m.key);
                  setShowModelPicker(false);
                }}
              >
                <View style={styles.modelOptionLeft}>
                  <Text
                    style={[
                      styles.modelOptionLabel,
                      m.key === currentModel && styles.modelOptionLabelActive,
                    ]}
                  >
                    {m.label}
                  </Text>
                  <Text style={styles.modelOptionDesc}>{m.description}</Text>
                </View>
                {m.key === currentModel && (
                  <Text style={styles.checkmark}>✓</Text>
                )}
              </TouchableOpacity>
            ))}
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Settings Modal */}
      <Modal
        visible={showSettings}
        animationType="slide"
        onRequestClose={() => setShowSettings(false)}
      >
        <View style={{ flex: 1, paddingTop: insets.top }}>
          <SettingsScreen
            settings={settings}
            onSave={handleSaveSettings}
            onClose={() => setShowSettings(false)}
          />
        </View>
      </Modal>

      {/* Terminal Demo Modal */}
      <Modal
        visible={showTerminalDemo}
        animationType="slide"
        onRequestClose={() => setShowTerminalDemo(false)}
      >
        <View style={{ flex: 1, backgroundColor: "#000", paddingTop: insets.top }}>
          <View style={styles.header}>
            <Text style={styles.title}>VTerm POC Demo</Text>
            <TouchableOpacity onPress={() => setShowTerminalDemo(false)}>
              <Text style={{ color: "#007AFF" }}>Close</Text>
            </TouchableOpacity>
          </View>
          <TerminalView />
        </View>
      </Modal>
    </View>
  );
}
const TerminalView = () => {
  const [text, setText] = useState("");
  const [cursor, setCursor] = useState({ x: 0, y: 0 });
  const [blink, setBlink] = useState(true);
  const termRef = useRef<PocketTerminal | null>(null);

  useEffect(() => {
    const term = new PocketTerminal(24, 80);
    termRef.current = term;

    term.write("Welcome to Pocket Terminal Native Console v0.1-alpha!\r\n");
    term.write("---------------------------------------------------\r\n\r\n");
    term.write("$ echo 'Hello from React Native & C++ JSI Core'\r\n");
    term.write("Hello from React Native & C++ JSI Core\r\n");
    term.write("$ ");

    // 轮询快照获取文本及光标坐标 (后续可通过 EventCallback 优化)
    const timer = setInterval(() => {
      setText(term.getScreenText() || "");
      setCursor({ x: term.getCursorX(), y: term.getCursorY() });
    }, 100);

    // 光标闪烁定时器
    const blinkTimer = setInterval(() => {
      setBlink((prev) => !prev);
    }, 500);

    return () => {
      clearInterval(timer);
      clearInterval(blinkTimer);
    };
  }, []);

  // 假设固定的等宽字体字符宽高
  // FontSize = 13 时, 等宽字符大致尺寸（这些为估算值，实际可以更精确）
  const charWidth = 7.8;
  const lineHeight = 16;

  return (
    <View style={{ flex: 1, backgroundColor: "#000", padding: 10, position: 'relative' }}>
      {/* 采用等宽字体呈现字符控制台 */}
      <Text style={{ fontFamily: Platform.OS === "ios" ? "Courier" : "monospace", color: "#FFF", fontSize: 13, lineHeight }}>
        {text}
      </Text>

      {/* 渲染模拟光标块 */}
      <View
        style={{
          position: "absolute",
          top: 10 + cursor.y * lineHeight,     // 考虑 padding 10
          left: 10 + cursor.x * charWidth,     // 考虑 padding 10
          width: charWidth,
          height: lineHeight,
          backgroundColor: "#FFF",
          opacity: blink ? 0.7 : 0,            // 闪烁效果
        }}
      />
    </View>
  );
};

export default function App() {
  return (
    <SafeAreaProvider>
      <ProjectProvider>
        <MainScreen />
      </ProjectProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#000000",
  },
  flex1: {
    flex: 1,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 0.5,
    borderBottomColor: "#38383A",
  },
  headerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  headerRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  menuBtn: {
    padding: 4,
    marginRight: 4,
  },
  menuIcon: {
    color: "#FFFFFF",
    fontSize: 20,
  },
  title: {
    color: "#FFFFFF",
    fontSize: 18,
    fontWeight: "700",
  },
  geekBadge: {
    backgroundColor: "#1B3A1B",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
    borderWidth: 0.5,
    borderColor: "#34C759",
  },
  geekBadgeText: {
    color: "#34C759",
    fontSize: 11,
    fontWeight: "600",
  },
  modelBadge: {
    backgroundColor: "#1C1C1E",
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 12,
    borderWidth: 0.5,
    borderColor: "#38383A",
  },
  modelBadgeText: {
    color: "#8E8E93",
    fontSize: 12,
    fontWeight: "500",
  },
  settingsBtn: {
    padding: 4,
  },
  settingsIcon: {
    fontSize: 18,
  },
  statusBadge: {
    padding: 8,
    borderRadius: 12,
  },
  connected: {
    backgroundColor: "#1B3A2A",
  },
  disconnected: {
    backgroundColor: "#3A1B1B",
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  dotGreen: {
    backgroundColor: "#34C759",
  },
  dotRed: {
    backgroundColor: "#FF453A",
  },
  messageList: {
    flex: 1,
  },
  messageListContent: {
    paddingVertical: 8,
  },
  emptyState: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 40,
  },
  emptyTitle: {
    color: "#FFFFFF",
    fontSize: 28,
    fontWeight: "700",
    marginBottom: 8,
  },
  emptySubtitle: {
    color: "#8E8E93",
    fontSize: 16,
    marginBottom: 24,
  },
  emptyHint: {
    color: "#636366",
    fontSize: 14,
    textAlign: "center",
    lineHeight: 22,
  },
  // Modal
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    justifyContent: "center",
    alignItems: "center",
    padding: 32,
  },
  modalContent: {
    width: "100%",
    backgroundColor: "#1C1C1E",
    borderRadius: 16,
    padding: 20,
  },
  modalTitle: {
    color: "#FFFFFF",
    fontSize: 18,
    fontWeight: "700",
    marginBottom: 16,
    textAlign: "center",
  },
  modelOption: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 10,
    marginBottom: 4,
  },
  modelOptionActive: {
    backgroundColor: "#2C2C2E",
  },
  modelOptionLeft: {
    flex: 1,
  },
  modelOptionLabel: {
    color: "#E5E5EA",
    fontSize: 15,
    fontWeight: "500",
  },
  modelOptionLabelActive: {
    color: "#007AFF",
  },
  modelOptionDesc: {
    color: "#636366",
    fontSize: 12,
    marginTop: 2,
  },
  checkmark: {
    color: "#007AFF",
    fontSize: 18,
    fontWeight: "700",
    marginLeft: 12,
  },
});
