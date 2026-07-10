import { useState } from "react";
import { RelayClient } from "@pocket-code/client-core";
import type { WebSettings } from "../webStorage";

interface Props {
  settings: WebSettings;
  onSave(patch: Partial<WebSettings>): WebSettings;
  onConnect(settings: WebSettings): void;
}

export default function ConnectPage({ settings, onSave, onConnect }: Props) {
  const [mode, setMode] = useState<WebSettings["mode"]>(settings.mode);
  const [serverUrl, setServerUrl] = useState(settings.serverUrl);
  const [relayUrl, setRelayUrl] = useState(settings.relayUrl);
  const [pairCode, setPairCode] = useState("");
  const [status, setStatus] = useState("");
  const paired = !!(settings.relayToken && settings.relayMachineId);

  async function pair() {
    setStatus("配对中…");
    const saved = onSave({ mode: "relay", relayUrl });
    const client = new RelayClient({
      relayUrl: saved.relayUrl,
      machineId: "",
      deviceId: saved.deviceId,
      deviceName: "Pocket Code Web",
      onTokenPersist: (token, machineId) =>
        onSave({ relayToken: token, relayMachineId: machineId }),
    });
    client.connect();
    try {
      await new Promise<void>((res, rej) => {
        client.onopen = () => res();
        client.onerror = (e) => rej(new Error(e.message));
      });
      const resp = await client.pairDevice(pairCode.trim());
      if (!resp.success || !resp.token || !resp.machineId) {
        throw new Error(resp.error || "配对失败");
      }
      client.updateToken(resp.token, resp.machineId);
      setStatus(`已配对:${resp.machineName || resp.machineId}`);
    } catch (err) {
      setStatus(`配对失败:${err instanceof Error ? err.message : String(err)}`);
    } finally {
      client.close();
    }
  }

  function connect() {
    const saved = onSave(mode === "lan" ? { mode, serverUrl } : { mode, relayUrl });
    onConnect(saved);
  }

  return (
    <div className="connect-page">
      <h1>Pocket Code</h1>
      <div className="mode-switch">
        <button className={mode === "lan" ? "active" : ""} onClick={() => setMode("lan")}>局域网直连</button>
        <button className={mode === "relay" ? "active" : ""} onClick={() => setMode("relay")}>Relay 中继</button>
      </div>
      {mode === "lan" ? (
        <label>Daemon 地址
          <input value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} placeholder="ws://192.168.1.10:8787" />
        </label>
      ) : (
        <>
          <label>Relay 地址
            <input value={relayUrl} onChange={(e) => setRelayUrl(e.target.value)} placeholder="wss://aigc.zj.cn/relay" />
          </label>
          <label>配对码
            <input value={pairCode} onChange={(e) => setPairCode(e.target.value)} placeholder="daemon 显示的 8 位码" />
          </label>
          <button onClick={pair} disabled={!relayUrl || !pairCode}>配对</button>
          {paired && <div className="hint">已有配对凭证,可直接连接</div>}
        </>
      )}
      <button className="primary" onClick={connect} disabled={mode === "relay" && !paired && !pairCode}>
        连接
      </button>
      {status && <div className="status">{status}</div>}
      <p className="hint">
        提示:https 部署下浏览器会阻断 ws:// 局域网直连(mixed-content);本地 http 开发页或 relay(wss)不受影响。
      </p>
    </div>
  );
}
