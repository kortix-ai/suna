/**
 * OpenCode File API — re-export of the SDK's workspace file client.
 *
 * The daemon `/file` + `/find` data operations now live in `@kortix/sdk/files`
 * (one owner, shared by every host). This module only adds the browser-only
 * download helpers (DOM + JSZip), which consume the SDK's data ops.
 */
import { listFiles, readBlob } from '@kortix/sdk/files';
import JSZip from 'jszip';

// Data operations — single source of truth in the SDK. Aliased to the names the
// file panel components already import.
export {
  copyFile,
  createFile,
  deleteFile,
  findFiles,
  findText,
  getCurrentProject,
  getFileStatus,
  getServerHealth,
  isServerReachable,
  isUnderSandboxRoot,
  listFiles,
  mkdir as mkdirFile,
  readFile,
  readBlob as readFileAsBlob,
  renameFile,
  SANDBOX_FS_ROOTS,
  toDaemonPath,
  toSandboxAbsolutePath,
  toWorkspaceRelative,
  uploadFile,
} from '@kortix/sdk/files';
export type { UploadResult } from '@kortix/sdk/files';

// ── browser-only helpers (DOM/JSZip) — not data-layer, stay in the host UI ──

/** Formats that are inert as a top-level document — safe to open directly in a
 * browser tab via a same-origin blob URL. HTML and SVG are deliberately
 * excluded even though a browser tab "renders them natively": both can carry
 * `<script>`, and a blob URL is same-origin, so opening one would execute
 * arbitrary script with access to this app's origin (XSS). In-app preview
 * already renders HTML inertly via a sandboxed iframe `srcDoc`, so nothing is
 * lost — everything else gets Download only, since an omitted control beats a
 * disabled one with no explanation (W4). */
const BROWSER_VIEWABLE_EXT = new Set([
  'pdf',
  'txt',
  'md',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'avif',
  'bmp',
]);

export function isBrowserViewable(fileName: string): boolean {
  const dot = fileName.lastIndexOf('.');
  const ext = dot >= 0 ? fileName.slice(dot + 1).toLowerCase() : '';
  return BROWSER_VIEWABLE_EXT.has(ext);
}

/** Open a sandbox file in a real browser tab via a blob URL. The URL is only
 * ever read by the tab we just opened, so a short-lived revoke (matching
 * `downloadFile`'s own window) is enough — no store, no cleanup on unmount. */
export async function openFileInNewTab(filePath: string): Promise<void> {
  const blob = await readBlob(filePath);
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank', 'noopener,noreferrer');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

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

/** Characters Windows Explorer's extractor (and NTFS itself) refuses in a
 * filename — most notably `:`, which turns "Pitch: intro.pptx" into a
 * silently-truncated or failed extraction on Windows even though macOS/Linux
 * accept it fine. Replaced with '-' before dedup so the zip is extractable
 * cross-platform, not just on the OS the agent happened to build it on. */
const UNSAFE_ZIP_NAME_CHARS = /[:\\/<>|?*"]/g;

/** Zip entry names must be unique; outputs often share basenames across dirs
 * (`report.md` from two different tool calls). Collisions get a `-2`, `-3`, …
 * suffix inserted before the extension, so the file stays recognizable. */
export function uniqueZipNames(names: string[]): string[] {
  const used = new Map<string, number>();
  return names.map((rawName) => {
    const name = rawName.replace(UNSAFE_ZIP_NAME_CHARS, '-');
    const count = (used.get(name) ?? 0) + 1;
    used.set(name, count);
    if (count === 1) return name;
    const dot = name.lastIndexOf('.');
    return dot > 0 ? `${name.slice(0, dot)}-${count}${name.slice(dot)}` : `${name}-${count}`;
  });
}

/** Download a specific set of files as one zip (W15) — outputs are scattered
 * paths across the sandbox, not one directory, so `downloadDirectory` doesn't
 * fit: there is no common root to walk. */
export async function downloadFilesAsZip(
  files: Array<{ path: string; name: string }>,
  zipName: string,
): Promise<void> {
  const zip = new JSZip();
  const names = uniqueZipNames(files.map((f) => f.name));
  await Promise.all(files.map(async (f, i) => zip.file(names[i], await readBlob(f.path))));
  const blob = await zip.generateAsync({ type: 'blob' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${zipName || 'outputs'}.zip`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
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
