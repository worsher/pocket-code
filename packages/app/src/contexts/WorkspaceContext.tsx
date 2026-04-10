// ── Workspace Context ────────────────────────────────────
// Tracks file changes from AI operations and provides cross-tab navigation.
// Used by FilesTab for auto-refresh, and by ChatMessage for file path linking.

import React, { createContext, useContext, useState, useCallback } from "react";

export interface FileChangeEvent {
  path: string;
  action: "created" | "modified" | "deleted";
  timestamp: number;
}

interface WorkspaceContextValue {
  /** Recent file change events from AI tool execution */
  fileChanges: FileChangeEvent[];
  /** Push a new file change event (called by useAgent on file-changed WS event) */
  pushFileChange: (event: Omit<FileChangeEvent, "timestamp">) => void;
  /** Clear all file change events */
  clearFileChanges: () => void;

  /** Navigate to a file in Files Tab (called from ChatMessage/DiffPreview) */
  navigateToFile: (path: string) => void;
  /** File path pending navigation (consumed by FilesTab) */
  pendingFilePath: string | null;
  /** Clear pending file path after navigation (called by FilesTab) */
  clearPendingFile: () => void;

  /** Open URL in Preview Tab (called from ProcessOutput) */
  navigateToPreview: (url: string) => void;
  /** URL pending preview (consumed by App.tsx) */
  pendingPreviewUrl: string | null;
  /** Clear pending preview URL */
  clearPendingPreview: () => void;
}

const WorkspaceContext = createContext<WorkspaceContextValue>({
  fileChanges: [],
  pushFileChange: () => {},
  clearFileChanges: () => {},
  navigateToFile: () => {},
  pendingFilePath: null,
  clearPendingFile: () => {},
  navigateToPreview: () => {},
  pendingPreviewUrl: null,
  clearPendingPreview: () => {},
});

export function useWorkspace() {
  return useContext(WorkspaceContext);
}

export function WorkspaceProvider({ children }: { children: React.ReactNode }) {
  const [fileChanges, setFileChanges] = useState<FileChangeEvent[]>([]);
  const [pendingFilePath, setPendingFilePath] = useState<string | null>(null);
  const [pendingPreviewUrl, setPendingPreviewUrl] = useState<string | null>(null);

  const pushFileChange = useCallback((event: Omit<FileChangeEvent, "timestamp">) => {
    setFileChanges((prev) => {
      const newEvent: FileChangeEvent = { ...event, timestamp: Date.now() };
      // Keep last 50 events to avoid unbounded growth
      const updated = [...prev, newEvent];
      return updated.length > 50 ? updated.slice(-50) : updated;
    });
  }, []);

  const clearFileChanges = useCallback(() => {
    setFileChanges([]);
  }, []);

  const navigateToFile = useCallback((path: string) => {
    setPendingFilePath(path);
  }, []);

  const clearPendingFile = useCallback(() => {
    setPendingFilePath(null);
  }, []);

  const navigateToPreview = useCallback((url: string) => {
    setPendingPreviewUrl(url);
  }, []);

  const clearPendingPreview = useCallback(() => {
    setPendingPreviewUrl(null);
  }, []);

  return (
    <WorkspaceContext.Provider
      value={{
        fileChanges,
        pushFileChange,
        clearFileChanges,
        navigateToFile,
        pendingFilePath,
        clearPendingFile,
        navigateToPreview,
        pendingPreviewUrl,
        clearPendingPreview,
      }}
    >
      {children}
    </WorkspaceContext.Provider>
  );
}
