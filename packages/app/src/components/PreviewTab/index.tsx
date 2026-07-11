import React, { useState, useRef, useCallback } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
} from "react-native";
import { WebView } from "react-native-webview";
import type { AppSettings } from "../../store/settings";
import { maybeRewriteToTunnel } from "./tunnelUrl";
import { createBuildSession } from "../../services/previewBuilder/orchestrator";
import { createExpoIo } from "../../services/previewBuilder/ioExpo";
import { ensureBuilderAssets } from "../../services/previewBuilder/assets";
import { getProjectWorkspaceRoot, getDefaultWorkspace } from "../../services/localFileSystem";

interface Props {
  /** URL to load initially, set externally when a dev server is detected */
  initialUrl?: string;
  /** App 设置:relay 模式下用于构造中继隧道预览 URL */
  settings?: AppSettings;
  /** 当前项目 id:本地构建的工作区定位(getProjectWorkspaceRoot) */
  projectId?: string;
}

export default function PreviewTab({ initialUrl, settings, projectId }: Props) {
  const [url, setUrl] = useState(initialUrl || "http://localhost:3000");
  const [inputUrl, setInputUrl] = useState(url);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const webViewRef = useRef<WebView>(null);
  const [tunnelInfo, setTunnelInfo] = useState<{ relayTunnelMode?: "subdomain" | "path"; relayTunnelBaseDomain?: string | null }>({});

  // Sync when initialUrl changes from outside
  React.useEffect(() => {
    if (initialUrl && initialUrl !== url) {
      setUrl(initialUrl);
      setInputUrl(initialUrl);
      setError(null);
    }
  }, [initialUrl]);

  // relay 模式下一次性拉取 /health,取隧道模式(subdomain/path)与子域基础域名。
  // 旧 relay 不返回这些字段 / 请求失败时静默回退 path 模式(buildTunnelUrl 的默认行为)。
  React.useEffect(() => {
    if (!settings || settings.workspaceMode !== "relay" || !settings.relayServerUrl) return;
    const httpBase = settings.relayServerUrl.replace(/^ws:\/\//, "http://").replace(/^wss:\/\//, "https://").replace(/\/relay\/?$/, "");
    let cancelled = false;
    fetch(`${httpBase}/health`)
      .then((r) => r.json())
      .then((j) => { if (!cancelled && j && (j.tunnelMode === "subdomain" || j.tunnelMode === "path")) {
        setTunnelInfo({ relayTunnelMode: j.tunnelMode, relayTunnelBaseDomain: j.tunnelBaseDomain ?? null });
      }})
      .catch(() => { /* 旧 relay / 拉取失败:静默,buildTunnelUrl 回退 path */ });
    return () => { cancelled = true; };
  }, [settings?.relayServerUrl, settings?.workspaceMode]);

  const handleGo = useCallback(() => {
    let target = inputUrl.trim();
    if (!target) return;
    // relay 模式:把 localhost/裸端口改写为中继隧道 URL
    const tunnel = maybeRewriteToTunnel(target, settings ? { ...settings, ...tunnelInfo } : undefined);
    if (tunnel) {
      target = tunnel;
    } else if (!target.startsWith("http://") && !target.startsWith("https://")) {
      target = "http://" + target;
    }
    setUrl(target);
    setInputUrl(target);
    setError(null);
  }, [inputUrl, settings, tunnelInfo]);

  const handleRefresh = useCallback(() => {
    webViewRef.current?.reload();
  }, []);

  const handleGoBack = useCallback(() => {
    webViewRef.current?.goBack();
  }, []);

  const handleGoForward = useCallback(() => {
    webViewRef.current?.goForward();
  }, []);

  // ── 本地构建(esbuild-wasm 离线预览) ──────────────────
  const [buildState, setBuildState] = useState<"idle" | "preparing" | "building">("idle");
  const [buildMsg, setBuildMsg] = useState<string | null>(null);
  const [builderHtmlUri, setBuilderHtmlUri] = useState<string | null>(null);
  const [builderDirUri, setBuilderDirUri] = useState<string | null>(null);
  const builderRef = useRef<WebView>(null);
  const sessionRef = useRef<ReturnType<typeof createBuildSession> | null>(null);

  const workspaceRoot = getProjectWorkspaceRoot(projectId);

  const teardownBuilder = useCallback(() => {
    sessionRef.current?.cancelled();
    sessionRef.current = null;
    setBuildState("idle");
  }, []);

  const handleLocalBuild = useCallback(async () => {
    if (buildState !== "idle") { teardownBuilder(); return; } // 再点=取消
    setBuildMsg(null);
    setBuildState("preparing");
    let assets: { htmlUri: string; dirUri: string };
    try {
      assets = await ensureBuilderAssets();
    } catch {
      setBuildMsg("构建器初始化失败");
      setBuildState("idle");
      return;
    }
    setBuilderHtmlUri(assets.htmlUri);
    setBuilderDirUri(assets.dirUri);

    const io = createExpoIo(workspaceRoot);
    sessionRef.current = createBuildSession(io, {
      sendToWebView: (msg) => {
        const payload = JSON.stringify(JSON.stringify(msg));
        builderRef.current?.injectJavaScript(`window.__pcHost(${payload}); true;`);
      },
      onStatus: (t) => setBuildMsg(t),
      onSuccess: () => {
        teardownBuilder();
        setBuildMsg(null);
        const distUrl = `${workspaceRoot ?? getDefaultWorkspace()}/dist/index.html`;
        setUrl(distUrl);
        setInputUrl(distUrl);
        setError(null);
      },
      onError: (m) => {
        teardownBuilder();
        setBuildMsg(m);
      },
    });
    setBuildState("building"); // builder WebView 由 building 状态触发挂载,onMessage 驱动 session
  }, [buildState, teardownBuilder, workspaceRoot]);

  // 初始化超时守卫:15s 未进入成功/失败即判初始化失败
  React.useEffect(() => {
    if (buildState !== "building") return;
    const t = setTimeout(() => {
      if (sessionRef.current) {
        teardownBuilder();
        setBuildMsg("构建器初始化失败");
      }
    }, 15000);
    return () => clearTimeout(t);
  }, [buildState, teardownBuilder]);

  return (
    <View style={styles.container}>
      {/* URL Bar */}
      <View style={styles.urlBar}>
        <TextInput
          style={styles.urlInput}
          value={inputUrl}
          onChangeText={setInputUrl}
          onSubmitEditing={handleGo}
          placeholder="http://localhost:3000"
          placeholderTextColor="#636366"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          returnKeyType="go"
          selectTextOnFocus
        />
        <TouchableOpacity style={styles.goBtn} onPress={handleGo}>
          <Text style={styles.goBtnText}>Go</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.goBtn, buildState !== "idle" && styles.buildBtnActive]}
          onPress={handleLocalBuild}
        >
          <Text style={styles.goBtnText}>{buildState === "idle" ? "构建" : "取消"}</Text>
        </TouchableOpacity>
      </View>

      {(buildState !== "idle" || buildMsg) && (
        <View style={styles.buildBar}>
          {buildState !== "idle" && <ActivityIndicator size="small" color="#FF9F0A" />}
          <Text style={styles.buildBarText} numberOfLines={2}>
            {buildMsg ?? (buildState === "preparing" ? "准备构建器…" : "构建中…")}
          </Text>
        </View>
      )}

      {/* WebView */}
      <View style={styles.webViewContainer}>
        {error ? (
          <View style={styles.errorContainer}>
            <Text style={styles.errorIcon}>!</Text>
            <Text style={styles.errorTitle}>无法加载页面</Text>
            <Text style={styles.errorText}>{error}</Text>
            <TouchableOpacity style={styles.retryBtn} onPress={() => { setError(null); handleRefresh(); }}>
              <Text style={styles.retryText}>重试</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <WebView
            ref={webViewRef}
            source={{ uri: url }}
            style={styles.webView}
            onLoadStart={() => setLoading(true)}
            onLoadEnd={() => setLoading(false)}
            onError={(e) => {
              setLoading(false);
              setError(e.nativeEvent.description || "加载失败");
            }}
            onHttpError={(e) => {
              if (e.nativeEvent.statusCode >= 400) {
                setError(`HTTP ${e.nativeEvent.statusCode}`);
              }
            }}
            onNavigationStateChange={(navState) => {
              setCanGoBack(navState.canGoBack);
              setCanGoForward(navState.canGoForward);
              if (navState.url) {
                setInputUrl(navState.url);
              }
            }}
            javaScriptEnabled
            domStorageEnabled
            allowsInlineMediaPlayback
            originWhitelist={["http://*", "https://*", "file://*"]}
            allowFileAccess
            allowFileAccessFromFileURLs
            allowingReadAccessToURL={workspaceRoot ?? getDefaultWorkspace()}
          />
        )}
        {buildState === "building" && builderHtmlUri && builderDirUri && (
          <WebView
            ref={builderRef}
            source={{ uri: builderHtmlUri }}
            style={styles.builderHidden}
            javaScriptEnabled
            originWhitelist={["*"]}
            allowFileAccess
            allowFileAccessFromFileURLs
            allowingReadAccessToURL={builderDirUri}
            onMessage={(e) => { sessionRef.current?.handleBuilderMessage(e.nativeEvent.data); }}
            onError={() => { teardownBuilder(); setBuildMsg("构建器初始化失败"); }}
          />
        )}
        {loading && (
          <View style={styles.loadingOverlay}>
            <ActivityIndicator size="small" color="#007AFF" />
          </View>
        )}
      </View>

      {/* Bottom Toolbar */}
      <View style={styles.toolbar}>
        <TouchableOpacity
          style={[styles.toolBtn, !canGoBack && styles.toolBtnDisabled]}
          onPress={handleGoBack}
          disabled={!canGoBack}
        >
          <Text style={[styles.toolBtnText, !canGoBack && styles.toolBtnTextDisabled]}>
            {"<"}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.toolBtn, !canGoForward && styles.toolBtnDisabled]}
          onPress={handleGoForward}
          disabled={!canGoForward}
        >
          <Text style={[styles.toolBtnText, !canGoForward && styles.toolBtnTextDisabled]}>
            {">"}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.toolBtn} onPress={handleRefresh}>
          <Text style={styles.toolBtnText}>R</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#000000",
  },
  urlBar: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderBottomWidth: 0.5,
    borderBottomColor: "#38383A",
    gap: 6,
  },
  urlInput: {
    flex: 1,
    backgroundColor: "#1C1C1E",
    color: "#FFFFFF",
    fontSize: 13,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
    fontFamily: "monospace",
  },
  goBtn: {
    backgroundColor: "#007AFF",
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
  },
  goBtnText: {
    color: "#FFFFFF",
    fontSize: 13,
    fontWeight: "600",
  },
  buildBtnActive: {
    backgroundColor: "#FF9F0A",
  },
  buildBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: "#1C1C1E",
    borderBottomWidth: 0.5,
    borderBottomColor: "#38383A",
  },
  buildBarText: {
    color: "#FF9F0A",
    fontSize: 12,
    flex: 1,
    fontFamily: "monospace",
  },
  builderHidden: {
    position: "absolute",
    width: 1,
    height: 1,
    opacity: 0,
  },
  webViewContainer: {
    flex: 1,
    position: "relative",
  },
  webView: {
    flex: 1,
    backgroundColor: "#FFFFFF",
  },
  loadingOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: 3,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "rgba(0,122,255,0.1)",
  },
  errorContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 32,
  },
  errorIcon: {
    fontSize: 40,
    color: "#FF453A",
    fontWeight: "700",
    marginBottom: 12,
  },
  errorTitle: {
    color: "#FFFFFF",
    fontSize: 18,
    fontWeight: "600",
    marginBottom: 8,
  },
  errorText: {
    color: "#8E8E93",
    fontSize: 14,
    textAlign: "center",
    marginBottom: 20,
  },
  retryBtn: {
    backgroundColor: "#007AFF",
    paddingHorizontal: 24,
    paddingVertical: 10,
    borderRadius: 8,
  },
  retryText: {
    color: "#FFFFFF",
    fontSize: 14,
    fontWeight: "600",
  },
  toolbar: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    paddingVertical: 8,
    borderTopWidth: 0.5,
    borderTopColor: "#38383A",
    gap: 24,
  },
  toolBtn: {
    width: 40,
    height: 32,
    borderRadius: 6,
    backgroundColor: "#2C2C2E",
    justifyContent: "center",
    alignItems: "center",
  },
  toolBtnDisabled: {
    opacity: 0.3,
  },
  toolBtnText: {
    color: "#FFFFFF",
    fontSize: 16,
    fontWeight: "600",
    fontFamily: "monospace",
  },
  toolBtnTextDisabled: {
    color: "#636366",
  },
});
