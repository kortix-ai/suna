/**
 * Types matching the OpenCode server REST API responses.
 * See: https://opencode.ai/docs/server/#files
 */

/** GET /file?path=<path> response item */
export interface FileNode {
  name: string;
  path: string; // relative to project root
  absolute: string; // absolute filesystem path
  type: 'file' | 'directory';
  ignored: boolean;
}

/** GET /file/content?path=<path> response */
export interface FileContent {
  type: 'text' | 'binary';
  content: string;
  patch?: FilePatch;
  encoding?: 'base64'; // present when content is base64-encoded (images, binaries)
  mimeType?: string;
}

export interface FilePatch {
  oldFileName: string;
  newFileName: string;
  oldHeader?: string;
  newHeader?: string;
  hunks: FilePatchHunk[];
  index?: string;
}

export interface FilePatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

/** GET /file/status response item — git file change status */
export interface GitFileStatus {
  path: string;
  added: number;
  removed: number;
  status: 'added' | 'deleted' | 'modified';
}

/** GET /find?pattern=<pat> response item */
export interface FindMatch {
  path: string;
  lines: string;
  line_number: number;
  absolute_offset: number;
  submatches: Array<{ start: number; end: number }>;
}

// ---------------------------------------------------------------------------
// Git commit history types (parsed from `git log` output)
// ---------------------------------------------------------------------------

/** A single git commit entry for a file's history. */
export interface GitCommit {
  /** Full commit hash */
  hash: string;
  /** Abbreviated commit hash (7 chars) */
  shortHash: string;
  /** Commit author name */
  author: string;
  /** Commit author email */
  authorEmail: string;
  /** Commit date as ISO string */
  date: string;
  /** Commit date as unix timestamp (ms) */
  timestamp: number;
  /** Commit message (first line / subject) */
  subject: string;
  /** Full commit message body (may be empty) */
  body: string;
}

/** Response shape for file history queries. */
export interface FileHistoryResult {
  /** The file path this history belongs to */
  filePath: string;
  /** Ordered list of commits (newest first) */
  commits: GitCommit[];
  /** Whether there are more commits beyond the requested limit */
  hasMore: boolean;
}

/** Diff content between two commits for a single file. */
export interface FileCommitDiff {
  /** The commit hash this diff represents */
  commitHash: string;
  /** The parent commit hash (null for initial commit) */
  parentHash: string | null;
  /** Unified diff patch string */
  patch: string;
  /** File content before the commit (empty for added files) */
  before: string;
  /** File content after the commit (empty for deleted files) */
  after: string;
  /** Number of added lines */
  additions: number;
  /** Number of deleted lines */
  deletions: number;
  /** Change type */
  status: 'added' | 'modified' | 'deleted' | 'renamed';
}

/** LSS semantic search hit (from /lss/search endpoint) */
export interface LssHit {
  file_path: string;
  score: number;
  snippet: string;
  rank_stage?: string;
  indexed_at?: number;
}

/** LSS search response item (one per query) */
export interface LssSearchResult {
  query: string;
  hits: LssHit[];
}

/** GET /project/current response */
export interface OpenCodeProjectInfo {
  id: string;
  worktree: string;
  vcs?: 'git';
  name?: string;
  icon?: {
    url?: string;
    override?: string;
    color?: string;
  };
  time: {
    created: number;
    updated: number;
    initialized?: number;
  };
  sandboxes: string[];
}

/** GET /global/health response */
export interface ServerHealth {
  healthy: boolean;
  version: string;
}
