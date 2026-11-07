/**
 * Shadow reads (design.md §3.2 C2). In Release 1 every store read answers
 * from `kortix.workspaces_expected(account_id)` (the primary: the live-row
 * rule over the base tables) and reads the `kortix.workspaces` table row of
 * the same id in the same statement (the shadow: what the reconcile triggers
 * wrote). A difference means a trigger missed a write. It is logged with the
 * workspace id and the differing field NAMES only, never their values, and
 * counted in `kortix_workspace_shadow_mismatch_total{field}`. Release 2 flips
 * the two: the table answers, `workspaces_expected` is the shadow.
 */
import { logger } from '../lib/logger';
import { Counter, registerMetricRenderer } from '../lib/metrics';

/** One `to_jsonb(kortix.workspaces)` row, snake_case keys. */
export type WorkspaceRowJson = Record<string, unknown>;

const mismatchTotal = new Counter(
  'kortix_workspace_shadow_mismatch_total',
  'Fields where the kortix.workspaces table row differs from kortix.workspaces_expected (Release 1 shadow reads).',
);
registerMetricRenderer(() => mismatchTotal.render());

/** Fields that are never compared: the reconcile stamps `synced_at` on every write. */
const IGNORED = new Set(['synced_at']);

/** The field `row` marks a row present on one side only. */
export const SHADOW_ROW_FIELD = 'row';

/** The names of the fields where `expected` and `stored` differ. Pure. */
export function shadowMismatchFields(expected: WorkspaceRowJson | null, stored: WorkspaceRowJson | null): string[] {
  if (!expected && !stored) return [];
  if (!expected || !stored) return [SHADOW_ROW_FIELD];
  const fields: string[] = [];
  for (const key of new Set([...Object.keys(expected), ...Object.keys(stored)])) {
    if (IGNORED.has(key)) continue;
    if (JSON.stringify(expected[key] ?? null) !== JSON.stringify(stored[key] ?? null)) fields.push(key);
  }
  return fields.sort();
}

/** Log and count one compared pair. Returns the differing field names. */
export function reportShadow(expected: WorkspaceRowJson | null, stored: WorkspaceRowJson | null): string[] {
  const fields = shadowMismatchFields(expected, stored);
  if (fields.length === 0) return fields;
  const workspaceId = String((expected ?? stored)?.workspace_id ?? '');
  for (const field of fields) mismatchTotal.inc({ field });
  logger.warn('[workspaces] shadow_mismatch', { workspace_id: workspaceId, fields });
  return fields;
}

/** The counter's current values, for tests. */
export function shadowMismatchCount(field: string): number {
  const match = mismatchTotal
    .render()
    .split('\n')
    .find((line) => line.startsWith(`kortix_workspace_shadow_mismatch_total{field="${field}"}`));
  return match ? Number(match.split(' ').pop()) : 0;
}
