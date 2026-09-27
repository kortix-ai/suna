/**
 * Unified diff rows for `InlineDiffView` / `RawPatchDiffView`.
 *
 * apps/web renders diffs through `@pierre/diffs` (`components/diff/diff-view.tsx`)
 * fed by `diff`'s `createTwoFilesPatch`: a unified patch with 3 lines of
 * context per hunk, line numbers, and a collapsed "N unmodified lines" row
 * between hunks. This module produces the same rows without a DOM:
 * - `buildUnifiedDiff(old, new)` — line LCS (bounded, see `MAX_LCS_CELLS`),
 *   then hunks with 3 context lines;
 * - `parseUnifiedPatch(patch)` — reads an existing unified patch (apply_patch,
 *   git diff) into the same rows.
 *
 * Lines split on `\n` / `\r\n` only. (`lib/opencode/diff-utils.ts` also turns
 * the two characters `\n` into a newline, which corrupts source code that
 * contains the escape, so it is not reused here.)
 */

export type DiffLineType = 'context' | 'add' | 'del';

export type DiffRow =
  | { kind: 'line'; type: DiffLineType; oldLine?: number; newLine?: number; text: string }
  | { kind: 'separator'; hiddenLines: number };

export interface UnifiedDiff {
  rows: DiffRow[];
  additions: number;
  deletions: number;
}

/** `diff`'s `createTwoFilesPatch` default. */
export const DIFF_CONTEXT_LINES = 3;

/** Above this many old×new cells the LCS table is skipped for a prefix/suffix trim. */
export const MAX_LCS_CELLS = 250_000;

export function splitDiffLines(text: string): string[] {
  if (!text) return [];
  const parts = text.split(/\r?\n/);
  if (parts[parts.length - 1] === '') parts.pop();
  return parts;
}

type Op = { type: DiffLineType; text: string };

function lcsOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: 'context', text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: 'del', text: a[i++] });
    } else {
      ops.push({ type: 'add', text: b[j++] });
    }
  }
  while (i < n) ops.push({ type: 'del', text: a[i++] });
  while (j < m) ops.push({ type: 'add', text: b[j++] });
  return ops;
}

function trimOps(a: string[], b: string[]): Op[] {
  const max = Math.min(a.length, b.length);
  let start = 0;
  while (start < max && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const ops: Op[] = [];
  for (let i = 0; i < start; i++) ops.push({ type: 'context', text: a[i] });
  for (let i = start; i < endA; i++) ops.push({ type: 'del', text: a[i] });
  for (let i = start; i < endB; i++) ops.push({ type: 'add', text: b[i] });
  for (let i = endA; i < a.length; i++) ops.push({ type: 'context', text: a[i] });
  return ops;
}

export function buildUnifiedDiff(oldText: string, newText: string, context = DIFF_CONTEXT_LINES): UnifiedDiff {
  const a = splitDiffLines(oldText);
  const b = splitDiffLines(newText);
  const ops = a.length * b.length > MAX_LCS_CELLS ? trimOps(a, b) : lcsOps(a, b);

  // Number every op, then keep the ones within `context` of a change.
  const numbered: Array<Op & { oldLine?: number; newLine?: number }> = [];
  let oldNo = 0;
  let newNo = 0;
  let additions = 0;
  let deletions = 0;
  for (const op of ops) {
    if (op.type === 'context') numbered.push({ ...op, oldLine: ++oldNo, newLine: ++newNo });
    else if (op.type === 'del') {
      deletions++;
      numbered.push({ ...op, oldLine: ++oldNo });
    } else {
      additions++;
      numbered.push({ ...op, newLine: ++newNo });
    }
  }

  const keep = new Uint8Array(numbered.length);
  numbered.forEach((op, index) => {
    if (op.type === 'context') return;
    const from = Math.max(0, index - context);
    const to = Math.min(numbered.length - 1, index + context);
    for (let k = from; k <= to; k++) keep[k] = 1;
  });

  const rows: DiffRow[] = [];
  let hidden = 0;
  numbered.forEach((op, index) => {
    if (!keep[index]) {
      hidden++;
      return;
    }
    if (hidden > 0) rows.push({ kind: 'separator', hiddenLines: hidden });
    hidden = 0;
    const row: DiffRow = { kind: 'line', type: op.type, text: op.text };
    if (op.oldLine !== undefined && op.type !== 'add') row.oldLine = op.oldLine;
    if (op.newLine !== undefined && op.type !== 'del') row.newLine = op.newLine;
    rows.push(row);
  });
  // Trailing unchanged lines are not shown: a patch does not carry them.

  return { rows, additions, deletions };
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parseUnifiedPatch(patch: string): UnifiedDiff {
  const rows: DiffRow[] = [];
  let additions = 0;
  let deletions = 0;
  let oldNo = 0;
  let newNo = 0;
  /** Lines still owed by the current hunk header; both 0 = between hunks. */
  let oldLeft = 0;
  let newLeft = 0;
  /** New-file line after the previous hunk, to size the gap before the next. */
  let nextExpectedNew = 1;

  for (const raw of patch.split(/\r?\n/)) {
    if (oldLeft === 0 && newLeft === 0) {
      const hunk = HUNK_RE.exec(raw);
      if (hunk) {
        oldNo = parseInt(hunk[1], 10);
        newNo = parseInt(hunk[3], 10);
        oldLeft = hunk[2] === undefined ? 1 : parseInt(hunk[2], 10);
        newLeft = hunk[4] === undefined ? 1 : parseInt(hunk[4], 10);
        const gap = newNo - nextExpectedNew;
        if (gap > 0) rows.push({ kind: 'separator', hiddenLines: gap });
      } else if (raw.startsWith('diff ') || raw.startsWith('+++ ')) {
        // The next file of a multi-file patch restarts line numbering.
        nextExpectedNew = 1;
      }
      continue;
    }
    if (raw.startsWith('\\')) continue;
    if (raw.startsWith('+')) {
      additions++;
      newLeft--;
      rows.push({ kind: 'line', type: 'add', newLine: newNo++, text: raw.slice(1) });
    } else if (raw.startsWith('-')) {
      deletions++;
      oldLeft--;
      rows.push({ kind: 'line', type: 'del', oldLine: oldNo++, text: raw.slice(1) });
    } else {
      oldLeft--;
      newLeft--;
      rows.push({ kind: 'line', type: 'context', oldLine: oldNo++, newLine: newNo++, text: raw.slice(1) });
    }
    oldLeft = Math.max(0, oldLeft);
    newLeft = Math.max(0, newLeft);
    nextExpectedNew = newNo;
  }

  return { rows, additions, deletions };
}
