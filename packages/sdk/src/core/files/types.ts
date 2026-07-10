/**
 * Workspace file types — the OpenCode daemon REST shapes.
 * Owned by the SDK so every host shares one definition.
 */

/** `GET /file?path=<path>` response item. */
export interface FileNode {
  name: string;
  path: string; // relative to project root
  absolute: string; // absolute filesystem path
  type: 'file' | 'directory';
  ignored: boolean;
}

export interface FilePatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

export interface FilePatch {
  oldFileName: string;
  newFileName: string;
  oldHeader?: string;
  newHeader?: string;
  hunks: FilePatchHunk[];
  index?: string;
}

/** `GET /file/content?path=<path>` response. */
export interface FileContent {
  type: 'text' | 'binary';
  content: string;
  patch?: FilePatch;
  encoding?: 'base64'; // present when content is base64-encoded (images, binaries)
  mimeType?: string;
}

/** `GET /file/status` response item — git file change status. */
export interface GitFileStatus {
  path: string;
  added: number;
  removed: number;
  status: 'added' | 'deleted' | 'modified';
}

/** `GET /find?pattern=<pat>` response item. */
export interface FindMatch {
  path: string;
  lines: string;
  line_number: number;
  absolute_offset: number;
  submatches: Array<{ start: number; end: number }>;
}

/** `GET /project/current` response. */
export interface OpenCodeProjectInfo {
  id: string;
  worktree: string;
  vcs?: 'git';
  name?: string;
  icon?: { url?: string; override?: string; color?: string };
  time: { created: number; updated: number; initialized?: number };
  sandboxes: string[];
}

/** `GET /global/health` response. */
export interface ServerHealth {
  healthy: boolean;
  version: string;
}

/** Response from the upload endpoint. */
export interface UploadResult {
  path: string;
  size: number;
}
