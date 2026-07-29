import { and, eq } from 'drizzle-orm';

import { projectSessions } from '@kortix/db';
import { logger as appLogger } from '../lib/logger';
import { db } from '../shared/db';
import type { ProjectSessionRow } from './lib/serializers';
import {
  type OpencodeSessionLite,
  listSandboxOpencodeSessions,
  resolveRootSessionId,
} from './opencode-mapping';

// Keeps `metadata.opencode_sessions` — the scoped list of the OpenCode sessions
// (root + sub-agent children) under a session's canonical root — fresh. The
// frontend reads it for the conversation count and per-conversation labels
// (project-sessions-view.tsx, session-label.ts). Session TITLES are NOT handled
// here: `metadata.name` is owned solely by session-title-generate.ts. The
// canonical-root PIN (`opencode_session_id`) is owned solely by
// ensureOpencodeSessionPin; this pass only reads it to scope the snapshot.
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

/** Refresh `metadata.opencode_sessions` for one session from its live sandbox.
 *  Writes only when the scoped snapshot changed; best-effort on unreachability. */
export async function syncOpencodeSessionSnapshot(input: {
  row: ProjectSessionRow;
  externalId: string;
  userId?: string;
}): Promise<ProjectSessionRow> {
  const listed = await listSandboxOpencodeSessions(input.externalId, input.userId);
  if (!listed.ok) return input.row;

  const snapshots = listed.sessions
    .map((session) => normalizeSnapshot(session as OpenCodeSessionLike))
    .filter((session): session is OpenCodeSessionSnapshot => Boolean(session));
  if (snapshots.length === 0) return input.row;

  const resolvedRootId = resolveRootSessionId({
    pinnedRootId: input.row.opencodeSessionId,
    sessions: listed.sessions,
  });
  if (!resolvedRootId) return input.row;

  const resolveRoot = rootResolver(snapshots);
  const scopedSessions = snapshots
    .filter((entry) => resolveRoot(entry.id) === resolvedRootId)
    .sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0));

  const metadata = (input.row.metadata ?? {}) as Record<string, unknown>;
  if (sameSessions(metadata.opencode_sessions, scopedSessions)) return input.row;

  const nextMetadata = { ...metadata, opencode_sessions: scopedSessions };
  const [updated] = await db
    .update(projectSessions)
    .set({ metadata: nextMetadata, updatedAt: new Date() })
    .where(
      and(
        eq(projectSessions.sessionId, input.row.sessionId),
        eq(projectSessions.projectId, input.row.projectId),
        eq(projectSessions.accountId, input.row.accountId),
      ),
    )
    .returning();

  return updated ?? { ...input.row, metadata: nextMetadata, updatedAt: new Date() };
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
 */
export function scheduleOpencodeSnapshotSync(
  input: { sessionId: string; projectId: string; externalId: string; userId?: string },
  options: SnapshotSyncOptions = {},
): void {
  if (!input.sessionId || !input.projectId || !input.externalId) return;
  if (pending.has(input.sessionId)) return;
  pending.add(input.sessionId);

  const firstMs = options.firstMs ?? FIRST_ATTEMPT_DELAY_MS;
  const retryMs = options.retryMs ?? RETRY_DELAY_MS;
  const load = options.loadRow ?? loadRow;
  const sync = options.sync ?? syncOpencodeSessionSnapshot;

  const attempt = async (): Promise<void> => {
    const row = await load(input.sessionId, input.projectId);
    if (row) await sync({ row, externalId: input.externalId, userId: input.userId });
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
