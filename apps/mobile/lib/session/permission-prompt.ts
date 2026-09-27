/**
 * Pure decision logic behind the pinned permission card (COR-137 Task 7):
 * which pending permission to pin above the composer, its title line, and
 * the command/pattern text shown in the mono detail block.
 *
 * No React, no React Native. `components/session/PermissionPromptCard.tsx`
 * owns how the card looks.
 */

import { permissionLabel } from './activity';

// ─── Which permission to pin ─────────────────────────────────────────────────

/**
 * The permission the pinned card shows when more than one is pending. The
 * oldest ask (array order matches arrival order — `sync-store.addPermission`
 * appends) wins, same as the question prompt's `pendingQuestions[0]`.
 */
export function pinnedPermission<T extends { id: string }>(permissions: readonly T[]): T | undefined {
  return permissions[0];
}

// ─── Title ────────────────────────────────────────────────────────────────

/** Web `ui/types.ts` `PERMISSION_LABELS` keys, phrased as the card's question. */
const PERMISSION_PROMPT_TITLES: Record<string, string> = {
  bash: 'Run a command in the sandbox?',
  edit: 'Edit a file?',
  write: 'Write a file?',
  read: 'Read a file?',
  webfetch: 'Fetch a URL?',
  mcp: 'Use an MCP tool?',
  doom_loop: 'Repeat this tool call?',
};

/**
 * The card's title line for a permission type, e.g. "Run a command in the
 * sandbox?" for `bash`. Falls back to a metadata title the runtime sent, then
 * to the short label (`permissionLabel`) turned into a question.
 */
export function permissionPromptTitle(permission: string, metadata?: Record<string, unknown>): string {
  const known = PERMISSION_PROMPT_TITLES[permission];
  if (known) return known;
  const metaTitle = metadata?.title;
  if (typeof metaTitle === 'string' && metaTitle.trim()) return metaTitle.trim();
  return `${permissionLabel(permission)}?`;
}

// ─── Command / pattern detail ────────────────────────────────────────────────

/**
 * The concrete thing being gated, for the mono detail block: the request's
 * match patterns (e.g. the bash command), falling back to a metadata title if
 * the runtime sent none (web `session-permission-prompt.tsx` `permissionDetail`).
 * `null` when there is nothing concrete to show.
 */
export function permissionPromptDetail(
  patterns: readonly string[] | undefined,
  metadata?: Record<string, unknown>,
): string | null {
  if (patterns && patterns.length > 0) return patterns.join('  ');
  const title = metadata?.title;
  return typeof title === 'string' && title.trim() ? title : null;
}
