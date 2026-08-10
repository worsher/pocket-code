import { Directory, File } from "expo-file-system";
import { CryptoDigestAlgorithm, digest, digestStringAsync } from "expo-crypto";
import { unzipSync } from "fflate";
import {
  normalizeWorkspaceRelativePath,
  runImportPipeline,
  type ImportPipelineResult,
  type ImportProbe,
} from "@pocket-code/workspace-core";
import type { Project } from "../store/projects";
import {
  MAX_IMPORT_FILES,
  assertMobileImportSpace,
  commitManagedMobileImport,
  createMobileImportStagingDirectory,
  getExistingImportSources,
  rollbackManagedMobileImport,
  scanMobileDirectory,
  type MobileImportManifestEntry,
  type MobileStagedImport,
} from "./mobileDirectoryImport";

const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 512 * 1024 * 1024;

interface InspectedArchiveEntry {
  path: string;
  data?: Uint8Array;
}

export interface InspectedArchive {
  entries: InspectedArchiveEntry[];
  manifest: MobileImportManifestEntry[];
  snapshot: string;
  expandedBytes: number;
  fileCount: number;
}

export interface MobileArchiveProbe extends ImportProbe {
  readonly importMode: "copy";
  readonly sourceKind: "archive";
  readonly source: File;
  readonly archive: InspectedArchive;
}

export type MobileArchiveImportResult = ImportPipelineResult<MobileArchiveProbe, Project>;

function bytesToHex(value: ArrayBuffer): string {
  return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function safeArchivePath(rawPath: string): string {
  const path = rawPath.endsWith("/") ? rawPath.slice(0, -1) : rawPath;
  if (!path || path.includes("\\") || path.includes("\0")) {
    throw new Error(`Archive contains an unsafe path: ${rawPath}`);
  }
  let normalized: string;
  try {
    normalized = normalizeWorkspaceRelativePath(path);
  } catch {
    throw new Error(`Archive contains an unsafe path: ${rawPath}`);
  }
  if (normalized === "." || normalized !== path) {
    throw new Error(`Archive contains an unsafe path: ${rawPath}`);
  }
  return normalized;
}

export async function inspectZipArchive(bytes: Uint8Array): Promise<InspectedArchive> {
  if (bytes.byteLength > MAX_ARCHIVE_BYTES) {
    throw new Error("Archive is larger than the 100 MB import limit");
  }
  let declaredFiles = 0;
  let declaredExpandedBytes = 0;
  const declaredPaths = new Set<string>();
  const unpacked = unzipSync(bytes, {
    filter(file) {
      const path = safeArchivePath(file.name);
      if (declaredPaths.has(path)) {
        throw new Error(`Archive contains a duplicate path: ${path}`);
      }
      declaredPaths.add(path);
      if (!file.name.endsWith("/")) {
        declaredFiles++;
        declaredExpandedBytes += file.originalSize;
        if (declaredFiles > MAX_IMPORT_FILES) {
          throw new Error(`Archive contains more than ${MAX_IMPORT_FILES} files`);
        }
        if (declaredExpandedBytes > MAX_EXPANDED_BYTES) {
          throw new Error("Archive expands beyond the 512 MB import limit");
        }
      }
      return true;
    },
  });
  const entries: InspectedArchiveEntry[] = [];
  const files = new Map<string, Uint8Array>();
  const explicitDirectories = new Set<string>();
  let expandedBytes = 0;

  for (const [rawPath, data] of Object.entries(unpacked)) {
    const path = safeArchivePath(rawPath);
    if (rawPath.endsWith("/")) {
      explicitDirectories.add(path);
      continue;
    }
    if (files.has(path) || explicitDirectories.has(path)) {
      throw new Error(`Archive contains a duplicate path: ${path}`);
    }
    files.set(path, data);
    expandedBytes += data.byteLength;
    if (files.size > MAX_IMPORT_FILES) {
      throw new Error(`Archive contains more than ${MAX_IMPORT_FILES} files`);
    }
    if (expandedBytes > MAX_EXPANDED_BYTES) {
      throw new Error("Archive expands beyond the 512 MB import limit");
    }
  }

  const portablePaths = new Map<string, string>();
  for (const path of [...files.keys(), ...explicitDirectories]) {
    const portable = path.normalize("NFC").toLocaleLowerCase("en-US");
    const previous = portablePaths.get(portable);
    if (previous && previous !== path) {
      throw new Error(
        `Archive contains paths that collide on mobile filesystems: ${previous}, ${path}`
      );
    }
    portablePaths.set(portable, path);
  }
  for (const path of files.keys()) {
    const segments = path.split("/");
    for (let index = 1; index < segments.length; index++) {
      const parent = segments.slice(0, index).join("/");
      if (files.has(parent)) {
        throw new Error(`Archive path is both a file and directory: ${parent}`);
      }
    }
  }

  for (const path of [...files.keys()].sort()) {
    entries.push({ path, data: files.get(path)! });
  }
  for (const path of [...explicitDirectories].sort()) {
    const prefix = `${path}/`;
    const hasChildren =
      [...files.keys()].some((candidate) => candidate.startsWith(prefix)) ||
      [...explicitDirectories].some(
        (candidate) => candidate !== path && candidate.startsWith(prefix)
      );
    if (!hasChildren) entries.push({ path });
  }

  const manifest: MobileImportManifestEntry[] = [];
  for (const entry of entries) {
    if (!entry.data) {
      manifest.push({ path: entry.path, type: "directory" });
      continue;
    }
    const digestInput = entry.data.buffer.slice(
      entry.data.byteOffset,
      entry.data.byteOffset + entry.data.byteLength
    ) as ArrayBuffer;
    const fileDigest = bytesToHex(await digest(CryptoDigestAlgorithm.MD5, digestInput));
    manifest.push({
      path: entry.path,
      type: "file",
      size: entry.data.byteLength,
      digest: fileDigest,
    });
  }
  manifest.sort((a, b) => a.path.localeCompare(b.path));
  const snapshot = await digestStringAsync(CryptoDigestAlgorithm.SHA256, JSON.stringify(manifest));
  return { entries, manifest, snapshot, expandedBytes, fileCount: files.size };
}

export function writeArchiveToDirectory(archive: InspectedArchive, destination: Directory): void {
  for (const entry of archive.entries) {
    const segments = entry.path.split("/");
    if (!entry.data) {
      new Directory(destination, ...segments).create({ idempotent: true, intermediates: true });
      continue;
    }
    const parent = new Directory(destination, ...segments.slice(0, -1));
    if (!parent.exists) parent.create({ idempotent: true, intermediates: true });
    new File(parent, segments.at(-1)!).write(entry.data);
  }
}

export async function pickMobileProjectArchive(): Promise<File | null> {
  const result = await File.pickFileAsync(undefined, "application/zip");
  return (Array.isArray(result) ? (result[0] ?? null) : result) as File | null;
}

export async function importMobileArchive(args: {
  source: File;
  sourceDeviceId: string;
  projects: readonly Project[];
  allowWeakDuplicate?: boolean;
  commitProject(project: Project): Promise<void>;
}): Promise<MobileArchiveImportResult> {
  return runImportPipeline({
    input: args.source,
    existingSources: getExistingImportSources(args.projects),
    allowWeakDuplicate: args.allowWeakDuplicate,
    adapter: {
      async probe(source): Promise<MobileArchiveProbe> {
        if (!source.exists)
          throw new Error("Selected archive is unavailable or permission was lost");
        const archive = await inspectZipArchive(await source.bytes());
        return {
          importMode: "copy",
          sourceKind: "archive",
          sourceDeviceId: args.sourceDeviceId,
          suggestedName: source.name.replace(/\.zip$/i, "") || "Imported project",
          canonicalLocator: source.uri,
          contentFingerprint: archive.snapshot,
          sourceSnapshot: archive.snapshot,
          estimatedBytes: archive.expandedBytes,
          source,
          archive,
        };
      },
      async stage(probe): Promise<MobileStagedImport> {
        assertMobileImportSpace(probe.estimatedBytes);
        const staging = createMobileImportStagingDirectory();
        try {
          writeArchiveToDirectory(probe.archive, staging);
          return {
            directory: staging,
            stagedSnapshot: (await scanMobileDirectory(staging)).snapshot,
          };
        } catch (error) {
          if (staging.exists) staging.delete();
          throw error;
        }
      },
      async verify(_probe, staged) {
        return (await scanMobileDirectory(staged.directory)).snapshot;
      },
      async commit({ probe, staged, identity, verifiedSnapshot }) {
        return commitManagedMobileImport({
          probe,
          staged,
          identity,
          verifiedSnapshot,
          writeBackPolicy: "explicit",
          commitProject: args.commitProject,
        });
      },
      rollback: rollbackManagedMobileImport,
    },
  });
}
