/**
 * Shared diff utilities for computing line-level diffs.
 * Used by SessionTurn (inline tool diffs) and ViewChangesSheet (session-wide diff viewer).
 */

export type DiffLine = { type: 'unchanged' | 'added' | 'removed'; text: string };

/**
 * Above this many (oldLines x newLines) cells, the full LCS table is too
 * expensive to build synchronously on the JS thread (memory and time both
 * scale with n*m). Past the cap, both entry points below fall back to an
 * O(n+m) approximation instead of allocating the table.
 */
export const MAX_LCS_CELLS = 250_000;

function splitLines(text: string): string[] {
  return text.replace(/\\n/g, '\n').split('\n');
}

/**
 * O(n·m) LCS-based unified diff. Computes the Longest Common Subsequence of
 * lines, then emits removed / added / unchanged entries — matching the
 * web's diff output. Callers should not call this directly for
 * caller-controlled-size inputs; use `generateLineDiff`, which applies the
 * size cap first.
 */
function lcsLineDiff(oldLines: string[], newLines: string[]): DiffLine[] {
  const n = oldLines.length;
  const m = newLines.length;

  // Build LCS table
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to produce diff
  const result: DiffLine[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      result.push({ type: 'unchanged', text: oldLines[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.push({ type: 'added', text: newLines[j - 1] });
      j--;
    } else {
      result.push({ type: 'removed', text: oldLines[i - 1] });
      i--;
    }
  }
  result.reverse();
  return result;
}

/**
 * O(n+m) fallback diff for inputs past `MAX_LCS_CELLS`. Trims the common
 * prefix and suffix (cheap, and the common case for a single edit in a
 * large file), then reports everything in between as removed-then-added.
 * Not a true LCS — lines that moved without a shared prefix/suffix are not
 * matched — but it is bounded, and keeps the diff view usable on large files
 * instead of blocking the JS thread on a multi-million-cell table.
 */
function fastLineDiff(oldLines: string[], newLines: string[]): DiffLine[] {
  const maxCommon = Math.min(oldLines.length, newLines.length);
  let start = 0;
  while (start < maxCommon && oldLines[start] === newLines[start]) start++;

  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }

  const result: DiffLine[] = [];
  for (let i = 0; i < start; i++) result.push({ type: 'unchanged', text: oldLines[i] });
  for (let i = start; i < oldEnd; i++) result.push({ type: 'removed', text: oldLines[i] });
  for (let i = start; i < newEnd; i++) result.push({ type: 'added', text: newLines[i] });
  for (let i = oldEnd; i < oldLines.length; i++) result.push({ type: 'unchanged', text: oldLines[i] });
  return result;
}

/**
 * Unified line diff. Uses the exact LCS below `MAX_LCS_CELLS` (oldLines x
 * newLines), and the bounded `fastLineDiff` fallback above it.
 */
export function generateLineDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  if (oldLines.length * newLines.length > MAX_LCS_CELLS) {
    return fastLineDiff(oldLines, newLines);
  }
  return lcsLineDiff(oldLines, newLines);
}

/**
 * O(n+m) multiset line count, used by `getDiffStats` past `MAX_LCS_CELLS`.
 * added = lines of `newLines` with no remaining match in `oldLines`'s
 * multiset; removed = lines of `oldLines` with no remaining match in
 * `newLines`'s multiset. This can differ from the LCS count when lines
 * moved, but stays O(n+m) regardless of input size.
 */
function multisetLineStats(oldLines: string[], newLines: string[]): { additions: number; deletions: number } {
  const oldCounts = new Map<string, number>();
  for (const line of oldLines) oldCounts.set(line, (oldCounts.get(line) ?? 0) + 1);
  const newCounts = new Map<string, number>();
  for (const line of newLines) newCounts.set(line, (newCounts.get(line) ?? 0) + 1);

  let additions = 0;
  for (const [line, count] of newCounts) {
    const matched = oldCounts.get(line) ?? 0;
    if (count > matched) additions += count - matched;
  }

  let deletions = 0;
  for (const [line, count] of oldCounts) {
    const matched = newCounts.get(line) ?? 0;
    if (count > matched) deletions += count - matched;
  }

  return { additions, deletions };
}

/**
 * Count additions and deletions between two texts. Uses the exact LCS below
 * `MAX_LCS_CELLS`, and the bounded multiset count above it.
 */
export function getDiffStats(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  if (oldLines.length * newLines.length > MAX_LCS_CELLS) {
    return multisetLineStats(oldLines, newLines);
  }
  const diff = lcsLineDiff(oldLines, newLines);
  return {
    additions: diff.filter(l => l.type === 'added').length,
    deletions: diff.filter(l => l.type === 'removed').length,
  };
}
