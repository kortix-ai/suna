import type { RuntimeSessionSnapshot } from '@kortix/api-contract';
import type { OpencodeSessionLite } from '../opencode-session-resolver';

/** A runtime session as the runtime lists it, or as an older writer stored it. */
type RuntimeSessionLike = OpencodeSessionLite & {
  title?: string | null;
  parent_id?: string | null;
  parentId?: string | null;
  projectID?: string | null;
  project_id?: string | null;
  projectId?: string | null;
  created_at?: number | null;
  createdAt?: number | null;
  updated_at?: number | null;
  updatedAt?: number | null;
  archived_at?: number | null;
  archivedAt?: number | null;
};

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numberOrNull(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

/** One entry in the contract shape, or null when it has no id. */
export function normalizeRuntimeSessionSnapshot(value: unknown): RuntimeSessionSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const session = value as RuntimeSessionLike;
  const id = stringOrNull(session.id);
  if (!id) return null;
  return {
    id,
    title: stringOrNull(session.title),
    parent_id: stringOrNull(session.parentID ?? session.parent_id ?? session.parentId),
    project_id: stringOrNull(session.projectID ?? session.project_id ?? session.projectId),
    created_at: numberOrNull(session.time?.created, session.created_at, session.createdAt),
    updated_at: numberOrNull(session.time?.updated, session.updated_at, session.updatedAt),
    archived_at: numberOrNull(session.time?.archived, session.archived_at, session.archivedAt),
  };
}

/**
 * Every entry of a stored snapshot in the contract shape. Rows written before
 * 2026-06-21 by the retired browser sync can hold partial entries; reading
 * through this keeps every response in the contract.
 */
export function normalizeRuntimeSessionSnapshots(value: unknown): RuntimeSessionSnapshot[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(normalizeRuntimeSessionSnapshot)
    .filter((entry): entry is RuntimeSessionSnapshot => entry !== null);
}
