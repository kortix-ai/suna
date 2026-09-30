import { and, eq } from 'drizzle-orm';

import { projectSessions } from '@kortix/db';
import { logger as appLogger } from '../lib/logger';
import { db } from '../shared/db';
import type { ProjectSessionRow } from './lib/serializers';
import { projectSessionMetadataMerge } from './lib/session-metadata-merge';
import { readRuntimeLeg } from './lib/session-runtime-projection';
import { refreshRuntimeProjection } from './lib/session-runtime-projection-refresh';
import type { OpencodeSessionLite } from './opencode-mapping';

// Keeps `metadata.opencode_sessions` — the scoped list of the runtime's
// conversations (root + subagent children) under a session's canonical root —
// fresh. Clients read it as `runtime_sessions` for the conversation count and
// the subagent rows (the SDK's `directSubsessions`). The list comes from the
// runtime projection's `sessions` (`/kortix/runtime/state`), which both
// harnesses serve, so a harness needs no OpenCode `GET /session` to show its
// children. Session TITLES are NOT handled here: `metadata.name` is owned
// solely by session-title-generate.ts. The canonical-root PIN
// (`runtime_session_id`) is owned solely by ensureOpencodeSessionPin; this pass
// only reads it to scope the snapshot.
//
// Scheduled deferred off the prompt proxy — the one moment the sandbox is
// guaranteed awake — and best-effort: a failure never surfaces to the prompt.

const FIRST_ATTEMPT_DELAY_MS = 20_000;
const RETRY_DELAY_MS = 40_000;

const pending = new Set<string>();

type OpenCodeSessionSnapshot = {
  id: string;
  title: string | null;
  parent_id: string | null;
  project_id: string | null;
  created_at: number | null;
  updated_at: number | null;
  archived_at: number | null;
};

type OpenCodeSessionLike = OpencodeSessionLite & {
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

function normalizeSnapshot(session: OpenCodeSessionLike): OpenCodeSessionSnapshot | null {
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

/** Resolve each session's canonical root by walking `parent_id` to the top. */
function rootResolver(entries: OpenCodeSessionSnapshot[]) {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const rootById = new Map<string, string>();

  const resolveRoot = (id: string): string => {
    const cached = rootById.get(id);
    if (cached) return cached;
    const seen = new Set<string>();
    let current = id;
    while (true) {
      if (seen.has(current)) break;
      seen.add(current);
      const parent = byId.get(current)?.parent_id;
      if (!parent) break;
      if (!byId.has(parent)) {
        current = parent;
        break;
      }
      current = parent;
    }
    for (const seenId of seen) rootById.set(seenId, current);
    return current;
  };

  for (const entry of entries) resolveRoot(entry.id);
  return resolveRoot;
}

function sameSessions(a: unknown, b: OpenCodeSessionSnapshot[]): boolean {
  try {
    return JSON.stringify(Array.isArray(a) ? a : []) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/** Seams for unit tests: the projection pull and the stored-projection read. */
export interface SnapshotSourceDeps {
  refresh?: typeof refreshRuntimeProjection;
  readLeg?: typeof readRuntimeLeg;
}

/** Refresh `metadata.opencode_sessions` for one session from its runtime projection.
 *  Writes only when the scoped snapshot changed; best-effort on unreachability. */
export async function syncOpencodeSessionSnapshot(
  input: { row: ProjectSessionRow; userId?: string },
  deps: SnapshotSourceDeps = {},
): Promise<ProjectSessionRow> {
  const { row } = input;
  // Pull the box's current document first (a 304 when nothing changed). The
  // read below also serves a projection the box pushed, or one stored before.
  if (input.userId) {
    await (deps.refresh ?? refreshRuntimeProjection)(
      { sessionId: row.sessionId, projectId: row.projectId, accountId: row.accountId, userId: input.userId },
      { force: true },
    );
  }
  const leg = await (deps.readLeg ?? readRuntimeLeg)(row.sessionId);
  if (!leg.known) return row;
  const sessions = leg.state.sessions as { known?: unknown; value?: unknown } | undefined;
  if (sessions?.known !== true || !Array.isArray(sessions.value)) return row;

  const snapshots = sessions.value
    .map((session) => normalizeSnapshot(session as OpenCodeSessionLike))
    .filter((session): session is OpenCodeSessionSnapshot => Boolean(session));
  if (snapshots.length === 0) return row;

  // The pin, else the root the box itself reports. Not `pickCanonicalRoot`:
  // it reads `parentID`, and a projection entry names its parent `parent_id`.
  const resolvedRootId = row.runtimeSessionId ?? leg.identity.opencode_session_id;
  if (!resolvedRootId) return row;

  const resolveRoot = rootResolver(snapshots);
  const scopedSessions = snapshots
    .filter((entry) => resolveRoot(entry.id) === resolvedRootId)
    .sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0));

  const metadata = (row.metadata ?? {}) as Record<string, unknown>;
  if (sameSessions(metadata.opencode_sessions, scopedSessions)) return row;

  // Merge in-SQL, never write back the whole object read above: this pass is
  // scheduled off the SAME prompt that fires title generation, so a
  // read-modify-write here drops the `metadata.name` the title CAS committed in
  // between — permanently, for a one-shot automation session with no later
  // prompt to re-trigger titling.
  const nextMetadata = { ...metadata, opencode_sessions: scopedSessions };
  const [updated] = await db
    .update(projectSessions)
    .set({
      metadata: projectSessionMetadataMerge({ opencode_sessions: scopedSessions }),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(projectSessions.sessionId, row.sessionId),
        eq(projectSessions.projectId, row.projectId),
        eq(projectSessions.accountId, row.accountId),
      ),
    )
    .returning();

  return updated ?? { ...row, metadata: nextMetadata, updatedAt: new Date() };
}

/** Injectable seams so unit tests run without process-global module mocks. */
export interface SnapshotSyncOptions {
  firstMs?: number;
  retryMs?: number;
  loadRow?: (sessionId: string, projectId: string) => Promise<ProjectSessionRow | null>;
  sync?: typeof syncOpencodeSessionSnapshot;
}

async function loadRow(sessionId: string, projectId: string): Promise<ProjectSessionRow | null> {
  const [row] = await db
    .select()
    .from(projectSessions)
    .where(and(eq(projectSessions.sessionId, sessionId), eq(projectSessions.projectId, projectId)))
    .limit(1);
  return (row as ProjectSessionRow | undefined) ?? null;
}

/**
 * Schedule a deferred `opencode_sessions` refresh for a session that just served
 * a prompt. Safe to call on every prompt — deduped per session; two attempts
 * (the second catches sub-agent sessions spawned during the turn).
 *
 * `userId` is REQUIRED, not optional. It signs the `X-Kortix-User-Context` the
 * projection pull sends; without it the sync can only read a projection the
 * box pushed on its own (boot, env, catalog), which lists no child spawned
 * since. A userId-less schedule once left `metadata.opencode_sessions` empty on
 * 0 of 2804 staging sessions (2026-08). Spelling the parameter as required
 * (rather than `userId?`) makes the compiler, not a reviewer, catch the next
 * caller that forgets it.
 */
export function scheduleOpencodeSnapshotSync(
  input: { sessionId: string; projectId: string; accountId: string; userId: string | undefined },
  options: SnapshotSyncOptions = {},
): void {
  if (!input.sessionId || !input.projectId || !input.accountId) return;
  if (pending.has(input.sessionId)) return;
  pending.add(input.sessionId);

  const firstMs = options.firstMs ?? FIRST_ATTEMPT_DELAY_MS;
  const retryMs = options.retryMs ?? RETRY_DELAY_MS;
  const load = options.loadRow ?? loadRow;
  const sync = options.sync ?? syncOpencodeSessionSnapshot;

  const attempt = async (): Promise<void> => {
    const row = await load(input.sessionId, input.projectId);
    if (row) await sync({ row, userId: input.userId });
  };

  const run = async () => {
    try {
      await attempt();
      await new Promise((resolve) => setTimeout(resolve, retryMs));
      await attempt();
    } catch (err) {
      appLogger.warn('[session-snapshot] deferred sync failed', {
        sessionId: input.sessionId,
        projectId: input.projectId,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      pending.delete(input.sessionId);
    }
  };

  setTimeout(() => void run(), firstMs);
}

/** Test hook: number of sessions with a snapshot sync in flight. */
export function pendingSnapshotSyncs(): number {
  return pending.size;
}
