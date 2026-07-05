/**
 * Git History API — retrieve commit history for files via the OpenCode PTY system.
 *
 * Since the OpenCode SDK doesn't expose a native `git log` endpoint,
 * we create a short-lived PTY that runs git commands, collect the output
 * via WebSocket, parse it, and return structured data.
 */

import { getClient } from '@/lib/opencode-sdk';
import { getPtyWebSocketUrl } from '@/hooks/opencode/use-opencode-pty';
import type { GitCommit, FileHistoryResult, FileCommitDiff } from '../types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Separator used in git log format to split fields reliably */
const FIELD_SEP = '§§§';
/** Separator used between commits */
const COMMIT_SEP = '###COMMIT###';

/** Maximum time to wait for PTY WebSocket output (ms) */
const WS_TIMEOUT = 15_000;

// ---------------------------------------------------------------------------
// Helper: run a one-shot command via PTY and return the text output
// ---------------------------------------------------------------------------

/**
 * Create a PTY that runs a command, collect all output, then destroy it.
 * Returns the combined stdout as a string.
 */
async function runGitCommand(command: string): Promise<string> {
  const client = getClient();

  // Create a PTY that runs the git command
  const createResult = await client.pty.create({
    command: '/bin/sh',
    args: ['-c', command],
    title: '__git-history-query__',
  });

  if (createResult.error) {
    const err = createResult.error as any;
    throw new Error(err?.data?.message || err?.message || 'Failed to create PTY for git command');
  }

  const pty = createResult.data as any;
  const ptyId = pty?.id;
  if (!ptyId) {
    throw new Error('PTY created but no ID returned');
  }

  // Connect via WebSocket to read output
  const connectUrl = await getPtyWebSocketUrl(ptyId);

  const output = await new Promise<string>((resolve, reject) => {
    const chunks: string[] = [];
    let resolved = false;

    const ws = new WebSocket(connectUrl);
    ws.binaryType = 'arraybuffer';

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        ws.close();
        resolve(chunks.join(''));
      }
    }, WS_TIMEOUT);

    ws.onmessage = (event) => {
      if (resolved) return;
      let text: string;
      if (event.data instanceof ArrayBuffer) {
        text = new TextDecoder().decode(event.data);
      } else {
        text = String(event.data);
      }
      chunks.push(text);
    };

    ws.onclose = () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve(chunks.join(''));
      }
    };

    ws.onerror = () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        // Still resolve with what we have — the command may have finished
        resolve(chunks.join(''));
      }
    };
  });

  // Cleanup: remove the PTY (fire-and-forget)
  client.pty.remove({ ptyID: ptyId } as any).catch(() => {});

  return output;
}

// ---------------------------------------------------------------------------
// Fallback: direct fetch when PTY isn't available
// ---------------------------------------------------------------------------

/**
 * Alternative: run git commands via direct fetch to a simulated endpoint.
 * Uses the /pty create + websocket approach but falls back to a parsed
 * response from a fetch call.
 */

// ---------------------------------------------------------------------------
// Git log parsing
// ---------------------------------------------------------------------------

/**
 * Parse structured git log output into GitCommit objects.
 *
 * The git log format outputs fields separated by FIELD_SEP,
 * with commits separated by COMMIT_SEP.
 */
function parseGitLog(raw: string): GitCommit[] {
  if (!raw || !raw.trim()) return [];

  const commits: GitCommit[] = [];
  // Split by commit separator, filter empty
  const blocks = raw.split(COMMIT_SEP).filter((b) => b.trim());

  for (const block of blocks) {
    const fields = block.trim().split(FIELD_SEP);
    if (fields.length < 6) continue;

    const [hash, shortHash, author, authorEmail, dateStr, subject, ...bodyParts] = fields;

    // Strip ANSI escape codes that PTY might inject
    const clean = (s: string) => s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').trim();

    const cleanHash = clean(hash);
    if (!cleanHash || cleanHash.length < 7) continue;

    const timestamp = new Date(clean(dateStr)).getTime();
    if (isNaN(timestamp)) continue;

    commits.push({
      hash: cleanHash,
      shortHash: clean(shortHash),
      author: clean(author),
      authorEmail: clean(authorEmail),
      date: clean(dateStr),
      timestamp,
      subject: clean(subject),
      body: clean(bodyParts.join(FIELD_SEP)),
    });
  }

  return commits;
}

/**
 * Parse `git diff --numstat` output to get addition/deletion counts.
 */
function parseNumstat(raw: string): { additions: number; deletions: number } {
  const lines = raw.trim().split('\n').filter(Boolean);
  let additions = 0;
  let deletions = 0;
  for (const line of lines) {
    const parts = line.split('\t');
    if (parts.length >= 2) {
      const a = parseInt(parts[0], 10);
      const d = parseInt(parts[1], 10);
      if (!isNaN(a)) additions += a;
      if (!isNaN(d)) deletions += d;
    }
  }
  return { additions, deletions };
}

/**
 * Infer change status from a diff patch string.
 */
function inferChangeStatus(patch: string, before: string, after: string): FileCommitDiff['status'] {
  if (!before && after) return 'added';
  if (before && !after) return 'deleted';
  if (patch.includes('rename from') || patch.includes('similarity index')) return 'renamed';
  return 'modified';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get the commit history for a specific file.
 *
 * @param filePath - Relative file path from the project root
 * @param limit - Maximum number of commits to return (default 50)
 * @param skip - Number of commits to skip for pagination (default 0)
 * @returns Structured file history with commits sorted newest-first
 */
export async function getFileHistory(
  filePath: string,
  limit = 50,
  skip = 0,
): Promise<FileHistoryResult> {
  const format = [
    '%H',   // full hash
    '%h',   // short hash
    '%an',  // author name
    '%ae',  // author email
    '%aI',  // author date ISO
    '%s',   // subject
    '%b',   // body
  ].join(FIELD_SEP);

  // Request one extra to detect if there are more
  const actualLimit = limit + 1;

  const cmd = `git log --follow --format="${COMMIT_SEP}${format}" --skip=${skip} -n ${actualLimit} -- "${filePath}" 2>/dev/null || echo ""`;

  const raw = await runGitCommand(cmd);
  const commits = parseGitLog(raw);

  const hasMore = commits.length > limit;
  const trimmed = hasMore ? commits.slice(0, limit) : commits;

  return {
    filePath,
    commits: trimmed,
    hasMore,
  };
}

/**
 * Get the diff for a specific commit affecting a specific file.
 *
 * @param filePath - Relative file path
 * @param commitHash - The commit hash to show
 * @returns Structured diff data with before/after content and patch
 */
export async function getFileCommitDiff(
  filePath: string,
  commitHash: string,
): Promise<FileCommitDiff> {
  // Run three commands in sequence:
  // 1. Get the unified diff patch
  // 2. Get the file content before the commit (from parent)
  // 3. Get the file content after the commit
  const cmd = [
    // Patch
    `echo "===PATCH_START==="`,
    `git diff ${commitHash}^..${commitHash} -- "${filePath}" 2>/dev/null || git diff --root ${commitHash} -- "${filePath}" 2>/dev/null || echo ""`,
    `echo "===PATCH_END==="`,
    // Numstat for additions/deletions
    `echo "===NUMSTAT_START==="`,
    `git diff --numstat ${commitHash}^..${commitHash} -- "${filePath}" 2>/dev/null || git diff --numstat --root ${commitHash} -- "${filePath}" 2>/dev/null || echo ""`,
    `echo "===NUMSTAT_END==="`,
    // Before (parent commit)
    `echo "===BEFORE_START==="`,
    `git show ${commitHash}^:"${filePath}" 2>/dev/null || echo ""`,
    `echo "===BEFORE_END==="`,
    // After (this commit)
    `echo "===AFTER_START==="`,
    `git show ${commitHash}:"${filePath}" 2>/dev/null || echo ""`,
    `echo "===AFTER_END==="`,
  ].join(' && ');

  const raw = await runGitCommand(cmd);

  // Strip ANSI codes from the entire output
  const cleaned = raw.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');

  // Extract sections
  const extract = (startTag: string, endTag: string): string => {
    const startIdx = cleaned.indexOf(startTag);
    const endIdx = cleaned.indexOf(endTag);
    if (startIdx === -1 || endIdx === -1) return '';
    return cleaned.substring(startIdx + startTag.length, endIdx).trim();
  };

  const patch = extract('===PATCH_START===', '===PATCH_END===');
  const numstat = extract('===NUMSTAT_START===', '===NUMSTAT_END===');
  const before = extract('===BEFORE_START===', '===BEFORE_END===');
  const after = extract('===AFTER_START===', '===AFTER_END===');

  const { additions, deletions } = parseNumstat(numstat);
  const status = inferChangeStatus(patch, before, after);

  // Determine parent hash
  let parentHash: string | null = null;
  try {
    const parentCmd = `git rev-parse ${commitHash}^ 2>/dev/null || echo ""`;
    const parentRaw = await runGitCommand(parentCmd);
    const cleaned = parentRaw.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').trim();
    if (cleaned && cleaned.length >= 7 && !cleaned.includes('unknown revision')) {
      parentHash = cleaned;
    }
  } catch {
    // Initial commit — no parent
  }

  return {
    commitHash,
    parentHash,
    patch,
    before,
    after,
    additions,
    deletions,
    status,
  };
}

/**
 * Get the file content at a specific commit.
 *
 * @param filePath - Relative file path
 * @param commitHash - The commit hash
 * @returns The file content as a string (empty if file didn't exist)
 */
export async function getFileAtCommit(
  filePath: string,
  commitHash: string,
): Promise<string> {
  const cmd = `git show ${commitHash}:"${filePath}" 2>/dev/null || echo ""`;
  const raw = await runGitCommand(cmd);
  return raw.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').trim();
}
