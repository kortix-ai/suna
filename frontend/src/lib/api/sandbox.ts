import { handleApiError } from '../error-handler';
import { backendApi } from '../api-client';

export interface FileInfo {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  mod_time: string;
  permissions?: string;
}

function normalizePathWithUnicode(path: string): string {
  try {
    return path.replace(/\\u([0-9a-fA-F]{4})/g, (_, hexCode) => {
      return String.fromCharCode(parseInt(hexCode, 16));
    });
  } catch (e) {
    console.error('Error processing Unicode escapes in path:', e);
    return path;
  }
}

export const createSandboxFile = async (
  sandboxId: string,
  filePath: string,
  content: string,
): Promise<void> => {
  try {
    const formData = new FormData();
    formData.append('path', filePath);

    const blob = new Blob([content], { type: 'application/octet-stream' });
    formData.append('file', blob, filePath.split('/').pop() || 'file');

    const response = await backendApi.upload(
      `/sandboxes/${sandboxId}/files`,
      formData,
      { showErrors: true }
    );

    if (response.error) {
      throw new Error(
        `Error creating sandbox file: ${response.error.message} (${response.error.status})`,
      );
    }
  } catch (error) {
    console.error('Failed to create sandbox file:', error);
    handleApiError(error, { operation: 'create file', resource: `file ${filePath}` });
    throw error;
  }
};

export const createSandboxFileJson = async (
  sandboxId: string,
  filePath: string,
  content: string,
): Promise<void> => {
  try {
    const response = await backendApi.post(
      `/sandboxes/${sandboxId}/files/json`,
      {
        path: filePath,
        content: content,
      },
      { showErrors: true }
    );

    if (response.error) {
      throw new Error(
        `Error creating sandbox file: ${response.error.message} (${response.error.status})`,
      );
    }
  } catch (error) {
    console.error('Failed to create sandbox file with JSON:', error);
    handleApiError(error, { operation: 'create file', resource: `file ${filePath}` });
    throw error;
  }
};

export const listSandboxFiles = async (
  sandboxId: string,
  path: string,
): Promise<FileInfo[]> => {
  try {
    const normalizedPath = normalizePathWithUnicode(path);
    const response = await backendApi.get<{ files: FileInfo[] }>(
      `/sandboxes/${sandboxId}/files?path=${encodeURIComponent(normalizedPath)}`,
      { showErrors: true }
    );

    if (response.error) {
      throw new Error(
        `Error listing sandbox files: ${response.error.message} (${response.error.status})`,
      );
    }

    return response.data?.files || [];
  } catch (error) {
    console.error('Failed to list sandbox files:', error);
    throw error;
  }
};

export const getSandboxFileContent = async (
  sandboxId: string,
  path: string,
): Promise<string | Blob> => {
  try {
    const normalizedPath = normalizePathWithUnicode(path);
    const response = await backendApi.get<string | Blob>(
      `/sandboxes/${sandboxId}/files/content?path=${encodeURIComponent(normalizedPath)}`,
      { showErrors: true }
    );

    if (response.error) {
      throw new Error(
        `Error getting sandbox file content: ${response.error.message} (${response.error.status})`,
      );
    }

    // backendApi handles content-type detection and returns appropriate type
    return response.data!;
  } catch (error) {
    console.error('Failed to get sandbox file content:', error);
    handleApiError(error, { operation: 'load file content', resource: `file ${path}` });
    throw error;
  }
};

