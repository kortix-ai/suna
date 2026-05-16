/**
 * Project Files API — Git-backed, read-only.
 *
 * Mirrors the public surface of the sandbox `features/files/api/opencode-files.ts`
 * (so the copy of all UI components/hooks needs no signature changes), but
 * every function dispatches against `/v1/projects/:projectId/files` instead
 * of the OpenCode SDK.
 *
 * Write operations (`writeFile`, `uploadFile`, `deleteFile`, `mkdirFile`,
 * `renameFile`, `createFile`, `copyFile`) throw — project files are
 * immutable from this view; users mutate via a session sandbox + commit.
 */

import { listProjectFiles, readProjectFile } from '@/lib/projects-client';
import type {
  FileContent,
  FileNode,
  FindMatch,
  GitFileStatus,
  OpenCodeProjectInfo,
  ServerHealth,
} from '../types';

const READ_ONLY = 'Read-only — project files come from Git';

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Strip the legacy `/workspace` prefix and any leading slashes so the path
 * matches what `git ls-tree` returns. The copied UI was built against the
 * OpenCode "absolute under /workspace" convention; the project API uses
 * repo-relative paths.
 */
function toRepoRelative(p: string): string {
  let s = p || '';
  if (s.startsWith('/workspace/')) s = s.slice('/workspace/'.length);
  else if (s === '/workspace') s = '';
  while (s.startsWith('/')) s = s.slice(1);
  return s;
}

/** Convert a repo-relative path back to the "/workspace/..." form the UI uses. */
function toWorkspacePath(p: string): string {
  if (!p) return '/workspace';
  return `/workspace/${p}`;
}

function basename(p: string): string {
  const trimmed = p.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

/**
 * List immediate children (files + directories) of `dirPath` for the given
 * project at the given ref.
 *
 * The backend returns a FLAT recursive list (`git ls-tree -r`), so we filter
 * down to entries whose parent equals `dirPath`, plus synthesised directory
 * entries for unique intermediate path segments below `dirPath`.
 */
export async function listFiles(
  projectId: string,
  ref: string,
  dirPath: string,
): Promise<FileNode[]> {
  const relativeDir = toRepoRelative(dirPath);
  const apiDir = relativeDir || undefined;

  const entries = await listProjectFiles(projectId, {
    ref,
    path: apiDir,
  });

  // recursive list → dir-immediate children filter
  const prefix = relativeDir ? `${relativeDir}/` : '';
  const fileNodes = new Map<string, FileNode>();
  const dirNodes = new Map<string, FileNode>();

  for (const entry of entries) {
    if (relativeDir && !entry.path.startsWith(prefix)) continue;
    const rest = relativeDir ? entry.path.slice(prefix.length) : entry.path;
    if (!rest) continue;

    const firstSep = rest.indexOf('/');
    if (firstSep === -1) {
      fileNodes.set(entry.path, {
        name: basename(entry.path),
        path: toWorkspacePath(entry.path),
        absolute: toWorkspacePath(entry.path),
        type: 'file',
        ignored: false,
      });
    } else {
      const dirSegment = rest.slice(0, firstSep);
      const dirRelPath = relativeDir ? `${relativeDir}/${dirSegment}` : dirSegment;
      if (!dirNodes.has(dirRelPath)) {
        dirNodes.set(dirRelPath, {
          name: dirSegment,
          path: toWorkspacePath(dirRelPath),
          absolute: toWorkspacePath(dirRelPath),
          type: 'directory',
          ignored: false,
        });
      }
    }
  }

  return [...dirNodes.values(), ...fileNodes.values()];
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export async function readFile(
  projectId: string,
  ref: string,
  filePath: string,
): Promise<FileContent> {
  const relativePath = toRepoRelative(filePath);
  const result = await readProjectFile(projectId, relativePath, ref);
  return {
    type: 'text',
    content: result.content,
  };
}

/**
 * Project API returns text only; binary preview is unsupported.
 * Producing an empty blob keeps consumers happy without lying about content.
 */
export async function readFileAsBlob(
  projectId: string,
  ref: string,
  filePath: string,
): Promise<Blob> {
  const relativePath = toRepoRelative(filePath);
  const result = await readProjectFile(projectId, relativePath, ref);
  return new Blob([result.content], { type: 'text/plain;charset=utf-8' });
}

export async function downloadFile(
  projectId: string,
  ref: string,
  filePath: string,
  fileName?: string,
): Promise<void> {
  const blob = await readFileAsBlob(projectId, ref, filePath);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName || filePath.split('/').pop() || 'download';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// TODO: wire to project history/search once backend supports it
export async function downloadDirectory(
  _dirPath: string,
  _dirName?: string,
  _onProgress?: (progress: number) => void,
): Promise<void> {
  throw new Error(READ_ONLY);
}

// ---------------------------------------------------------------------------
// Write surface — every function below rejects. The toolbar still wires to
// these visually; we hide the buttons in the page but keep stubs so any
// stray call gets a clean toast.
// ---------------------------------------------------------------------------

export interface UploadResult {
  path: string;
  size: number;
}

export async function uploadFile(
  _file: File | Blob,
  _targetPath?: string,
): Promise<UploadResult[]> {
  throw new Error(READ_ONLY);
}

export async function deleteFile(_filePath: string): Promise<boolean> {
  throw new Error(READ_ONLY);
}

export async function mkdirFile(_dirPath: string): Promise<boolean> {
  throw new Error(READ_ONLY);
}

export async function createFile(_filePath: string): Promise<UploadResult[]> {
  throw new Error(READ_ONLY);
}

export async function copyFile(
  _sourcePath: string,
  _destPath: string,
): Promise<UploadResult[]> {
  throw new Error(READ_ONLY);
}

export async function renameFile(_from: string, _to: string): Promise<boolean> {
  throw new Error(READ_ONLY);
}

// ---------------------------------------------------------------------------
// Git status / search / project info — no-op stubs for the read-only view
// ---------------------------------------------------------------------------

// TODO: wire to project history/search once backend supports it
export async function getFileStatus(): Promise<GitFileStatus[]> {
  return [];
}

// TODO: wire to project history/search once backend supports it
export async function findFiles(
  _query: string,
  _options?: { type?: 'file' | 'directory'; limit?: number },
): Promise<string[]> {
  return [];
}

// TODO: wire to project history/search once backend supports it
export async function findText(_pattern: string): Promise<FindMatch[]> {
  return [];
}

export async function getCurrentProject(): Promise<OpenCodeProjectInfo> {
  return {
    id: 'project-files',
    worktree: '/workspace',
    vcs: 'git',
    name: 'project',
    time: { created: Date.now(), updated: Date.now() },
    sandboxes: [],
  };
}

export async function getServerHealth(): Promise<ServerHealth> {
  return { healthy: true, version: 'project-files' };
}

export async function isServerReachable(): Promise<boolean> {
  return true;
}
