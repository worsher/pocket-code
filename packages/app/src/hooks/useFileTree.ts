import { useState, useCallback, useMemo } from "react";

// ── Types ────────────────────────────────────────────────

export interface FileItem {
  name: string;
  type: "file" | "directory";
  path: string;
  children?: FileItem[];
  loaded?: boolean;
  expanded?: boolean;
}

export interface UseFileTreeOptions {
  requestFileList: (path: string) => Promise<any>;
}

export interface UseFileTreeResult {
  files: FileItem[];
  flatFiles: { item: FileItem; depth: number }[];
  loading: boolean;
  loadError: string | null;
  loadRootFiles: () => Promise<void>;
  toggleDirectory: (item: FileItem) => Promise<void>;
  setFiles: React.Dispatch<React.SetStateAction<FileItem[]>>;
}

// ── Helper ───────────────────────────────────────────────

/** Recursively update a node in the file tree by path */
export function updateFileTree(
  items: FileItem[],
  targetPath: string,
  updates: Partial<FileItem>
): FileItem[] {
  return items.map((item) => {
    if (item.path === targetPath) {
      return { ...item, ...updates };
    }
    if (item.children && targetPath.startsWith(item.path + "/")) {
      return {
        ...item,
        children: updateFileTree(item.children, targetPath, updates),
      };
    }
    return item;
  });
}

/** Flatten a nested file tree for FlatList rendering */
export function flattenTree(
  items: FileItem[],
  depth: number = 0
): { item: FileItem; depth: number }[] {
  const result: { item: FileItem; depth: number }[] = [];
  for (const item of items) {
    result.push({ item, depth });
    if (item.type === "directory" && item.expanded && item.children) {
      result.push(...flattenTree(item.children, depth + 1));
    }
  }
  return result;
}

/** Sort items: directories first, then alphabetically */
function sortItems(items: { name: string; type: string }[]): { name: string; type: string }[] {
  return [...items].sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

// ── Hook ─────────────────────────────────────────────────

export function useFileTree({ requestFileList }: UseFileTreeOptions): UseFileTreeResult {
  const [files, setFiles] = useState<FileItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadRootFiles = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const result = await requestFileList(".");
      if (result.success && result.items) {
        const items: FileItem[] = sortItems(result.items).map((item: any) => ({
          name: item.name,
          type: item.type,
          path: item.name,
          loaded: false,
          expanded: false,
        }));
        setFiles(items);
      }
    } catch (err: any) {
      setLoadError(err.message || "Unable to load file list");
    } finally {
      setLoading(false);
    }
  }, [requestFileList]);

  const toggleDirectory = useCallback(async (item: FileItem) => {
    if (item.expanded) {
      setFiles((prev) => updateFileTree(prev, item.path, { expanded: false }));
      return;
    }

    if (!item.loaded) {
      try {
        const result = await requestFileList(item.path);
        if (result.success && result.items) {
          const children: FileItem[] = sortItems(result.items).map((child: any) => ({
            name: child.name,
            type: child.type,
            path: `${item.path}/${child.name}`,
            loaded: false,
            expanded: false,
          }));
          setFiles((prev) =>
            updateFileTree(prev, item.path, {
              expanded: true,
              loaded: true,
              children,
            })
          );
          return;
        }
      } catch (err: any) {
        console.error("Failed to load directory:", err.message);
      }
    }

    setFiles((prev) => updateFileTree(prev, item.path, { expanded: true }));
  }, [requestFileList]);

  const flatFiles = useMemo(() => flattenTree(files), [files]);

  return {
    files,
    flatFiles,
    loading,
    loadError,
    loadRootFiles,
    toggleDirectory,
    setFiles,
  };
}
