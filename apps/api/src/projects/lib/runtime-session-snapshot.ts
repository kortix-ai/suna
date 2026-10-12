import type { RuntimeSessionSnapshot } from '@kortix/api-contract';
import { projectSessions } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { db } from '../../shared/db';
import type { OpencodeSessionLite } from '../opencode-session-resolver';
import { projectSessionMetadataMerge } from './session-metadata-merge';

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

function rootResolver(entries: RuntimeSessionSnapshot[]) {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const rootById = new Map<string, string>();
  const resolveRoot = (id: string): string => {
    const cached = rootById.get(id);
    if (cached) return cached;
    const seen = new Set<string>();
    let current = id;
    while (!seen.has(current)) {
      seen.add(current);
      const parent = byId.get(current)?.parent_id;
      if (!parent) break;
      current = parent;
      if (!byId.has(parent)) break;
    }
    for (const seenId of seen) rootById.set(seenId, current);
    return current;
  };
  return resolveRoot;
}

/**
 * The runtime conversations under `rootId` (the root and its subagent
 * children), newest first, from a state document's `sessions` section. Null
 * when the document does not know its sessions: the stored list then stays.
 */
export function scopedRuntimeSessions(projection: Record<string, unknown>, rootId: string): RuntimeSessionSnapshot[] | null {
  const sessions = projection.sessions as { known?: unknown; value?: unknown } | undefined;
  if (sessions?.known !== true || !Array.isArray(sessions.value)) return null;
  const snapshots = normalizeRuntimeSessionSnapshots(sessions.value);
  if (snapshots.length === 0) return null;
  const resolveRoot = rootResolver(snapshots);
  return snapshots
    .filter((entry) => resolveRoot(entry.id) === rootId)
    .sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0));
}

/**
 * Keep `metadata.opencode_sessions` — the session's runtime conversations,
 * read by clients as `runtime_sessions` — equal to a state document that was
 * just stored. Scoped to the session's pinned root, else the root the document
 * reports; a document for another root than the pin writes nothing (the
 * projection read calls that `identity_mismatch`). Writes only on a change,
 * and merges in SQL so a title committed meanwhile survives.
 *
 * Runs in the projection writer (R7.4), so the daemon's push and the API's
 * pull both feed it, and no timer holds the write: before, a deploy that
 * recycled the pod inside a +20 s / +60 s timer lost it.
 */
export async function writeRuntimeSessionList(input: {
  sessionId: string;
  projectId: string;
  accountId: string;
  projection: Record<string, unknown>;
  runtimeSessionId: string | null;
}): Promise<'written' | 'unchanged' | 'skipped'> {
  const scope = and(
    eq(projectSessions.sessionId, input.sessionId),
    eq(projectSessions.projectId, input.projectId),
    eq(projectSessions.accountId, input.accountId),
  );
  const [row] = await db
    .select({ pin: projectSessions.runtimeSessionId, metadata: projectSessions.metadata })
    .from(projectSessions)
    .where(scope)
    .limit(1);
  if (!row) return 'skipped';
  if (row.pin && input.runtimeSessionId && row.pin !== input.runtimeSessionId) return 'skipped';
  const rootId = row.pin ?? input.runtimeSessionId;
  if (!rootId) return 'skipped';
  const scoped = scopedRuntimeSessions(input.projection, rootId);
  if (!scoped) return 'skipped';
  // Through the normalizer: jsonb hands keys back in its own order, so a raw
  // stringify of the stored value never equals the list it was written from.
  const stored = normalizeRuntimeSessionSnapshots((row.metadata as Record<string, unknown> | null)?.opencode_sessions);
  if (JSON.stringify(stored) === JSON.stringify(scoped)) return 'unchanged';
  await db
    .update(projectSessions)
    .set({ metadata: projectSessionMetadataMerge({ opencode_sessions: scoped }), updatedAt: new Date() })
    .where(scope);
  return 'written';
}
