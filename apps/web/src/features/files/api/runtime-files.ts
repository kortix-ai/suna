/**
 * Runtime File API — re-export of the SDK's workspace file client.
 *
 * The daemon `/file` + `/find` data operations now live in `@kortix/sdk/files`
 * (one owner, shared by every host). This module only adds the browser-only
 * download helpers (DOM + JSZip), which consume the SDK's data ops.
 */
import JSZip from 'jszip';
import { readBlob, listFiles } from '@kortix/sdk/files';

// Data operations — single source of truth in the SDK. Aliased to the names the
// file panel components already import.
export {
  listFiles,
  readFile,
  getFileStatus,
  findFiles,
  findText,
  uploadFile,
  createFile,
  copyFile,
  deleteFile,
  renameFile,
  getCurrentProject,
  getServerHealth,
  isServerReachable,
  readBlob as readFileAsBlob,
  mkdir as mkdirFile,
  toWorkspaceRelative,
  toDaemonPath,
  toSandboxAbsolutePath,
  isUnderSandboxRoot,
  SANDBOX_FS_ROOTS,
} from '@kortix/sdk/files';
export type { UploadResult } from '@kortix/sdk/files';

// ── browser-only helpers (DOM/JSZip) — not data-layer, stay in the host UI ──

/** Download a single file to the user's machine. */
export async function downloadFile(filePath: string, fileName?: string): Promise<void> {
  const blob = await readBlob(filePath);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName || filePath.split('/').pop() || 'download';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Recursively collect absolute file paths under a directory. */
async function listAllFilesRecursive(dirPath: string): Promise<string[]> {
  const entries = await listFiles(dirPath);
  const results: string[] = [];
  for (const entry of entries) {
    if (entry.type === 'file') results.push(entry.path);
    else if (entry.type === 'directory') results.push(...(await listAllFilesRecursive(entry.path)));
  }
  return results;
}

/** Download a directory as a zip (recursively bundled). */
export async function downloadDirectory(
  dirPath: string,
  dirName?: string,
  onProgress?: (progress: number) => void,
): Promise<void> {
  const zip = new JSZip();
  const name = dirName || dirPath.split('/').filter(Boolean).pop() || 'directory';
  const allFiles = await listAllFilesRecursive(dirPath);

  if (allFiles.length === 0) {
    zip.file('.gitkeep', '');
  } else {
    let done = 0;
    for (const filePath of allFiles) {
      const relativePath = filePath.startsWith(dirPath + '/')
        ? filePath.slice(dirPath.length + 1)
        : filePath.split('/').pop() || filePath;
      zip.file(relativePath, await readBlob(filePath));
      done++;
      onProgress?.(done / allFiles.length);
    }
  }

  const zipBlob = await zip.generateAsync({ type: 'blob' });
  const url = URL.createObjectURL(zipBlob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name}.zip`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
