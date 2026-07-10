import { useMemo, useState } from "react";
import ConnectPage from "./pages/ConnectPage";
import ChatPage from "./pages/ChatPage";
import FilesPage from "./pages/FilesPage";
import { createSettingsStore } from "./webStorage";
import { WebAgentStore } from "./webAgentStore";
import { useWebAgent } from "./useWebAgent";
import type { WebSettings } from "./webStorage";

export default function App() {
  const settingsStore = useMemo(() => createSettingsStore(window.localStorage), []);
  const [store, setStore] = useState<WebAgentStore | null>(null);
  const [tab, setTab] = useState<"chat" | "files">("chat");

  if (!store) {
    return (
      <ConnectPage
        settings={settingsStore.load()}
        onSave={(p) => settingsStore.save(p)}
        onConnect={(s: WebSettings) => {
          const st = new WebAgentStore(s);
          st.connect();
          setStore(st);
        }}
      />
    );
  }
  return <Main store={store} tab={tab} onTab={setTab} onDisconnect={() => { store.disconnect(); setStore(null); }} />;
}

function Main({ store, tab, onTab, onDisconnect }: {
  store: WebAgentStore; tab: "chat" | "files";
  onTab(t: "chat" | "files"): void; onDisconnect(): void;
}) {
  const state = useWebAgent(store);
  return (
    <div className="app">
      <header className="topbar">
        <nav>
          <button className={tab === "chat" ? "active" : ""} onClick={() => onTab("chat")}>Chat</button>
          <button className={tab === "files" ? "active" : ""} onClick={() => onTab("files")}>Files</button>
        </nav>
        <span className={`conn-dot ${state.connected ? "on" : "off"}`} title={state.connected ? "已连接" : "已断开"} />
        <button onClick={onDisconnect}>断开</button>
      </header>
      {state.authError && <div className="auth-error">{state.authError}</div>}
      <main className="content">{tab === "chat" ? <ChatPage store={store} /> : <FilesPage store={store} />}</main>
    </div>
  );
}
