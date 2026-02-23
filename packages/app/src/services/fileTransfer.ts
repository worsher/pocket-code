// ── File Upload / Download Client ────────────────────────
// Handles file upload and download via HTTP to the pocket-code server.

import * as FileSystem from "expo-file-system";
import * as DocumentPicker from "expo-document-picker";

export interface UploadResult {
  success: boolean;
  path?: string;
  size?: number;
  error?: string;
}

export interface UploadProgress {
  totalBytesWritten: number;
  totalBytesExpectedToWrite: number;
}

/**
 * Pick a document from the device and upload it to the server.
 */
export async function pickAndUploadFile(
  serverBaseUrl: string,
  authToken: string,
  sessionId: string,
  targetPath?: string,
  onProgress?: (progress: UploadProgress) => void
): Promise<UploadResult | null> {
  // Pick file
  const result = await DocumentPicker.getDocumentAsync({
    copyToCacheDirectory: true,
  });

  if (result.canceled || !result.assets?.length) {
    return null;
  }

  const asset = result.assets[0];

  return uploadFile(
    serverBaseUrl,
    authToken,
    sessionId,
    asset.uri,
    asset.name || "upload",
    targetPath,
    onProgress
  );
}

/**
 * Upload a file to the server.
 */
export async function uploadFile(
  serverBaseUrl: string,
  authToken: string,
  sessionId: string,
  fileUri: string,
  fileName: string,
  targetPath?: string,
  onProgress?: (progress: UploadProgress) => void
): Promise<UploadResult> {
  const httpBase = serverBaseUrl
    .replace(/^ws:\/\//, "http://")
    .replace(/^wss:\/\//, "https://");

  let url = `${httpBase}/api/files/upload?sessionId=${encodeURIComponent(sessionId)}&fileName=${encodeURIComponent(fileName)}`;
  if (targetPath) {
    url += `&path=${encodeURIComponent(targetPath)}`;
  }

  try {
    const uploadTask = FileSystem.createUploadTask(
      url,
      fileUri,
      {
        httpMethod: "POST",
        uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
        headers: {
          Authorization: `Bearer ${authToken}`,
          "Content-Disposition": `attachment; filename="${fileName}"`,
        },
      },
      onProgress
        ? (data) => {
            onProgress({
              totalBytesWritten: data.totalBytesSent,
              totalBytesExpectedToWrite: data.totalBytesExpectedToSend,
            });
          }
        : undefined
    );

    const response = await uploadTask.uploadAsync();
    if (!response) {
      return { success: false, error: "Upload failed" };
    }

    const body = JSON.parse(response.body);
    return body;
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Download a file from the server workspace.
 */
export async function downloadFile(
  serverBaseUrl: string,
  authToken: string,
  sessionId: string,
  filePath: string
): Promise<{ uri: string } | null> {
  const httpBase = serverBaseUrl
    .replace(/^ws:\/\//, "http://")
    .replace(/^wss:\/\//, "https://");

  const url = `${httpBase}/api/files/download?sessionId=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(filePath)}`;
  const fileName = filePath.split("/").pop() || "download";
  const localUri = `${FileSystem.cacheDirectory}${fileName}`;

  try {
    const result = await FileSystem.downloadAsync(url, localUri, {
      headers: {
        Authorization: `Bearer ${authToken}`,
      },
    });

    if (result.status === 200) {
      return { uri: result.uri };
    }
    return null;
  } catch {
    return null;
  }
}
