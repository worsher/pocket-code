import { beforeEach, describe, expect, it, vi } from "vitest";
import { strToU8, zipSync } from "fflate";
import type { Project } from "../store/projects";
import type { AppSettings } from "../store/settings";

const fake = vi.hoisted(() => ({
  nodes: new Map<
    string,
    { type: "directory" | "file"; content?: string | Uint8Array; md5?: string }
  >(),
  availableDiskSpace: 1024 * 1024 * 1024,
  storage: new Map<string, string>(),
}));

function normalizeUri(value: string): string {
  if (value === "file:///" || value === "content://") return value;
  return value.replace(/\/+$/, "");
}

function joinUri(parts: unknown[]): string {
  const values = parts.map((part) =>
    typeof part === "string" ? part : (part as { uri: string }).uri
  );
  let result = normalizeUri(values[0]);
  for (const value of values.slice(1)) result = `${result}/${value.replace(/^\/+|\/+$/g, "")}`;
  return normalizeUri(result);
}

vi.mock("expo-file-system", () => {
  class Directory {
    uri: string;
    constructor(...parts: unknown[]) {
      this.uri = joinUri(parts);
    }
    static async pickDirectoryAsync() {
      return new Directory("content://picked");
    }
    get name() {
      return this.uri.split("/").pop() || "";
    }
    get parentDirectory() {
      return new Directory(this.uri.slice(0, this.uri.lastIndexOf("/")));
    }
    get exists() {
      return fake.nodes.get(this.uri)?.type === "directory";
    }
    get size() {
      return 0;
    }
    create(options?: { intermediates?: boolean }) {
      if (!options?.intermediates) {
        fake.nodes.set(this.uri, { type: "directory" });
        return;
      }
      const schemeBoundary = this.uri.indexOf("://") + 3;
      const directories: string[] = [];
      let current = this.uri;
      while (current.length > schemeBoundary) {
        directories.push(current);
        const separator = current.lastIndexOf("/");
        if (separator < schemeBoundary) break;
        current = current.slice(0, separator);
      }
      for (const directory of directories.reverse()) {
        if (!fake.nodes.has(directory)) fake.nodes.set(directory, { type: "directory" });
      }
    }
    delete() {
      for (const key of [...fake.nodes.keys()]) {
        if (key === this.uri || key.startsWith(`${this.uri}/`)) fake.nodes.delete(key);
      }
    }
    move(destination: Directory) {
      const moved = [...fake.nodes.entries()].filter(
        ([key]) => key === this.uri || key.startsWith(`${this.uri}/`)
      );
      this.delete();
      for (const [key, value] of moved) {
        fake.nodes.set(`${destination.uri}${key.slice(this.uri.length)}`, value);
      }
      this.uri = destination.uri;
    }
    list() {
      const prefix = `${this.uri}/`;
      const direct = [...fake.nodes.entries()].filter(([key]) => {
        if (!key.startsWith(prefix)) return false;
        return !key.slice(prefix.length).includes("/");
      });
      return direct.map(([key, value]) =>
        value.type === "directory" ? new Directory(key) : new File(key)
      );
    }
  }

  class File {
    uri: string;
    constructor(...parts: unknown[]) {
      this.uri = joinUri(parts);
    }
    get name() {
      return this.uri.split("/").pop() || "";
    }
    get parentDirectory() {
      return new Directory(this.uri.slice(0, this.uri.lastIndexOf("/")));
    }
    get exists() {
      return fake.nodes.get(this.uri)?.type === "file";
    }
    get size() {
      return fake.nodes.get(this.uri)?.content?.length ?? 0;
    }
    bytes() {
      const content = fake.nodes.get(this.uri)?.content;
      if (content === undefined) throw new Error("source missing");
      return Promise.resolve(
        typeof content === "string" ? new TextEncoder().encode(content) : content
      );
    }
    info() {
      const node = fake.nodes.get(this.uri);
      const bytes =
        typeof node?.content === "string" ? new TextEncoder().encode(node.content) : node?.content;
      const digest = bytes
        ? [...bytes]
            .reduce((sum, byte) => (sum + byte) % 256, 0)
            .toString(16)
            .padStart(2, "0")
        : undefined;
      return node?.type === "file"
        ? { exists: true, size: node.content?.length ?? 0, md5: node.md5 ?? digest }
        : { exists: false };
    }
    write(content: Uint8Array | string) {
      fake.nodes.set(this.uri, { type: "file", content });
    }
    create() {
      fake.nodes.set(this.uri, { type: "file", content: "" });
    }
    copy(destination: File) {
      const node = fake.nodes.get(this.uri);
      if (!node || node.type !== "file") throw new Error("source missing");
      fake.nodes.set(destination.uri, { ...node });
    }
  }

  const Paths = {
    document: { uri: "file:///documents" },
    cache: { uri: "file:///cache" },
    get availableDiskSpace() {
      return fake.availableDiskSpace;
    },
  };
  return { Directory, File, Paths };
});

vi.mock("expo-file-system/legacy", () => ({
  EncodingType: { Base64: "base64" },
  writeAsStringAsync: vi.fn(),
}));

vi.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  digest: vi.fn(async (_algorithm: string, input: ArrayBuffer | Uint8Array) => {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const sum = [...bytes].reduce((value, byte) => (value + byte) % 256, 0);
    return new Uint8Array([sum]).buffer;
  }),
  digestStringAsync: vi.fn(async (_algorithm: string, input: string) => input),
  randomUUID: () => "550e8400-e29b-41d4-a716-446655440000",
}));

vi.mock("expo-modules-core", () => ({
  requireNativeModule: () => ({
    getNativeLibDir: () => "/native/lib",
    resolveWorkspacePath: async (root: string, relative: string) =>
      relative ? `${root}/${relative}` : root,
  }),
}));

vi.mock("pocket-terminal-module", () => ({
  extractTarGz: vi.fn(),
}));

vi.mock("./gitService", () => ({
  probeGitRemote: vi.fn(async (url: string) => ({ url, head: "a".repeat(40) })),
  cloneGitIntoWorkspaceRoot: vi.fn(async () => "a".repeat(40)),
  resolveGitWorkspaceHead: vi.fn(async () => "a".repeat(40)),
}));

vi.mock("./localExecutor", () => ({
  exec: vi.fn(),
  startBackgroundExec: vi.fn(),
}));

vi.mock("./processManager", () => ({
  killProcess: vi.fn(),
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async (key: string) => fake.storage.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      fake.storage.set(key, value);
    }),
  },
}));

const { Directory, File } = await import("expo-file-system");
const { importMobileDirectory } = await import("./mobileDirectoryImport");
const { importMobileArchive, inspectZipArchive } = await import("./mobileArchiveImport");
const { importMobileGit } = await import("./mobileGitImport");
const { getMobileWorkspaceRoot, writeLocalFile } = await import("./localFileSystem");
const { buildProotCommand } = await import("./runtimeManager");

function sourceDirectory() {
  fake.nodes.set("content://picked", { type: "directory" });
  fake.nodes.set("content://picked/src", { type: "directory" });
  fake.nodes.set("content://picked/src/index.ts", {
    type: "file",
    content: "export {}",
    md5: "abc123",
  });
  return new Directory("content://picked");
}

beforeEach(() => {
  fake.nodes.clear();
  fake.storage.clear();
  fake.availableDiskSpace = 1024 * 1024 * 1024;
});

describe("mobile directory copy import", () => {
  it("copies through staging, commits metadata, and leaves the source untouched", async () => {
    const committed: Project[] = [];
    const result = await importMobileDirectory({
      source: sourceDirectory(),
      sourceDeviceId: "phone-a",
      projects: [],
      commitProject: async (project) => {
        committed.push(project);
      },
    });
    expect(result.status).toBe("imported");
    expect(committed[0].importSource).toMatchObject({
      mode: "copy",
      canonicalLocator: "content://picked",
      writeBackPolicy: "explicit",
    });
    expect(fake.nodes.has("content://picked/src/index.ts")).toBe(true);
    const copied = [...fake.nodes.keys()].find((key) => key.endsWith("/worktree/src/index.ts"));
    expect(copied).toBeTruthy();
    expect([...fake.nodes.keys()].some((key) => key.includes("/staging/import_"))).toBe(false);
  });

  it("detects the original locator as a weak duplicate before copying", async () => {
    const source = sourceDirectory();
    const first = await importMobileDirectory({
      source,
      sourceDeviceId: "phone-a",
      projects: [],
      commitProject: async () => undefined,
    });
    if (first.status !== "imported") throw new Error("expected import");
    const result = await importMobileDirectory({
      source,
      sourceDeviceId: "phone-a",
      projects: [first.committed],
      commitProject: async () => {
        throw new Error("must not commit");
      },
    });
    expect(result).toMatchObject({
      status: "confirmation-required",
      existingProjectId: first.committed.id,
    });
  });

  it("rejects insufficient space before creating staging data", async () => {
    fake.availableDiskSpace = 1;
    await expect(
      importMobileDirectory({
        source: sourceDirectory(),
        sourceDeviceId: "phone-a",
        projects: [],
        commitProject: async () => undefined,
      })
    ).rejects.toThrow("free space");
    expect([...fake.nodes.keys()].some((key) => key.includes("/staging/import_"))).toBe(false);
  });

  it("rejects a source whose permission is no longer available", async () => {
    await expect(
      importMobileDirectory({
        source: new Directory("content://permission-lost"),
        sourceDeviceId: "phone-a",
        projects: [],
        commitProject: async () => undefined,
      })
    ).rejects.toThrow("permission was lost");
    expect([...fake.nodes.keys()].some((key) => key.includes("/staging/import_"))).toBe(false);
  });

  it("removes the managed copy if catalog commit fails", async () => {
    await expect(
      importMobileDirectory({
        source: sourceDirectory(),
        sourceDeviceId: "phone-a",
        projects: [],
        commitProject: async () => {
          throw new Error("catalog full");
        },
      })
    ).rejects.toThrow("catalog full");
    expect([...fake.nodes.keys()].some((key) => key.includes("/projects/ws_"))).toBe(false);
    expect(fake.nodes.has("content://picked/src/index.ts")).toBe(true);
  });
});

describe("mobile ZIP archive copy import", () => {
  it("rejects traversal entries before creating staging data", async () => {
    const bytes = zipSync({ "../escape.ts": strToU8("escape") });
    await expect(inspectZipArchive(bytes)).rejects.toThrow("unsafe path");
    expect([...fake.nodes.keys()].some((key) => key.includes("/staging/import_"))).toBe(false);
  });

  it("rejects archive paths that collide on case-insensitive mobile filesystems", async () => {
    const bytes = zipSync({ "README.md": strToU8("a"), "readme.md": strToU8("b") });
    await expect(inspectZipArchive(bytes)).rejects.toThrow("collide on mobile filesystems");
  });

  it("extracts into a managed worktree and records archive source metadata", async () => {
    const archiveUri = "file:///picked/example.zip";
    fake.nodes.set(archiveUri, {
      type: "file",
      content: zipSync({ "src/index.ts": strToU8("export const ok = true") }),
    });
    const committed: Project[] = [];
    const result = await importMobileArchive({
      source: new File(archiveUri),
      sourceDeviceId: "phone-a",
      projects: [],
      commitProject: async (project) => {
        committed.push(project);
      },
    });

    expect(result.status).toBe("imported");
    expect(committed[0].importSource).toMatchObject({
      mode: "copy",
      sourceKind: "archive",
      canonicalLocator: archiveUri,
      writeBackPolicy: "explicit",
    });
    expect([...fake.nodes.keys()].some((key) => key.endsWith("/worktree/src/index.ts"))).toBe(true);
    expect(fake.nodes.has(archiveUri)).toBe(true);
  });
});

describe("mobile Git import", () => {
  it("clones through staging and records a normalized Git write-back source", async () => {
    const committed: Project[] = [];
    const result = await importMobileGit({
      url: "https://github.com/example/demo.git",
      settings: {} as AppSettings,
      sourceDeviceId: "phone-a",
      projects: [],
      commitProject: async (project) => {
        committed.push(project);
      },
    });

    expect(result.status).toBe("imported");
    expect(committed[0]).toMatchObject({
      name: "demo",
      gitUrl: "https://github.com/example/demo.git",
      importSource: {
        mode: "git",
        sourceKind: "git",
        writeBackPolicy: "git",
        importedSnapshot: "a".repeat(40),
      },
    });
  });
});

describe("catalog workspace consumers", () => {
  it("writes through a WorkspaceHandle and rejects traversal", async () => {
    const worktreeRoot =
      "file:///documents/pocket-code/v2/projects/ws_550e8400e29b41d4a716446655440000/worktree";
    const handle = { worktreeRoot };
    fake.nodes.set(worktreeRoot, { type: "directory" });

    expect(getMobileWorkspaceRoot(handle)).toBe(worktreeRoot);
    await expect(writeLocalFile("../escape.ts", "bad", handle)).resolves.toMatchObject({
      success: false,
    });
    await expect(writeLocalFile("src/index.ts", "ok", handle)).resolves.toMatchObject({
      success: true,
    });
    expect(fake.nodes.get(`${worktreeRoot}/src/index.ts`)?.content).toBe("ok");
  });

  it("binds proot to the selected v2 worktree and keeps runtime outside it", () => {
    const worktreeRoot =
      "file:///documents/pocket-code/v2/projects/ws_550e8400e29b41d4a716446655440000/worktree";
    const command = buildProotCommand(
      "pwd",
      `${worktreeRoot.slice("file://".length)}/src`,
      worktreeRoot
    );
    expect(command).toContain(
      '"--bind=/documents/pocket-code/v2/projects/ws_550e8400e29b41d4a716446655440000/worktree:/workspace"'
    );
    expect(command).toContain('--rootfs="/documents/pocket-code/v2/runtime/rootfs"');
    expect(command).toContain('-w "/workspace/src"');
    expect(command).not.toContain("/documents/workspace");
  });
});
