import { and, eq, inArray } from 'drizzle-orm';

import { projectSessions, sessionSandboxes } from '@kortix/db';
import { db } from '../shared/db';
import { logger as appLogger } from '../lib/logger';
import {
  listSandboxOpencodeSessions,
  resolveRootSessionId,
  type OpencodeSessionLite,
} from './opencode-mapping';
import type { ProjectSessionRow } from './lib/serializers';

// Title-sync is best-effort enrichment that runs on every session list/read. It
// fans out one sandbox round-trip per active sandbox (preview-link resolution +
// an OpenCode `/session` fetch). Two hard rules keep it from taking down the
// list endpoint or the shared sandbox provider:
//   1. BOUNDED concurrency — never fire N unbounded provider calls at once. A
//      busy project can hold dozens of active sandboxes; an unbounded `Promise.all`
//      burst-hammers the (org-shared) provider API and trips its rate limiter
//      (`DaytonaRateLimitError` / 429), which then throws and 500s the list,
//      which the browser retries, which fires the burst again — a self-sustaining
//      amplification loop. A small worker pool spreads the calls instead.
//   2. PER-ITEM isolation — one unreachable / throttled / archived sandbox must
//      never reject the whole batch. Each row falls back to its unchanged value.
const TITLE_SYNC_CONCURRENCY = 6;
const DEFAULT_TITLE_SYNC_DEADLINE_MS = 2_500;

function timeout<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

/** Map with a bounded worker pool, preserving input order. Never rejects: a
 *  failing item resolves via the caller's own try/catch to a fallback value. */
async function mapBounded<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

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

async function syncRowFromSandbox(input: {
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
  const currentName = typeof metadata.name === 'string' ? metadata.name : null;
  const rootTitle = snapshots.find((entry) => entry.id === resolvedRootId)?.title ?? null;
  const nextName = rootTitle ?? currentName;
  const pinChanged = input.row.opencodeSessionId !== resolvedRootId;
  const nameChanged = Boolean(nextName) && nextName !== currentName;
  const sessionsChanged = !sameSessions(metadata.opencode_sessions, scopedSessions);
  if (!pinChanged && !nameChanged && !sessionsChanged) return input.row;

  const nextMetadata: Record<string, unknown> = { ...metadata };
  if (nextName) nextMetadata.name = nextName;
  nextMetadata.opencode_sessions = scopedSessions;

  const [updated] = await db
    .update(projectSessions)
    .set({
      opencodeSessionId: resolvedRootId,
      metadata: nextMetadata,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(projectSessions.sessionId, input.row.sessionId),
        eq(projectSessions.projectId, input.row.projectId),
        eq(projectSessions.accountId, input.row.accountId),
      ),
    )
    .returning();

  return updated ?? {
    ...input.row,
    opencodeSessionId: resolvedRootId,
    metadata: nextMetadata,
    updatedAt: new Date(),
  };
}

export async function syncOpenCodeTitlesForSessions(input: {
  rows: ProjectSessionRow[];
  projectId: string;
  accountId: string;
  userId?: string;
  deadlineMs?: number;
}): Promise<ProjectSessionRow[]> {
  if (input.rows.length === 0) return input.rows;
  const sessionIds = input.rows.map((row) => row.sessionId);
  const sandboxRows = await db
    .select({
      sessionId: sessionSandboxes.sessionId,
      externalId: sessionSandboxes.externalId,
    })
    .from(sessionSandboxes)
    .where(
      and(
        eq(sessionSandboxes.projectId, input.projectId),
        eq(sessionSandboxes.accountId, input.accountId),
        inArray(sessionSandboxes.sessionId, sessionIds),
        inArray(sessionSandboxes.status, ['active', 'provisioning']),
      ),
    );

  const externalBySessionId = new Map(
    sandboxRows
      .filter((row): row is { sessionId: string; externalId: string } =>
        Boolean(row.sessionId && row.externalId),
      )
      .map((row) => [row.sessionId, row.externalId]),
  );
  if (externalBySessionId.size === 0) return input.rows;

  const sync = mapBounded(input.rows, TITLE_SYNC_CONCURRENCY, async (row) => {
    const externalId = externalBySessionId.get(row.sessionId);
    if (!externalId) return row;
    try {
      return await syncRowFromSandbox({ row, externalId, userId: input.userId });
    } catch (err) {
      // Best-effort: a single unreachable / throttled / archived sandbox must
      // not 500 the list. Keep the row's current state and move on.
      appLogger.warn('[title-sync] per-sandbox sync failed; keeping row unchanged', {
        sessionId: row.sessionId,
        projectId: input.projectId,
        externalId,
        error: err instanceof Error ? err.message : String(err),
      });
      return row;
    }
  });

  const deadlineMs =
    Number.isFinite(input.deadlineMs) && input.deadlineMs! > 0
      ? input.deadlineMs!
      : DEFAULT_TITLE_SYNC_DEADLINE_MS;
  return Promise.race([
    sync,
    timeout(deadlineMs, input.rows).then((rows) => {
      appLogger.warn('[title-sync] deadline exceeded; returning cached session metadata', {
        projectId: input.projectId,
        rowCount: input.rows.length,
        deadlineMs,
      });
      return rows;
    }),
  ]);
}
