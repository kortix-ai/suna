/**
 * Shared diff utilities for computing line-level diffs.
 * Used by SessionTurn (inline tool diffs) and ViewChangesSheet (session-wide diff viewer).
 */

export type DiffLine = { type: 'unchanged' | 'added' | 'removed'; text: string };

/**
 * LCS-based unified diff.
 * Computes the Longest Common Subsequence of lines, then emits
 * removed / added / unchanged entries — matching the web's diff output.
 */
export function generateLineDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.replace(/\\n/g, '\n').split('\n');
  const newLines = newText.replace(/\\n/g, '\n').split('\n');
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

/** Count additions and deletions between two texts */
export function getDiffStats(oldText: string, newText: string): { additions: number; deletions: number } {
  const diff = generateLineDiff(oldText, newText);
  return {
    additions: diff.filter(l => l.type === 'added').length,
    deletions: diff.filter(l => l.type === 'removed').length,
  };
}
