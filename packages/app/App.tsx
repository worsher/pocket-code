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
  TextInput,
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
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={{ flex: 1, backgroundColor: "#000", paddingTop: insets.top }}
        >
          <View style={styles.header}>
            <Text style={styles.title}>VTerm POC Demo</Text>
            <TouchableOpacity onPress={() => setShowTerminalDemo(false)}>
              <Text style={{ color: "#007AFF" }}>Close</Text>
            </TouchableOpacity>
          </View>
          <TerminalView />
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}
interface TextSpan {
  text: string;
  fg: string;
  bg: string;
  bold: boolean;
  underline: boolean;
  italic: boolean;
  reverse: boolean;
}

const KEY_ACTIONS = [
  { label: "ESC", sequence: "\x1b" },
  { label: "TAB", sequence: "\t" },
  { label: "CTRL-C", sequence: "\x03" },
  { label: "UP", sequence: "\x1b[A" },
  { label: "DN", sequence: "\x1b[B" },
  { label: "LT", sequence: "\x1b[D" },
  { label: "RT", sequence: "\x1b[C" },
];

const TerminalView = () => {
  const [rowsData, setRowsData] = useState<TextSpan[][]>([]);
  const [cursor, setCursor] = useState({ x: 0, y: 0 });
  const [blink, setBlink] = useState(true);
  const [inputValue, setInputValue] = useState("");
  const termRef = useRef<PocketTerminal | null>(null);
  const inputRef = useRef<TextInput | null>(null);

  useEffect(() => {
    const term = new PocketTerminal(24, 80);
    termRef.current = term;

    // 启动 PTY！这将派生 /system/bin/sh 并在后台用子线程收发数据
    const success = term.startPty();
    if (!success) {
      term.write("Failed to start Android PTY /system/bin/sh\r\n");
    }

    // 轮询快照获取文本及光标坐标 (后续可通过 C++ 事件 EventCallback 优化)
    const timer = setInterval(() => {
      const buffer = term.getBuffer();
      if (!buffer || buffer.byteLength === 0) return;

      const view = new Uint32Array(buffer);
      const rows = term.getRows();
      const cols = term.getCols();

      const newRowsData: TextSpan[][] = [];
      let idx = 0;

      for (let r = 0; r < rows; r++) {
        const rowSpans: TextSpan[] = [];
        let currentSpan: TextSpan | null = null;

        for (let c = 0; c < cols; c++) {
          const chCode = view[idx++];
          const fgCode = view[idx++];
          const bgCode = view[idx++];
          const flags = view[idx++];

          let fgHex = '#' + ('000000' + (fgCode & 0xFFFFFF).toString(16)).slice(-6);
          let bgHex = '#' + ('000000' + (bgCode & 0xFFFFFF).toString(16)).slice(-6);

          // 临时补丁：如果前端没初始化确切的 vterm 默认色彩，它通常会把默认全算作 #000000
          if (fgHex === '#000000' && bgHex === '#000000') {
            fgHex = '#FFFFFF'; // 黑底白字默认
          }

          const bold = (flags & (1 << 0)) !== 0;
          const underline = (flags & (1 << 1)) !== 0;
          const italic = (flags & (1 << 2)) !== 0;
          const reverse = (flags & (1 << 4)) !== 0;

          const char = chCode === 0 ? ' ' : String.fromCodePoint(chCode);

          if (!currentSpan) {
            currentSpan = { text: char, fg: fgHex, bg: bgHex, bold, underline, italic, reverse };
          } else if (
            currentSpan.fg === fgHex &&
            currentSpan.bg === bgHex &&
            currentSpan.bold === bold &&
            currentSpan.underline === underline &&
            currentSpan.italic === italic &&
            currentSpan.reverse === reverse
          ) {
            currentSpan.text += char;
          } else {
            rowSpans.push(currentSpan);
            currentSpan = { text: char, fg: fgHex, bg: bgHex, bold, underline, italic, reverse };
          }
        }
        if (currentSpan) {
          rowSpans.push(currentSpan);
        }
        newRowsData.push(rowSpans);
      }

      setRowsData(newRowsData);
      setCursor({ x: term.getCursorX(), y: term.getCursorY() });
    }, 100);

    // 光标闪烁定时器
    const blinkTimer = setInterval(() => {
      setBlink((prev) => !prev);
    }, 500);

    return () => {
      term.stopPty();
      clearInterval(timer);
      clearInterval(blinkTimer);
    };
  }, []);

  // FontSize = 13 取近似等宽宽高
  const charWidth = 7.8;
  const lineHeight = 16;

  return (
    <View style={{ flex: 1 }}>
      <TouchableOpacity
        activeOpacity={1}
        style={{ flex: 1, backgroundColor: "#000", padding: 10, position: 'relative' }}
        onPress={() => {
          console.log("TerminalView: Touched, focusing input...");
          inputRef.current?.focus();
        }}
      >
        {rowsData.map((row, rIdx) => (
          <View key={rIdx} style={{ flexDirection: 'row', height: lineHeight }}>
            {row.map((span, sIdx) => {
              const effectiveFg = span.reverse ? span.bg : span.fg;
              const effectiveBg = span.reverse ? span.fg : span.bg;

              return (
                <Text
                  key={sIdx}
                  style={{
                    fontFamily: Platform.OS === "ios" ? "Courier" : "monospace",
                    color: effectiveFg,
                    backgroundColor: effectiveBg === '#000000' ? 'transparent' : effectiveBg,
                    fontSize: 13,
                    lineHeight: lineHeight,
                    fontWeight: span.bold ? 'bold' : 'normal',
                    fontStyle: span.italic ? 'italic' : 'normal',
                    textDecorationLine: span.underline ? 'underline' : 'none',
                  }}
                >
                  {span.text}
                </Text>
              );
            })}
          </View>
        ))}

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

        {/* 隐形键盘输入捕获 */}
        <TextInput
          ref={inputRef}
          autoFocus
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          textContentType="none"
          keyboardType={Platform.OS === "android" ? "visible-password" : "ascii-capable"} // visible-password is the only way to disable composing and smart quotes on Android
          smartInsertDelete={false}
          blurOnSubmit={false}
          style={{
            position: "absolute",
            top: -100, // Move off-screen instead of just 0,0
            left: -100,
            width: 1,
            height: 1,
          }}
          onSubmitEditing={() => {
            if (!termRef.current) return;
            console.log(`[Terminal] onSubmitEditing: Writing \\r`);
            termRef.current.write("\r");
          }}
          onKeyPress={(e) => {
            if (!termRef.current) return;
            const key = e.nativeEvent.key;
            console.log(`[Terminal] onKeyPress: ${key}`);
            if (key === "Enter") {
              // This might not fire on Android with visible-password, but we keep it for iOS or other keyboards
              console.log(`[Terminal] Writing \\r from onKeyPress`);
              termRef.current.write("\r");
            } else if (key === "Backspace") {
              console.log(`[Terminal] Writing \\x7f`);
              termRef.current.write("\x7f"); // Use DEL (127) for generic backspace
            }
          }}
          onChangeText={(text) => {
            if (!termRef.current) return;
            console.log(`[Terminal] onChangeText full: '${text}'`);
            const prev = (inputRef.current as any)._lastText || "";

            if (text.length > prev.length) {
              let added = text.slice(prev.length);
              added = added.replace(/\n/g, "");
              if (added.length > 0) {
                console.log(`[Terminal] Writing chunk: '${added}'`);
                termRef.current.write(added);
              }
            } else if (text.length < prev.length) {
              console.log(`[Terminal] onChangeText detected deletion. Previous len: ${prev.length}, current: ${text.length}`);
              const deletedCount = prev.length - text.length;
              for (let i = 0; i < deletedCount; i++) {
                termRef.current.write("\x7f");
              }
            }

            (inputRef.current as any)._lastText = text;
          }}
        />
      </TouchableOpacity>

      {/* 辅助操作栏 */}
      <View style={{ flexDirection: "row", backgroundColor: "#1C1C1E", borderTopWidth: 1, borderTopColor: "#38383A", paddingVertical: 8, paddingHorizontal: 10 }}>
        <FlatList
          horizontal
          showsHorizontalScrollIndicator={false}
          data={KEY_ACTIONS}
          keyExtractor={(item) => item.label}
          renderItem={({ item }) => (
            <TouchableOpacity
              style={{
                backgroundColor: "#2C2C2E",
                paddingHorizontal: 12,
                paddingVertical: 8,
                borderRadius: 6,
                marginRight: 8,
              }}
              onPress={() => termRef.current?.write(item.sequence)}
            >
              <Text style={{ color: "#FFF", fontSize: 13, fontWeight: "600" }}>{item.label}</Text>
            </TouchableOpacity>
          )}
        />
      </View>
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
