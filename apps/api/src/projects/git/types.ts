// Shared types for the git-backed-project operations module.
// Pure leaf module: no runtime imports, only type declarations.

export interface GitBackedProject {
  projectId: string;
  repoUrl: string;
  defaultBranch: string;
  manifestPath: string;
  gitAuthToken?: string | null;
}

export interface ProjectFileEntry {
  path: string;
  type: "file";
  size: number | null;
}

export interface ProjectConfigSummary {
  is_kortix_repo: boolean;
  signals: Record<string, boolean>;
  manifest_raw: string | null;
  manifest: Record<string, unknown>;
  env: { required: string[]; optional: string[] };
  runtime_configs: Array<{
    runtime: string;
    harness: "claude" | "codex" | "opencode" | "pi";
    config_dir: string;
    path: string;
    raw: string | null;
  }>;
  runtime_config_raw: string | null;
  runtime_default_agent: string | null;
  agent_source: "native" | "declarative";
  /** @deprecated Use agent_source. */
  agent_discovery: "runtime" | "declarative";
  agents: Array<{
    name: string;
    path: string;
    description: string | null;
    mode: string | null;
    source: "runtime" | "opencode" | "kortix.yaml";
    enabled?: boolean;
    runtime?: string | null;
    harness?: "claude" | "codex" | "opencode" | "pi" | null;
    native_agent?: string | null;
    /** Per-agent governance from the manifest's `agents` declarations (v2
     *  `agents:` map, or legacy v1 `[[agents]]`; declarative agents only).
     *  Read-only mirror of the allowlists the parser resolved — `'all'`
     *  means unscoped (every secret/connector the launching user can see). */
    scope?: {
      env: string[] | "all";
      connectors: string[] | "all";
      kortix_cli: string[] | "all";
    };
  }>;
  skills: Array<{ name: string; path: string; description: string | null }>;
  commands: Array<{ name: string; path: string; description: string | null }>;
}

export interface RepoGrepMatch {
  path: string;
  line_number: number;
  line_text: string;
}

// ---------------------------------------------------------------------------
// Branches / commits / diffs — drives the Versions (branches) and Checkpoints
// (commits) panels in the project file viewer. Internal types still use Git
// vocabulary; user-facing strings are translated in the web layer.
// ---------------------------------------------------------------------------

export interface GitBranchInfo {
  name: string;
  is_default: boolean;
  tip: string;
  tip_short: string;
  subject: string;
  committer_name: string;
  committer_email: string;
  committed_at: string;
  ahead: number | null;
  behind: number | null;
}

export interface GitLogEntry {
  hash: string;
  short_hash: string;
  parents: string[];
  author_name: string;
  author_email: string;
  authored_at: string;
  committer_name: string;
  committer_email: string;
  committed_at: string;
  subject: string;
  body: string;
}

export interface GitCommitFile {
  path: string;
  old_path: string | null;
  status:
    "added" | "modified" | "deleted" | "renamed" | "copied" | "typechange";
  additions: number;
  deletions: number;
}

export interface GitCommitDetail extends GitLogEntry {
  files: GitCommitFile[];
}

export interface ListCommitsOptions {
  ref?: string;
  path?: string | null;
  limit?: number;
  skip?: number;
}

export interface GetCommitDiffOptions {
  /** When set, only emit the diff for this single path. */
  path?: string | null;
}

export interface CommitDiff {
  hash: string;
  parent: string | null;
  patch: string;
}

export interface GetFileHistoryOptions {
  ref?: string;
  limit?: number;
  skip?: number;
}

export interface GetFileAtRefResult {
  content: string;
  found: boolean;
}

export interface BranchDiffSummary {
  files: GitCommitFile[];
  files_changed: number;
  additions: number;
  deletions: number;
  patch: string;
  base_sha: string;
  head_sha: string;
  merge_base: string | null;
}

export interface MergePreview {
  base_sha: string;
  head_sha: string;
  merge_base: string | null;
  can_fast_forward: boolean;
  can_merge: boolean;
  conflicts: string[];
  is_up_to_date: boolean;
}

export interface MergeOptions {
  authorName?: string;
  authorEmail?: string;
  message?: string;
}

export interface MergeResult {
  merge_commit_sha: string;
  fast_forward: boolean;
  base_sha_before: string;
  base_sha_after: string;
}
