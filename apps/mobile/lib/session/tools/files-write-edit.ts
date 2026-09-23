/**
 * Pure logic of the `write` / `edit` (`morph_edit`) tool rows — a port of
 * apps/web `tool/tools/write-tool.tsx` (`writeStat`) and `edit-tool.tsx` (its
 * inline source reads, `diffLines` stat, and body branches).
 */

import { filePhase, fileVerb, type FileAction } from '@kortix/sdk';

/** apps/web `hardcodedUi.i18nComplete.text93168435f3ae`. */
export const FILE_BODY_TEXT = {
  noContentReceived: 'No content received',
} as const;

export type DiffCounts = { additions: number; deletions: number };

/** Web `writeStat`: every line of the written content counts as an addition. */
export function writeStat(content: string): DiffCounts | undefined {
  if (!content) return undefined;
  let lines = 1;
  for (let i = content.indexOf('\n'); i !== -1; i = content.indexOf('\n', i + 1)) lines++;
  return { additions: lines, deletions: 0 };
}

/** No stat on a failed call: the numbers would describe a file that did not land. */
export function writeTriggerStat({ isError, content }: { isError: boolean; content: string }): DiffCounts | undefined {
  return isError ? undefined : writeStat(content);
}

/** SDK `fileVerb(action, filePhase(running, isError))` — the row's tense. */
export function fileRowTitle(action: FileAction, { running, isError }: { running: boolean; isError: boolean }): string {
  return fileVerb(action, filePhase(running, isError));
}

/** A pending part from a turn that is over, with no file named. */
export function isStalePendingFile({
  running,
  filename,
  status,
}: {
  running: boolean;
  filename: string;
  status: string;
}): boolean {
  return !running && !filename && (status === 'pending' || status === 'running');
}

export function writeBodyKind({
  isError,
  content,
  isStalePending,
}: {
  isError: boolean;
  content: string;
  isStalePending: boolean;
}): 'error' | 'code' | 'stale' | 'none' {
  if (isError) return 'error';
  if (content) return 'code';
  if (isStalePending) return 'stale';
  return 'none';
}

// ─── Line diff counts (jsdiff `diffLines`) ───────────────────────────────────

/** jsdiff line tokens: each line keeps its trailing newline; a trailing empty token is dropped. */
function lineTokens(text: string): string[] {
  const tokens: string[] = [];
  const parts = text.split(/(\n|\r\n)/);
  if (!parts[parts.length - 1]) parts.pop();
  for (let i = 0; i < parts.length; i++) {
    if (i % 2) tokens[tokens.length - 1] += parts[i];
    else tokens.push(parts[i]);
  }
  return tokens;
}

/**
 * Web `diffLines(before, after, { maxEditLength })` reduced to its counts.
 *
 * Myers' O(ND) search for the edit distance D. A minimal script's deletions
 * are `n − LCS` and its additions `m − LCS`, which are the counts jsdiff's
 * (also minimal) change list sums to. Past `maxEditLength` edits it returns
 * `undefined`, as jsdiff does, so a pathological pair costs a bounded frame.
 */
export function lineDiffCounts(before: string, after: string, maxEditLength = 1000): DiffCounts | undefined {
  const a = lineTokens(before);
  const b = lineTokens(after);
  const n = a.length;
  const m = b.length;
  const maxD = Math.min(n + m, maxEditLength);
  const offset = maxD + 1;
  const v = new Int32Array(2 * maxD + 3);

  for (let d = 0; d <= maxD; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        const lcs = (n + m - d) / 2;
        return { additions: m - lcs, deletions: n - lcs };
      }
    }
  }
  return undefined;
}

// ─── Edit ────────────────────────────────────────────────────────────────────

export interface EditSources {
  filePath: string | undefined;
  before: string;
  after: string;
  codeEdit: string;
  morphInstructions: string;
  hasDiff: boolean;
}

/** Web `EditTool` source reads: `metadata.filediff` → input → streaming input (`??`). */
export function editSources(
  input: Record<string, unknown>,
  streamingInput: Record<string, unknown>,
  metadata: Record<string, unknown>,
): EditSources {
  const filediff = metadata.filediff as Record<string, unknown> | undefined;
  const filePath =
    (input.filePath as string) ||
    (streamingInput.filePath as string) ||
    (streamingInput.target_filepath as string) ||
    undefined;
  const before =
    (filediff?.before as string) ?? (input.oldString as string) ?? (streamingInput.oldString as string) ?? '';
  const after =
    (filediff?.after as string) ?? (input.newString as string) ?? (streamingInput.newString as string) ?? '';
  const codeEdit = (input.code_edit as string) || (streamingInput.code_edit as string) || '';
  const morphInstructions = (input.instructions as string) || (streamingInput.instructions as string) || '';
  return { filePath, before, after, codeEdit, morphInstructions, hasDiff: before !== '' || after !== '' };
}

/** Settled calls only: re-diffing a streaming file per chunk is per-frame work. */
export function editStat({
  status,
  hasDiff,
  before,
  after,
}: {
  status: string;
  hasDiff: boolean;
  before: string;
  after: string;
}): DiffCounts | undefined {
  if (status !== 'completed' || !hasDiff) return undefined;
  return lineDiffCounts(before, after, 1000);
}

export function editBodyKind({
  isError,
  hasDiff,
  codeEdit,
  isStalePending,
}: {
  isError: boolean;
  hasDiff: boolean;
  codeEdit: string;
  isStalePending: boolean;
}): 'error' | 'diff' | 'morph' | 'stale' | 'none' {
  if (isError) return 'error';
  if (hasDiff) return 'diff';
  if (codeEdit) return 'morph';
  if (isStalePending) return 'stale';
  return 'none';
}
