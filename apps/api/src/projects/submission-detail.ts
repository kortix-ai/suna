/**
 * Work-submission detail — parsing/validation for the structured `detail`
 * payload of a `kind: output` review item (the `kortix submit` surface).
 *
 * Pure logic only (no DB, no git) so it unit-tests like review-items.ts. The
 * shape is versioned via `submission_version`; a detail without it is a legacy
 * free-form payload and passes through untouched apart from the server-owned
 * `trace` key. See docs/specs/2026-07-08-session-work-submission.md §4.2.
 */

export const SUBMISSION_KEEP_REF_PREFIX = 'refs/kortix/submissions/';

/** Per-file cap: git-pinned artifacts are repo objects, not a blob store. */
export const MAX_SUBMISSION_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_SUBMISSION_FILES = 100;
export const MAX_INLINE_CONTENT_CHARS = 64_000;
export const MAX_CLAIMS = 20;
export const MAX_CLAIM_CHARS = 500;

export interface SubmissionFileRef {
  path: string;
  kind?: string;
  bytes?: number;
}

export interface SubmissionGitDetail {
  commit_sha: string;
  branch?: string;
  keep_ref?: string;
  files: SubmissionFileRef[];
}

export interface OutputSubmissionDetail {
  submission_version: 1;
  artifact_kind?: string;
  storage: 'git' | 'inline';
  git?: SubmissionGitDetail;
  content?: string;
  claims?: string[];
  [key: string]: unknown;
}

export type ParsedSubmissionDetail =
  | { ok: true; structured: true; value: OutputSubmissionDetail }
  | { ok: true; structured: false; value: Record<string, unknown> }
  | { ok: false; error: string };

export function submissionKeepRef(reviewItemId: string): string {
  return `${SUBMISSION_KEEP_REF_PREFIX}${reviewItemId}`;
}

const SHA_REGEX = /^[0-9a-f]{40}$/;

/** Repo-relative, no traversal, no absolute paths, no leading dashes. */
export function normalizeSubmissionPath(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim().replace(/^\.\//, '');
  if (!trimmed || trimmed.length > 512) return null;
  if (trimmed.startsWith('/') || trimmed.startsWith('-')) return null;
  const segments = trimmed.split('/');
  if (segments.some((s) => !s || s === '.' || s === '..')) return null;
  if (/[\0\n\r]/.test(trimmed)) return null;
  return trimmed;
}

function parseClaims(input: unknown): { ok: true; claims: string[] | undefined } | { ok: false; error: string } {
  if (input === undefined || input === null) return { ok: true, claims: undefined };
  if (!Array.isArray(input)) return { ok: false, error: 'claims must be an array of strings' };
  if (input.length > MAX_CLAIMS) return { ok: false, error: `claims must have at most ${MAX_CLAIMS} entries` };
  const claims: string[] = [];
  for (const raw of input) {
    if (typeof raw !== 'string') return { ok: false, error: 'claims must be an array of strings' };
    const claim = raw.trim();
    if (!claim) continue;
    if (claim.length > MAX_CLAIM_CHARS) {
      return { ok: false, error: `each claim must be at most ${MAX_CLAIM_CHARS} characters` };
    }
    claims.push(claim);
  }
  return { ok: true, claims: claims.length > 0 ? claims : undefined };
}

function parseGitDetail(input: unknown): { ok: true; git: SubmissionGitDetail } | { ok: false; error: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'git detail is required when storage is "git"' };
  }
  const raw = input as Record<string, unknown>;
  const sha = typeof raw.commit_sha === 'string' ? raw.commit_sha.trim().toLowerCase() : '';
  if (!SHA_REGEX.test(sha)) {
    return { ok: false, error: 'git.commit_sha must be a full 40-char commit sha' };
  }
  if (!Array.isArray(raw.files) || raw.files.length === 0) {
    return { ok: false, error: 'git.files must be a non-empty array' };
  }
  if (raw.files.length > MAX_SUBMISSION_FILES) {
    return { ok: false, error: `git.files must have at most ${MAX_SUBMISSION_FILES} entries` };
  }
  const files: SubmissionFileRef[] = [];
  const seen = new Set<string>();
  for (const entry of raw.files) {
    const rec = entry && typeof entry === 'object' && !Array.isArray(entry) ? (entry as Record<string, unknown>) : null;
    const path = normalizeSubmissionPath(rec?.path);
    if (!path) return { ok: false, error: 'every git.files entry needs a valid repo-relative path' };
    if (seen.has(path)) return { ok: false, error: `duplicate file path: ${path}` };
    seen.add(path);
    const bytes = typeof rec?.bytes === 'number' && Number.isFinite(rec.bytes) ? Math.floor(rec.bytes) : undefined;
    if (bytes !== undefined && bytes > MAX_SUBMISSION_FILE_BYTES) {
      return { ok: false, error: `file exceeds the ${Math.floor(MAX_SUBMISSION_FILE_BYTES / (1024 * 1024))}MB per-file cap: ${path}` };
    }
    const kind = typeof rec?.kind === 'string' && rec.kind.trim() ? rec.kind.trim().toLowerCase() : undefined;
    files.push({ path, ...(kind ? { kind } : {}), ...(bytes !== undefined ? { bytes } : {}) });
  }
  const branch = typeof raw.branch === 'string' && raw.branch.trim() ? raw.branch.trim() : undefined;
  return { ok: true, git: { commit_sha: sha, ...(branch ? { branch } : {}), files } };
}

/**
 * Validate a submitted `detail` for `kind: output`. The server-owned `trace`
 * and `git.keep_ref` fields are rejected outright rather than stripped — a
 * client sending them is confused, and silently dropping fields hides that.
 */
export function parseOutputSubmissionDetail(detail: Record<string, unknown>): ParsedSubmissionDetail {
  if (detail.trace !== undefined) {
    return { ok: false, error: 'detail.trace is server-assigned and cannot be submitted' };
  }
  if (detail.submission_version === undefined) {
    // Legacy free-form output detail (pre-structured clients) — pass through.
    return { ok: true, structured: false, value: detail };
  }
  if (detail.submission_version !== 1) {
    return { ok: false, error: 'unsupported submission_version (expected 1)' };
  }

  const storage = detail.storage;
  if (storage !== 'git' && storage !== 'inline') {
    return { ok: false, error: 'storage must be "git" or "inline"' };
  }

  const claimsResult = parseClaims(detail.claims);
  if (!claimsResult.ok) return claimsResult;

  const artifactKind =
    typeof detail.artifact_kind === 'string' && detail.artifact_kind.trim()
      ? detail.artifact_kind.trim().toLowerCase()
      : undefined;

  if (storage === 'inline') {
    const content = typeof detail.content === 'string' ? detail.content : '';
    if (!content.trim()) return { ok: false, error: 'content is required when storage is "inline"' };
    if (content.length > MAX_INLINE_CONTENT_CHARS) {
      return { ok: false, error: `inline content must be at most ${MAX_INLINE_CONTENT_CHARS} characters` };
    }
    return {
      ok: true,
      structured: true,
      value: {
        submission_version: 1,
        storage: 'inline',
        content,
        ...(artifactKind ? { artifact_kind: artifactKind } : {}),
        ...(claimsResult.claims ? { claims: claimsResult.claims } : {}),
      },
    };
  }

  if (detail.git && typeof detail.git === 'object' && !Array.isArray(detail.git)) {
    const gitRaw = detail.git as Record<string, unknown>;
    if (gitRaw.keep_ref !== undefined) {
      return { ok: false, error: 'git.keep_ref is server-assigned and cannot be submitted' };
    }
  }
  const gitResult = parseGitDetail(detail.git);
  if (!gitResult.ok) return gitResult;

  return {
    ok: true,
    structured: true,
    value: {
      submission_version: 1,
      storage: 'git',
      git: gitResult.git,
      ...(artifactKind ? { artifact_kind: artifactKind } : {}),
      ...(claimsResult.claims ? { claims: claimsResult.claims } : {}),
    },
  };
}
