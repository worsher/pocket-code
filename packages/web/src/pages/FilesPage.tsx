import { useEffect, useState } from "react";
import type { WebAgentStore } from "../webAgentStore";

interface Entry { name: string; type: "directory" | "file" }

export default function FilesPage({ store }: { store: WebAgentStore }) {
  const [dir, setDir] = useState(".");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [error, setError] = useState("");
  const [filePath, setFilePath] = useState<string | null>(null);
  const [content, setContent] = useState("");

  async function loadDir(path: string) {
    setError("");
    try {
      const resp = await store.conn.listFiles(path);
      if (resp.success === false) throw new Error(resp.error || "列目录失败");
      setDir(path);
      setEntries((resp.items ?? []) as Entry[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function openFile(path: string) {
    setError("");
    try {
      const resp = await store.conn.readFile(path);
      if (resp.success === false) throw new Error(resp.error || "读文件失败");
      setFilePath(path);
      setContent(String(resp.content ?? ""));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => { void loadDir("."); }, []);

  const join = (name: string) => (dir === "." ? name : `${dir}/${name}`);
  const parent = () => (dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : ".");

  return (
    <div className="files-page">
      <div className="file-tree">
        <div className="dir-bar">
          <button onClick={() => void loadDir(parent())} disabled={dir === "."}>↑</button>
          <span className="dir-path">{dir}</span>
          <button onClick={() => void loadDir(dir)}>刷新</button>
        </div>
        {error && <div className="file-error">{error}</div>}
        <ul>
          {entries.map((e) => (
            <li key={e.name}>
              <button className={`entry ${e.type}`}
                onClick={() => (e.type === "directory" ? void loadDir(join(e.name)) : void openFile(join(e.name)))}>
                {e.type === "directory" ? "📁" : "📄"} {e.name}
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="file-viewer">
        {filePath ? (<><div className="viewer-path">{filePath}</div><pre>{content}</pre></>)
          : <div className="viewer-empty">选择文件查看内容</div>}
      </div>
    </div>
  );
}
