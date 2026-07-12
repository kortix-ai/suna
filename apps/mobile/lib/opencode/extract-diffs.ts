/**
 * Extract file diffs from session messages.
 * Ported from web's session-diff-viewer.tsx extractDiffsFromMessages().
 *
 * Scans all tool parts in messages for write/edit/morph_edit/apply_patch tools
 * and builds per-file before/after content for diff rendering.
 */

import { getDiffStats } from './diff-utils';

export interface FileDiffData {
  /** Full file path */
  file: string;
  /** Content before changes (empty string for new files) */
  before: string;
  /** Content after changes */
  after: string;
  /** Lines added */
  additions: number;
  /** Lines deleted */
  deletions: number;
  /** Change status */
  status: 'added' | 'deleted' | 'modified';
}

const EDIT_TOOLS = new Set(['edit', 'morph_edit']);
const PATCH_TOOLS = new Set(['apply_patch']);
const WRITE_TOOLS = new Set(['write']);

/**
 * Extract all file diffs from session messages by scanning tool parts.
 * Handles:
 * - edit / morph_edit: oldString → newString (or metadata.filediff before/after)
 * - apply_patch: metadata.files array with before/after per file
 * - write: new file creation (before='', after=content)
 *
 * Multiple edits to the same file are accumulated (first before, latest after).
 */
export function extractDiffsFromMessages(
  messages: Array<{ info: { role: string }; parts: Array<any> }> | undefined,
): FileDiffData[] {
  if (!messages) return [];

  // Track last known state per file so we can build the cumulative diff
  const fileMap = new Map<string, { before: string; after: string }>();

  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type !== 'tool') continue;
      const state = part.state;
      if (!state || (state.status !== 'completed' && state.status !== 'running')) continue;

      const toolName: string = part.tool ?? '';
      const input = state.input ?? {};
      const metadata = (state.metadata as Record<string, unknown>) ?? {};

      if (EDIT_TOOLS.has(toolName)) {
        const filePath = (input.filePath as string) || '';
        if (!filePath) continue;

        const filediff = metadata.filediff as Record<string, unknown> | undefined;
        const before = (filediff?.before as string) ?? (input.oldString as string) ?? '';
        const after = (filediff?.after as string) ?? (input.newString as string) ?? '';
        if (!before && !after) continue;

        const existing = fileMap.get(filePath);
        if (existing) {
          existing.after = after;
        } else {
          fileMap.set(filePath, { before, after });
        }
      } else if (PATCH_TOOLS.has(toolName)) {
        const files = (Array.isArray(metadata.files) ? metadata.files : []) as Array<{
          filePath?: string;
          relativePath?: string;
          before?: string;
          after?: string;
        }>;
        for (const file of files) {
          const filePath = file.filePath || file.relativePath || '';
          if (!filePath) continue;
          const before = file.before ?? '';
          const after = file.after ?? '';
          if (!before && !after) continue;

          const existing = fileMap.get(filePath);
          if (existing) {
            existing.after = after;
          } else {
            fileMap.set(filePath, { before, after });
          }
        }
      } else if (WRITE_TOOLS.has(toolName)) {
        const filePath = (input.filePath as string) || '';
        if (!filePath) continue;

        const content = (input.content as string) || '';
        if (!content) continue;

        const existing = fileMap.get(filePath);
        if (existing) {
          // File was previously edited, now being written — update after
          existing.after = content;
        } else {
          fileMap.set(filePath, { before: '', after: content });
        }
      }
    }
  }

  const result: FileDiffData[] = [];
  for (const [file, { before, after }] of fileMap) {
    // Use LCS-based diff stats for accuracy
    const stats = getDiffStats(before, after);

    let status: 'added' | 'deleted' | 'modified' = 'modified';
    if (!before) status = 'added';
    else if (!after) status = 'deleted';

    result.push({
      file,
      before,
      after,
      additions: stats.additions,
      deletions: stats.deletions,
      status,
    });
  }

  return result;
}
