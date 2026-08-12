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
    async text() {
      const content = fake.nodes.get(this.uri)?.content;
      if (typeof content === "string") return content;
      if (content instanceof Uint8Array) return new TextDecoder().decode(content);
      throw new Error("source missing");
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
            .repeat(16)
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
    delete() {
      fake.nodes.delete(this.uri);
    }
    move(destination: File) {
      const node = fake.nodes.get(this.uri);
      if (!node || node.type !== "file") throw new Error("source missing");
      fake.nodes.delete(this.uri);
      fake.nodes.set(destination.uri, node);
      this.uri = destination.uri;
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
  writeAsStringAsync: vi.fn(async (uri: string, content: string) => {
    fake.nodes.set(normalizeUri(uri), {
      type: "file",
      content: Uint8Array.from(atob(content), (value) => value.charCodeAt(0)),
    });
  }),
}));

vi.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  digest: vi.fn(async (_algorithm: string, input: ArrayBuffer | Uint8Array) => {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const sum = [...bytes].reduce((value, byte) => (value + byte) % 256, 0);
    return new Uint8Array(16).fill(sum).buffer;
  }),
  digestStringAsync: vi.fn(async (_algorithm: string, input: string) => {
    const sum = [...new TextEncoder().encode(input)].reduce(
      (value, byte) => (value + byte) % 256,
      0
    );
    return sum.toString(16).padStart(64, "0");
  }),
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
const { pullMobileReplicaTransaction, scanMobileSyncDirectory } =
  await import("./mobileSyncTransaction");
const { applyCopySourceOperation, previewCopySourceOperation } = await import("./copySourceSync");
const { ensureMobileWorkspaceHandle } = await import("./workspaceResolver");
const { getWorkspaceMetrics, recordWorkspaceMetric } = await import("./workspaceTelemetry");
const {
  cleanupMigratedLegacyMobileStorage,
  hasLegacyMobileCleanupCandidate,
  listMobileWorkspaceMigrations,
  migrateLegacyMobileProject,
  reconcileMobileWorkspaceMigrations,
} = await import("./mobileWorkspaceMigration");
const { reassignSessionsProjectId } = await import("../store/chatHistory");

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

describe("copy source reconciliation", () => {
  it("previews and explicitly reapplies a source-only directory change", async () => {
    const imported = await importMobileDirectory({
      source: sourceDirectory(),
      sourceDeviceId: "phone-a",
      projects: [],
      commitProject: async () => undefined,
    });
    if (imported.status !== "imported") throw new Error("expected import");
    const project = imported.committed;
    const handle = ensureMobileWorkspaceHandle(project);
    new File("content://picked/src/index.ts").write("source update");

    const preview = await previewCopySourceOperation(project, handle, "reimport");
    expect(preview).toMatchObject({ decision: "source-ahead" });
    expect(preview.changes).toContainEqual({
      path: "src/index.ts",
      status: "M",
      type: "file",
    });

    let persisted: any;
    await applyCopySourceOperation({
      project,
      handle,
      direction: "reimport",
      persistImportSource: async (source) => {
        persisted = source;
      },
    });
    expect(await new File(handle.worktreeRoot, "src", "index.ts").text()).toBe("source update");
    expect(persisted.importedSnapshot).toBe(preview.sourceSnapshot);
    expect([...fake.nodes.keys()].some((key) => key.includes("/trash/source_sync_"))).toBe(false);
  });

  it("blocks a two-sided change until explicit write-back confirmation", async () => {
    const imported = await importMobileDirectory({
      source: sourceDirectory(),
      sourceDeviceId: "phone-a",
      projects: [],
      commitProject: async () => undefined,
    });
    if (imported.status !== "imported") throw new Error("expected import");
    const project = imported.committed;
    const handle = ensureMobileWorkspaceHandle(project);
    new File("content://picked/src/index.ts").write("source update");
    new File(handle.worktreeRoot, "src", "index.ts").write("workspace update");

    const preview = await previewCopySourceOperation(project, handle, "write-back");
    expect(preview.decision).toBe("conflict");
    await expect(
      applyCopySourceOperation({
        project,
        handle,
        direction: "write-back",
        persistImportSource: async () => undefined,
      })
    ).rejects.toThrow("confirmation");
    expect(await new File("content://picked/src/index.ts").text()).toBe("source update");

    await applyCopySourceOperation({
      project,
      handle,
      direction: "write-back",
      force: true,
      persistImportSource: async () => undefined,
    });
    expect(await new File("content://picked/src/index.ts").text()).toBe("workspace update");
  });

  it("writes an archive copy back as a verified ZIP", async () => {
    const archiveUri = "file:///picked/export.zip";
    fake.nodes.set(archiveUri, {
      type: "file",
      content: zipSync({ "a.txt": strToU8("base") }),
    });
    const imported = await importMobileArchive({
      source: new File(archiveUri),
      sourceDeviceId: "phone-a",
      projects: [],
      commitProject: async () => undefined,
    });
    if (imported.status !== "imported") throw new Error("expected import");
    const project = imported.committed;
    const handle = ensureMobileWorkspaceHandle(project);
    new File(handle.worktreeRoot, "a.txt").write("workspace update");

    const preview = await previewCopySourceOperation(project, handle, "write-back");
    expect(preview.decision).toBe("workspace-ahead");
    await applyCopySourceOperation({
      project,
      handle,
      direction: "write-back",
      persistImportSource: async () => undefined,
    });
    const archive = await inspectZipArchive(await new File(archiveUri).bytes());
    expect(archive.snapshot).toBe(preview.workspaceSnapshot);
  });
});

describe("workspace v2 telemetry", () => {
  it("persists recovery and failure counters for rollout observation", async () => {
    await recordWorkspaceMetric("sync-failed");
    await recordWorkspaceMetric("sync-failed");
    await recordWorkspaceMetric("recovery-attempted");
    await recordWorkspaceMetric("recovery-succeeded");
    await expect(getWorkspaceMetrics()).resolves.toMatchObject({
      version: 1,
      counters: {
        "sync-failed": 2,
        "recovery-attempted": 1,
        "recovery-succeeded": 1,
      },
      recoverySuccessRate: 1,
    });
  });
});

describe("legacy mobile workspace migration", () => {
  function legacyProject(): Project {
    return {
      catalogVersion: 2,
      id: "old-project",
      legacyId: "old-project",
      name: "Old project",
      description: "",
      localReplica: {
        id: "3ca2e8bb-4fe5-4e16-a6ca-99840d666870",
        storageKey: "ws_74f1d64fbf5946a9aa0b7dcf42b95cab",
        generation: 1,
        layout: "legacy-project",
      },
      createdAt: 1,
      updatedAt: 1,
    };
  }

  function createLegacyWorkspace() {
    new Directory("file:///documents/workspace/old-project/src").create({ intermediates: true });
    new File("file:///documents/workspace/old-project/src/index.ts").write("legacy content");
  }

  it("copies and verifies before catalog commit and keeps the old root until explicit cleanup", async () => {
    createLegacyWorkspace();
    let persisted: Project | undefined;
    const migrated = await migrateLegacyMobileProject({
      project: legacyProject(),
      persistProject: async (_previous, replacement) => {
        persisted = replacement;
      },
    });
    expect(migrated).toMatchObject({
      id: "550e8400-e29b-41d4-a716-446655440000",
      legacyId: "old-project",
      localReplica: { layout: "v2" },
    });
    expect(persisted).toEqual(migrated);
    expect(new File("file:///documents/workspace/old-project/src/index.ts").exists).toBe(true);
    expect(
      new File(
        "file:///documents/pocket-code/v2/projects/ws_74f1d64fbf5946a9aa0b7dcf42b95cab/worktree/src/index.ts"
      ).exists
    ).toBe(true);
    expect((await listMobileWorkspaceMigrations())[0].phase).toBe("committed");
    await expect(hasLegacyMobileCleanupCandidate()).resolves.toBe(true);
    await expect(cleanupMigratedLegacyMobileStorage(migrated.id)).resolves.toBe(1);
    expect(new Directory("file:///documents/workspace/old-project").exists).toBe(false);
    await expect(cleanupMigratedLegacyMobileStorage(migrated.id)).resolves.toBe(0);
  });

  it("resumes an applied migration after catalog persistence fails", async () => {
    createLegacyWorkspace();
    let fail = true;
    await expect(
      migrateLegacyMobileProject({
        project: legacyProject(),
        persistProject: async () => {
          if (fail) throw new Error("catalog unavailable");
        },
      })
    ).rejects.toThrow("catalog unavailable");
    fail = false;
    await expect(
      migrateLegacyMobileProject({
        project: legacyProject(),
        persistProject: async () => undefined,
      })
    ).resolves.toMatchObject({ localReplica: { layout: "v2" } });
    expect(new File("file:///documents/workspace/old-project/src/index.ts").exists).toBe(true);
    await expect(getWorkspaceMetrics()).resolves.toMatchObject({
      counters: { "recovery-attempted": 1, "recovery-succeeded": 1 },
      recoverySuccessRate: 1,
    });
  });

  it("repairs an applied journal when the catalog commit already persisted", async () => {
    createLegacyWorkspace();
    const migrated = await migrateLegacyMobileProject({
      project: legacyProject(),
      persistProject: async () => undefined,
    });
    const journalUri = [...fake.nodes.keys()].find((key) =>
      key.endsWith("/catalog/migrations/mobile_ws_74f1d64fbf5946a9aa0b7dcf42b95cab.json")
    );
    if (!journalUri) throw new Error("migration journal missing");
    const journal = JSON.parse(String(fake.nodes.get(journalUri)?.content));
    new File(journalUri).write(JSON.stringify({ ...journal, phase: "applied" }));
    await expect(reconcileMobileWorkspaceMigrations([migrated])).resolves.toBe(1);
    expect((await listMobileWorkspaceMigrations())[0].phase).toBe("committed");
  });

  it("reassigns archived sessions idempotently when the project ID changes", async () => {
    fake.storage.set(
      "pocket-code:sessions",
      JSON.stringify([
        { id: "s1", projectId: "old-project", title: "Old", lastUpdated: 2, messageCount: 1 },
        { id: "s2", projectId: "other", title: "Other", lastUpdated: 1, messageCount: 1 },
      ])
    );
    await expect(
      reassignSessionsProjectId("old-project", "550e8400-e29b-41d4-a716-446655440000")
    ).resolves.toBe(1);
    await expect(
      reassignSessionsProjectId("old-project", "550e8400-e29b-41d4-a716-446655440000")
    ).resolves.toBe(0);
    expect(JSON.parse(fake.storage.get("pocket-code:sessions")!)).toContainEqual(
      expect.objectContaining({
        id: "s1",
        projectId: "550e8400-e29b-41d4-a716-446655440000",
      })
    );
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

  it("rejects writes when the local replica no longer holds the writer lease", async () => {
    const worktreeRoot =
      "file:///documents/pocket-code/v2/projects/ws_550e8400e29b41d4a716446655440000/worktree";
    fake.nodes.set(worktreeRoot, { type: "directory" });
    const mirrorHandle = {
      worktreeRoot,
      capabilities: { read: true, write: false, execute: false, syncBack: true },
    };
    await expect(writeLocalFile("src/index.ts", "blocked", mirrorHandle)).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining("write capability"),
    });
    expect(fake.nodes.has(`${worktreeRoot}/src/index.ts`)).toBe(false);
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

describe("mobile replica sync transaction", () => {
  const worktreeRoot =
    "file:///documents/pocket-code/v2/projects/ws_550e8400e29b41d4a716446655440000/worktree";
  const stateRoot =
    "file:///documents/pocket-code/v2/projects/ws_550e8400e29b41d4a716446655440000/state";
  const handle = {
    projectId: "550e8400-e29b-41d4-a716-446655440000",
    replicaId: "550e8400-e29b-41d4-a716-446655440001",
    generation: 1,
    storageUri: worktreeRoot,
    worktreeRoot,
    stateRoot,
    cacheRoot:
      "file:///documents/pocket-code/v2/projects/ws_550e8400e29b41d4a716446655440000/cache",
    capabilities: { read: true, write: true, execute: true, syncBack: true },
  } as const;
  const remoteReplica = {
    id: "3ca2e8bb-4fe5-4e16-a6ca-99840d666870",
    generation: 1,
    kind: "dev-binding" as const,
    authorityId: "9d2b456e-6477-4c51-bf25-7680cf9f98d4",
    connectionKey: "relay:test",
    updatedAt: 1,
  };

  async function remoteFileSnapshot(content: string) {
    const root = new Directory("file:///remote");
    root.create({ intermediates: true });
    new File(root, "a.txt").write(content);
    const scanned = await scanMobileSyncDirectory(root);
    const file = scanned.files[0];
    root.delete();
    return { snapshot: scanned.snapshot, file };
  }

  it("never includes credential files in a mobile snapshot", async () => {
    const root = new Directory("file:///credential-scan");
    root.create({ intermediates: true });
    new File(root, "safe.txt").write("safe");
    new File(root, ".git-credentials").write("https://token@example.com");
    new File(root, ".gitconfig").write("[credential]");
    new File(root, ".netrc").write("machine example.com password token");
    const ssh = new Directory(root, ".ssh");
    ssh.create();
    new File(ssh, "id_ed25519").write("private-key");
    const internal = new Directory(root, ".pocket-code-credentials");
    internal.create();
    new File(internal, "token").write("secret");

    const scanned = await scanMobileSyncDirectory(root);

    expect(scanned.files.map((file) => file.path)).toEqual(["safe.txt"]);
  });

  it("rejects a remote manifest that names a blocked credential path", async () => {
    new Directory(worktreeRoot).create({ intermediates: true });
    await expect(
      pullMobileReplicaTransaction({
        workspaceHandle: handle as any,
        remoteReplica,
        requestSyncPull: async () => ({
          commit: "a".repeat(40),
          snapshot: "b".repeat(64),
          parent: null,
          full: true,
          files: [
            {
              path: ".netrc",
              status: "A",
              size: 1,
              digest: "c".repeat(32),
            },
          ],
        }),
        requestSyncFile: async () => ({ path: ".netrc", content: btoa("secret") }),
        persistEdge: async () => undefined,
      })
    ).rejects.toThrow("blocked credential path");
  });

  it("verifies staging before atomically advancing the replica edge", async () => {
    new Directory(worktreeRoot).create({ intermediates: true });
    const remote = await remoteFileSnapshot("new");
    const persisted: any[] = [];
    const result = await pullMobileReplicaTransaction({
      workspaceHandle: handle as any,
      remoteReplica,
      requestSyncPull: async () => ({
        commit: "a".repeat(40),
        snapshot: remote.snapshot,
        parent: null,
        full: true,
        files: [{ ...remote.file, status: "A" }],
      }),
      requestSyncFile: async () => ({
        path: "a.txt",
        encoding: "base64",
        content: btoa("new"),
      }),
      persistEdge: async (edge) => {
        persisted.push(edge);
      },
    });

    expect(result.success).toBe(true);
    expect(await new File(worktreeRoot, "a.txt").text()).toBe("new");
    expect(result.edge).toMatchObject({
      baseSnapshot: remote.snapshot,
      localSnapshot: remote.snapshot,
      remoteSnapshot: remote.snapshot,
      baseRemoteRef: "a".repeat(40),
      phase: "committed",
    });
    expect(persisted.some((edge) => edge.phase === "verifying")).toBe(true);
    expect([...fake.nodes.keys()].some((key) => key.includes("/staging/sync_"))).toBe(false);
    expect([...fake.nodes.keys()].some((key) => key.endsWith(".journal.json"))).toBe(false);
  });

  it("propagates deletions and does not advance base after integrity failure", async () => {
    new Directory(worktreeRoot).create({ intermediates: true });
    new File(worktreeRoot, "a.txt").write("old");
    const local = await scanMobileSyncDirectory(new Directory(worktreeRoot));
    const emptyRoot = new Directory("file:///empty");
    emptyRoot.create({ intermediates: true });
    const empty = await scanMobileSyncDirectory(emptyRoot);
    emptyRoot.delete();
    const edge = {
      localReplicaId: handle.replicaId,
      remoteReplicaId: remoteReplica.id,
      remoteAuthorityId: remoteReplica.authorityId,
      baseSnapshot: local.snapshot,
      localSnapshot: local.snapshot,
      remoteSnapshot: local.snapshot,
      baseRemoteRef: "a".repeat(40),
      phase: "committed" as const,
      updatedAt: 1,
    };
    const deleted = await pullMobileReplicaTransaction({
      workspaceHandle: handle as any,
      remoteReplica,
      edge,
      requestSyncPull: async () => ({
        commit: "b".repeat(40),
        snapshot: empty.snapshot,
        parent: "a".repeat(40),
        full: false,
        files: [{ path: "a.txt", status: "D" }],
      }),
      requestSyncFile: async () => {
        throw new Error("deleted files are not downloaded");
      },
      persistEdge: async () => undefined,
    });
    expect(deleted.deleted).toBe(1);
    expect(new File(worktreeRoot, "a.txt").exists).toBe(false);

    const remote = await remoteFileSnapshot("good");
    const phases: any[] = [];
    await expect(
      pullMobileReplicaTransaction({
        workspaceHandle: handle as any,
        remoteReplica,
        edge: deleted.edge,
        requestSyncPull: async () => ({
          commit: "c".repeat(40),
          snapshot: remote.snapshot,
          parent: "b".repeat(40),
          full: false,
          files: [{ ...remote.file, status: "A" }],
        }),
        requestSyncFile: async () => ({ path: "a.txt", content: btoa("bad") }),
        persistEdge: async (next) => {
          phases.push(next);
        },
      })
    ).rejects.toThrow("integrity check");
    expect(phases.at(-1)).toMatchObject({
      phase: "failed",
      baseSnapshot: empty.snapshot,
    });

    const retried = await pullMobileReplicaTransaction({
      workspaceHandle: handle as any,
      remoteReplica,
      edge: deleted.edge,
      requestSyncPull: async () => ({
        commit: "c".repeat(40),
        snapshot: remote.snapshot,
        parent: "b".repeat(40),
        full: false,
        files: [{ ...remote.file, status: "A" }],
      }),
      requestSyncFile: async () => ({ path: "a.txt", content: btoa("good") }),
      persistEdge: async () => undefined,
    });
    expect(retried.success).toBe(true);
    expect(await new File(worktreeRoot, "a.txt").text()).toBe("good");
    expect([...fake.nodes.keys()].some((key) => key.includes("/staging/sync_"))).toBe(false);
  });

  it("recovers when the workspace was applied before catalog commit", async () => {
    new Directory(worktreeRoot).create({ intermediates: true });
    const remote = await remoteFileSnapshot("recovered");
    let failCatalogCommit = true;
    await expect(
      pullMobileReplicaTransaction({
        workspaceHandle: handle as any,
        remoteReplica,
        requestSyncPull: async () => ({
          commit: "d".repeat(40),
          snapshot: remote.snapshot,
          parent: null,
          full: true,
          files: [{ ...remote.file, status: "A" }],
        }),
        requestSyncFile: async () => ({ path: "a.txt", content: btoa("recovered") }),
        persistEdge: async (edge) => {
          if (failCatalogCommit && edge.baseSnapshot === remote.snapshot) {
            throw new Error("catalog unavailable");
          }
        },
      })
    ).rejects.toThrow("catalog unavailable");
    expect(await new File(worktreeRoot, "a.txt").text()).toBe("recovered");
    expect([...fake.nodes.keys()].some((key) => key.endsWith(".journal.json"))).toBe(true);

    failCatalogCommit = false;
    const recovered = await pullMobileReplicaTransaction({
      workspaceHandle: handle as any,
      remoteReplica,
      requestSyncPull: async () => {
        throw new Error("committed recovery must not refetch");
      },
      requestSyncFile: async () => {
        throw new Error("committed recovery must not redownload");
      },
      persistEdge: async () => undefined,
    });
    expect(recovered.success).toBe(true);
    expect(recovered.edge.baseSnapshot).toBe(remote.snapshot);
    expect([...fake.nodes.keys()].some((key) => key.endsWith(".journal.json"))).toBe(false);
  });

  it("freezes automatic apply when both edge sides diverge", async () => {
    new Directory(worktreeRoot).create({ intermediates: true });
    new File(worktreeRoot, "a.txt").write("local change");
    const base = await remoteFileSnapshot("base");
    const remote = await remoteFileSnapshot("remote change");
    let persisted: any;
    const result = await pullMobileReplicaTransaction({
      workspaceHandle: handle as any,
      remoteReplica,
      edge: {
        localReplicaId: handle.replicaId,
        remoteReplicaId: remoteReplica.id,
        remoteAuthorityId: remoteReplica.authorityId,
        baseSnapshot: base.snapshot,
        localSnapshot: base.snapshot,
        remoteSnapshot: base.snapshot,
        baseRemoteRef: "a".repeat(40),
        phase: "committed",
        updatedAt: 1,
      },
      requestSyncPull: async () => ({
        commit: "b".repeat(40),
        snapshot: remote.snapshot,
        parent: "a".repeat(40),
        full: false,
        files: [{ ...remote.file, status: "M" }],
      }),
      requestSyncFile: async () => {
        throw new Error("conflicts must not transfer");
      },
      persistEdge: async (edge) => {
        persisted = edge;
      },
    });
    expect(result.success).toBe(false);
    expect(result.conflict).toBeTruthy();
    expect(persisted.phase).toBe("conflict");
    expect(await new File(worktreeRoot, "a.txt").text()).toBe("local change");
  });
});
