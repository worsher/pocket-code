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
  Keyboard,
  Alert,
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
import { listLocalFiles, readLocalFile, writeLocalFile } from "./src/services/localFileSystem";
import QuickActions from "./src/components/QuickActions";
import SearchDialog from "./src/components/SearchDialog";
import TerminalScreen from "./src/components/TerminalScreen";
import FilesTab from "./src/components/FilesTab";
import PreviewTab from "./src/components/PreviewTab";
import {
  type AppSettings,
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
} from "./src/store/settings";
import { ProjectProvider, useProject } from "./src/contexts/ProjectContext";
import { WorkspaceProvider, useWorkspace } from "./src/contexts/WorkspaceContext";
import ProjectPromptEditor from "./src/components/ProjectPromptEditor";
import { requestNotificationPermissions } from "./src/services/notifications";
import { tabsForPlatform } from "./src/utils/tabsForPlatform";

function MainScreen() {
  const insets = useSafeAreaInsets();
  const [currentModel, setCurrentModel] = useState("deepseek-v3");
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showSessionDrawer, setShowSessionDrawer] = useState(false);
  const [showFileExplorer, setShowFileExplorer] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [showPromptEditor, setShowPromptEditor] = useState(false);
  // Bottom tab
  const [activeTab, setActiveTab] = useState<"chat" | "terminal" | "files" | "preview">("chat");
  const [previewUrl, setPreviewUrl] = useState<string | undefined>();
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [keyboardVisible, setKeyboardVisible] = useState(false);

  // Track keyboard visibility to hide tab bar
  useEffect(() => {
    const showSub = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow",
      () => setKeyboardVisible(true),
    );
    const hideSub = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide",
      () => setKeyboardVisible(false),
    );
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  // Load settings on mount
  useEffect(() => {
    loadSettings().then((s) => {
      setSettings(s);
      setCurrentModel(s.defaultModel);
      setSettingsLoaded(true);
    });
    requestNotificationPermissions();
  }, []);

  const {
    currentProject,
    currentWorkspaceHandle,
    currentWorkspaceRoot,
    registerRemoteReplica,
  } = useProject();
  const { pushFileChange, pendingFilePath, pendingPreviewUrl, clearPendingPreview } = useWorkspace();

  // Auto-switch to Files tab when navigateToFile is called from chat
  useEffect(() => {
    if (pendingFilePath) {
      setActiveTab("files");
    }
  }, [pendingFilePath]);

  // Auto-switch to Preview tab when navigateToPreview is called
  useEffect(() => {
    if (pendingPreviewUrl) {
      setPreviewUrl(pendingPreviewUrl);
      setActiveTab("preview");
      clearPendingPreview();
    }
  }, [pendingPreviewUrl, clearPendingPreview]);

  const handleSaveSettings = useCallback(async (newSettings: AppSettings) => {
    setSettings(newSettings);
    await saveSettings(newSettings);
  }, []);

  const handleFileChanged = useCallback((path: string, action: "created" | "modified" | "deleted") => {
    pushFileChange({ path, action });
  }, [pushFileChange]);

  const {
    messages,
    isConnected,
    isStreaming,
    streamingPhase,
    currentToolName,
    sessionId,
    authError,
    lastStopReason,
    streamNotice,
    compactionNotice,
    editCutoff,
    goalState,
    goalControl,
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
    requestSyncPull,
    requestSyncFile,
    deleteProjectWorkspace,
  } = useAgent({
    settings,
    model: currentModel,
    customPrompt: currentProject?.customPrompt,
    projectId: currentProject?.id,
    projectName: currentProject?.name,
    workspaceReplicaId: currentProject?.localReplica.id,
    workspaceGeneration: currentProject?.localReplica.generation,
    remoteReplicas: currentProject?.remoteReplicas,
    workspaceHandle: currentWorkspaceHandle,
    workspaceRoot: currentWorkspaceRoot,
    onFileChanged: handleFileChanged,
    onRemoteReplica: registerRemoteReplica,
  });

  const listRef = useRef<FlatList>(null);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);

  // 设备授权失效(token 被开发机拒绝):提示用户重新配对,避免静默断开
  useEffect(() => {
    if (!authError) return;
    Alert.alert("需要重新配对", authError, [
      { text: "稍后", style: "cancel" },
      { text: "去配对", onPress: () => setShowSettings(true) },
    ]);
  }, [authError]);

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
  }, [
    settingsLoaded,
    needsAutoConnect,
    connect,
    disconnect,
    currentProject?.id,
    currentWorkspaceHandle?.generation,
  ]);

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

  // 连接相关设置变化(尤其 Relay 重新配对后的 machineId/token)→ 重连,
  // 让运行中的 WS/RelayClient 用新值重建,而不是沿用构造时固化的旧值
  // (否则配对后当前会话仍用旧 machineId,要新会话才生效)。
  const connIdentity = [
    settings.mode,
    settings.workspaceMode,
    settings.cloudServerUrl,
    settings.toolServerUrl,
    settings.relayServerUrl,
    settings.relayToken,
    settings.relayMachineId,
    settings.authToken,
  ].join("|");
  const connIdentityRef = useRef<string | null>(null);
  useEffect(() => {
    if (!settingsLoaded) return;
    if (connIdentityRef.current === null) {
      // 首次稳定值:只记录,初次连接由上面的 effect 负责
      connIdentityRef.current = connIdentity;
      return;
    }
    if (connIdentityRef.current === connIdentity) return;
    connIdentityRef.current = connIdentity;
    disconnect();
    if (needsAutoConnect) {
      setTimeout(() => connect(), 150);
    }
  }, [connIdentity, settingsLoaded, needsAutoConnect, connect, disconnect]);

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
        onEditResend={!isStreaming && index >= editCutoff ? editAndResend : undefined}
      />
    );
  };

  const handleNewSession = useCallback(() => {
    newSession();
    // Reconnect after clearing
    if (needsAutoConnect) {
      setTimeout(() => connect(), 100);
    }
  }, [newSession, connect, needsAutoConnect]);

  const selectedModel = AVAILABLE_MODELS.find((m) => m.key === currentModel);
  const isGeek = settings.mode === "geek";

  // Project-specific local workspace root resolved from the catalog.
  const localWorkspaceRoot = currentWorkspaceRoot;

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
          <Text style={styles.title} numberOfLines={1}>Pocket Code</Text>
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
            <Text style={styles.modelBadgeText} numberOfLines={1}>
              {selectedModel?.label ?? currentModel}
            </Text>
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

      {/* Tab content — use display to keep all mounted and PTY alive */}
      <View style={styles.flex1}>
        {/* ── Chat Tab ── */}
        <KeyboardAvoidingView
          style={[styles.flex1, activeTab !== "chat" && styles.hidden]}
          behavior="padding"
          keyboardVerticalOffset={insets.top}
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

          {/* Goal 卡片(P16):状态/进度/控制 */}
          {goalState && (
            <View style={styles.goalCard}>
              <View style={[styles.goalDot,
                goalState.status === "active" ? styles.goalDotActive :
                goalState.status === "blocked" ? styles.goalDotBlocked : styles.goalDotPaused]} />
              <View style={styles.goalBody}>
                <Text style={styles.goalText} numberOfLines={1}>{goalState.goal ?? "目标"}</Text>
                <Text style={styles.goalMeta}>
                  第 {goalState.stats.turns}/{goalState.maxTurns ?? "?"} 轮
                  {goalState.stopReason ? ` · ${goalState.stopReason}` : ""}
                </Text>
              </View>
              {goalState.status === "active" ? (
                <TouchableOpacity onPress={() => goalControl("pause")}>
                  <Text style={styles.goalAction}>暂停</Text>
                </TouchableOpacity>
              ) : (
                <TouchableOpacity onPress={() => goalControl("resume")}>
                  <Text style={styles.goalAction}>继续</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity onPress={() => goalControl("cancel")}>
                <Text style={styles.goalCancel}>取消</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* 上下文压缩提示(P15) */}
          {compactionNotice && (
            <View style={styles.streamNoticeBar}>
              <Text style={styles.streamNoticeText}>{compactionNotice}</Text>
            </View>
          )}

          {/* 重试/降级瞬时提醒(P13) */}
          {streamNotice && isStreaming && (
            <View style={styles.streamNoticeBar}>
              <Text style={styles.streamNoticeText}>{streamNotice}</Text>
            </View>
          )}

          {/* 步数上限提示 + 一键继续(P12) */}
          {lastStopReason === "max_steps" && !isStreaming && (
            <View style={styles.maxStepsBanner}>
              <Text style={styles.maxStepsText}>已达步数上限,本轮可能未完成</Text>
              <TouchableOpacity onPress={() => sendMessage("继续完成上一条指令未完成的部分")}>
                <Text style={styles.maxStepsAction}>继续</Text>
              </TouchableOpacity>
            </View>
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

        {/* ── Terminal Tab — always mounted to keep PTY session alive(Android 专属;iOS 沙箱禁 fork/exec 不挂载) ── */}
        {Platform.OS === "android" && (
          <KeyboardAvoidingView
            style={[styles.flex1, activeTab !== "terminal" && styles.hidden]}
            behavior="padding"
            keyboardVerticalOffset={insets.top}
          >
            <TerminalScreen workspaceRoot={localWorkspaceRoot} />
          </KeyboardAvoidingView>
        )}

        {/* ── Files Tab ── */}
        <View style={[styles.flex1, activeTab !== "files" && styles.hidden]}>
          <FilesTab
            requestFileList={isGeek && settings.workspaceMode === "local"
              ? (path: string) => listLocalFiles(path, localWorkspaceRoot)
              : requestFileList}
            requestFileContent={isGeek && settings.workspaceMode === "local"
              ? (path: string) => readLocalFile(path, localWorkspaceRoot)
              : requestFileContent}
            writeFile={isGeek && settings.workspaceMode === "local"
              ? (path: string, content: string) => writeLocalFile(path, content, localWorkspaceRoot)
              : undefined}
            requestSyncPull={requestSyncPull}
            requestSyncFile={requestSyncFile}
            isStreaming={isStreaming}
            workspaceMode={settings.workspaceMode}
            settings={settings}
            projectId={currentProject?.id}
            localWorkspaceRoot={localWorkspaceRoot}
          />
        </View>

        {/* ── Preview Tab ── */}
        <View style={[styles.flex1, activeTab !== "preview" && styles.hidden]}>
          <PreviewTab
            initialUrl={previewUrl}
            settings={settings}
            workspaceRoot={localWorkspaceRoot}
          />
        </View>
      </View>

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
        requestFileList={isGeek && settings.workspaceMode === "local"
          ? (path: string) => listLocalFiles(path, localWorkspaceRoot)
          : requestFileList}
        requestFileContent={isGeek && settings.workspaceMode === "local"
          ? (path: string) => readLocalFile(path, localWorkspaceRoot)
          : requestFileContent}
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

      {/* Bottom Tab Bar — hidden when keyboard is visible */}
      {!keyboardVisible && (
        <View style={styles.tabBar}>
          {tabsForPlatform(Platform.OS).map((tab) => {
            const icons = { chat: "💬", terminal: "💻", files: "📁", preview: "🌐" };
            const labels = { chat: "Chat", terminal: "Terminal", files: "Files", preview: "Preview" };
            const active = activeTab === tab;
            return (
              <TouchableOpacity
                key={tab}
                style={styles.tabItem}
                onPress={() => setActiveTab(tab)}
              >
                <Text style={[styles.tabIcon, active && styles.tabIconActive]}>
                  {icons[tab]}
                </Text>
                <Text style={[styles.tabLabel, active && styles.tabLabelActive]}>
                  {labels[tab]}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      )}
    </View>
  );
}


export default function App() {
  return (
    <SafeAreaProvider>
      <ProjectProvider>
        <WorkspaceProvider>
          <MainScreen />
        </WorkspaceProvider>
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
    gap: 6,
    flexShrink: 1,
  },
  headerRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flexShrink: 0,
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
    flexShrink: 1,
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
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 12,
    borderWidth: 0.5,
    borderColor: "#38383A",
    maxWidth: 90,
  },
  modelBadgeText: {
    color: "#8E8E93",
    fontSize: 12,
    fontWeight: "500",
    flexShrink: 1,
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
  goalCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#1C1C1E",
    borderWidth: 0.5,
    borderColor: "#38383A",
    borderRadius: 8,
    marginHorizontal: 12,
    marginBottom: 4,
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 8,
  },
  goalDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  goalDotActive: { backgroundColor: "#34C759" },
  goalDotPaused: { backgroundColor: "#8E8E93" },
  goalDotBlocked: { backgroundColor: "#FF453A" },
  goalBody: { flex: 1 },
  goalText: {
    color: "#FFFFFF",
    fontSize: 13,
    fontWeight: "500",
  },
  goalMeta: {
    color: "#8E8E93",
    fontSize: 11,
    marginTop: 1,
  },
  goalAction: {
    color: "#0A84FF",
    fontSize: 13,
    fontWeight: "600",
    paddingHorizontal: 6,
  },
  goalCancel: {
    color: "#FF453A",
    fontSize: 13,
    paddingHorizontal: 6,
  },
  streamNoticeBar: {
    backgroundColor: "#1C1C1E",
    borderRadius: 8,
    marginHorizontal: 12,
    marginBottom: 4,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  streamNoticeText: {
    color: "#8E8E93",
    fontSize: 12,
  },
  maxStepsBanner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#1C1C1E",
    borderWidth: 0.5,
    borderColor: "#38383A",
    borderRadius: 8,
    marginHorizontal: 12,
    marginBottom: 4,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  maxStepsText: {
    color: "#8E8E93",
    fontSize: 13,
    flexShrink: 1,
  },
  maxStepsAction: {
    color: "#0A84FF",
    fontSize: 14,
    fontWeight: "600",
    marginLeft: 12,
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
  // ── Tab Bar ──────────────────────────────────────────
  tabBar: {
    flexDirection: "row" as const,
    backgroundColor: "#1C1C1E",
    borderTopWidth: 0.5,
    borderTopColor: "#38383A",
  },
  tabItem: {
    flex: 1,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    paddingVertical: 8,
    gap: 2,
  },
  tabIcon: {
    fontSize: 22,
    opacity: 0.4,
  },
  tabIconActive: {
    opacity: 1,
  },
  tabLabel: {
    color: "#8E8E93",
    fontSize: 10,
    fontWeight: "600" as const,
    letterSpacing: 0.3,
  },
  tabLabelActive: {
    color: "#007AFF",
  },
  hidden: {
    display: "none" as const,
  },
});
