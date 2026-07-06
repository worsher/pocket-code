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

interface Props {
  /** URL to load initially, set externally when a dev server is detected */
  initialUrl?: string;
  /** App 设置:relay 模式下用于构造中继隧道预览 URL */
  settings?: AppSettings;
}

// relayServerUrl 形如 ws://host:3200 → http://host:3200/t/<machineId>/<port>/
function buildTunnelUrl(relayServerUrl: string, machineId: string, port: number): string {
  const httpBase = relayServerUrl.replace(/^ws:\/\//, "http://").replace(/^wss:\/\//, "https://");
  return `${httpBase.replace(/\/$/, "")}/t/${machineId}/${port}/`;
}

/**
 * relay 模式下,把用户输入的 `localhost:N` / `127.0.0.1:N` / 裸端口 `N`
 * 改写为中继隧道 URL。非 localhost/裸端口的输入保持原样。
 * 非 relay 模式或缺少 relay 配置时返回 null(不改写)。
 */
function maybeRewriteToTunnel(input: string, settings?: AppSettings): string | null {
  if (!settings || settings.workspaceMode !== "relay") return null;
  const { relayServerUrl, relayMachineId } = settings;
  if (!relayServerUrl || !relayMachineId) return null;

  // 已经是隧道 URL,不重复改写
  if (/\/t\/[^/]+\/\d+/.test(input)) return null;

  // 裸端口: "3000"
  const bare = input.match(/^(\d{1,5})$/);
  if (bare) {
    return buildTunnelUrl(relayServerUrl, relayMachineId, parseInt(bare[1], 10));
  }
  // localhost / 127.0.0.1 (可带 http:// 前缀) + 端口 + 可选路径
  const loc = input.match(/^(?:https?:\/\/)?(?:localhost|127\.0\.0\.1)(?::(\d{1,5}))?(\/.*)?$/i);
  if (loc) {
    const port = loc[1] ? parseInt(loc[1], 10) : 80;
    const base = buildTunnelUrl(relayServerUrl, relayMachineId, port);
    const rest = loc[2] ? loc[2].replace(/^\//, "") : "";
    return base + rest;
  }
  return null;
}

export default function PreviewTab({ initialUrl, settings }: Props) {
  const [url, setUrl] = useState(initialUrl || "http://localhost:3000");
  const [inputUrl, setInputUrl] = useState(url);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const webViewRef = useRef<WebView>(null);

  // Sync when initialUrl changes from outside
  React.useEffect(() => {
    if (initialUrl && initialUrl !== url) {
      setUrl(initialUrl);
      setInputUrl(initialUrl);
      setError(null);
    }
  }, [initialUrl]);

  const handleGo = useCallback(() => {
    let target = inputUrl.trim();
    if (!target) return;
    // relay 模式:把 localhost/裸端口改写为中继隧道 URL
    const tunnel = maybeRewriteToTunnel(target, settings);
    if (tunnel) {
      target = tunnel;
    } else if (!target.startsWith("http://") && !target.startsWith("https://")) {
      target = "http://" + target;
    }
    setUrl(target);
    setInputUrl(target);
    setError(null);
  }, [inputUrl, settings]);

  const handleRefresh = useCallback(() => {
    webViewRef.current?.reload();
  }, []);

  const handleGoBack = useCallback(() => {
    webViewRef.current?.goBack();
  }, []);

  const handleGoForward = useCallback(() => {
    webViewRef.current?.goForward();
  }, []);

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
      </View>

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
