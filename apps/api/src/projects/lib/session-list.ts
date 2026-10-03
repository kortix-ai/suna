/**
 * The session-inventory READ, extracted from `GET /:projectId/sessions` so any
 * other route (an open-path batch bundle, a channel surface, a share view) can
 * reuse the exact same query set and the exact same visibility fold instead of
 * re-deriving either.
 *
 * ─── Why it is shaped like this (perf, 2026-08-26) ──────────────────────────
 * The route used to run its seven reads strictly in series: sessions →
 * sandboxes → share subject → manager standing → grants → owner identities.
 * Every one of those is a separate database round trip, so the endpoint's
 * floor was 6 × RTT even though no single statement is slow (the sessions
 * SELECT is index-served by `idx_project_sessions_tenant_identity` and runs in
 * 0.15 ms at 60 rows). On a contended deployment where an RTT is tens of
 * milliseconds — SampleCo self-host, where the audit write path was saturating
 * the pool — that serialization is the whole cost.
 *
 * Three observations collapse the chain to three serial steps:
 *
 *  1. The runtime-status lookup does NOT depend on the session rows. It was
 *     filtered by `inArray(sessionId, rows)` on top of an (accountId,
 *     projectId) predicate that already scopes it to exactly this project's
 *     sessions, and the result is only ever consumed through a per-session Map
 *     lookup. Dropping the redundant `inArray` lets it run CONCURRENTLY with
 *     the sessions read; a row for a session that is not in the list is simply
 *     never looked up.
 *  2. The share subject and the manager-standing probe depend only on the
 *     caller, so they can start at the same time as the sessions read.
 *  3. Owner identities can be resolved for the SUPERSET of `created_by` over
 *     all rows rather than only the selected ones — again a Map consumed by
 *     lookup — so it runs concurrently with the grants read instead of after
 *     the visibility fold.
 */

import {
  loadSessionGrants,
  resolveShareSubject,
  type SecretGrant,
  type ShareSubject,
} from '../../connectors/share';
import { db } from '../../shared/db';
import { hasAccountSessionOversight } from '../../iam/session-oversight';

import { projectSessions, sessionSandboxes } from '@kortix/db';
import { and, desc, eq, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { SessionStartedByFilter } from './session-initiator';
import { resolveSessionOwnerIdentities, viewerManagerStanding } from './access';
import type { ProjectRole } from '../access';
import {
  SESSION_PAGE_DEFAULT_LIMIT,
  SESSION_PAGE_MAX_LIMIT,
  cursorForRow,
  decodeSessionCursor,
  type SessionCursorScope,
  selectSessionRowsForViewer,
  type ProjectSessionListScope,
  type SessionInventoryItem,
  type SessionOwnerIdentity,
} from './session-inventory';

type ProjectSessionRow = typeof projectSessions.$inferSelect;
type RuntimeStatus = typeof sessionSandboxes.$inferSelect.status;

/** Spawn-chain levels one page reaches up for a missing coordinator. One
 *  bounded read per level; real chains are 1–3 deep. */
const MAX_ANCESTOR_DEPTH = 10;

function spawnedByOf(row: ProjectSessionRow): string | null {
  const parent = row.metadata?.spawned_by_session;
  return typeof parent === 'string' && parent && parent !== row.sessionId ? parent : null;
}

/** `parent`, `started_by`, `q` of `GET /:projectId/sessions`. All optional;
 *  none set = the legacy flat list. */
export interface SessionListFilter {
  /** 'root' = top-level sessions only; a session id = that session's children. */
  parent?: string | null;
  startedBy?: SessionStartedByFilter | null;
  /** Trimmed, 1..200 chars. Case-insensitive substring. */
  q?: string | null;
  /** The session carries every one of these labels (exact match). */
  labels?: string[] | null;
}

type SessionTable = typeof projectSessions;

function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/** Title, trigger slug / channel (initiator_id), agent, source, the owner's
 *  email or name, or a session-id prefix (the branch is the session id). The
 *  title is what `serializeSession` resolves: custom_name, the auto name, or a
 *  runtime conversation title in the opencode_sessions snapshot. The owner is
 *  already on every row the viewer may see (`owner_email`/`owner_name`). */
function searchMatchSql(t: SessionTable, q: string): SQL {
  const pattern = likePattern(q);
  return sql`(
    ${t.metadata}->>'custom_name' ilike ${pattern}
    or ${t.metadata}->>'name' ilike ${pattern}
    or ${t.initiatorId} ilike ${pattern}
    or ${t.agentName} ilike ${pattern}
    or ${t.metadata}->>'source' ilike ${pattern}
    or exists (
      select 1 from auth.users as owner_users
       where owner_users.id = ${t.createdBy}
         and (owner_users.email ilike ${pattern}
              or owner_users.raw_user_meta_data->>'full_name' ilike ${pattern}
              or owner_users.raw_user_meta_data->>'name' ilike ${pattern})
    )
    or ${t.sessionId} ilike ${`${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`}
    or exists (select 1 from jsonb_array_elements_text(${t.labels}) as l(label) where l.label ilike ${pattern})
    or exists (
      select 1 from jsonb_array_elements(
        case when jsonb_typeof(${t.metadata}->'opencode_sessions') = 'array'
             then ${t.metadata}->'opencode_sessions' else '[]'::jsonb end
      ) as oc(entry)
      where oc.entry->>'title' ilike ${pattern}
    )
  )`;
}

/** A row the backfill did not classify (initiator_type null) counts as its
 *  owner's member session. */
function startedBySql(filter: SessionStartedByFilter, viewerId: string): SQL {
  const t = projectSessions;
  if (filter === 'automated') return sql`(${t.initiatorType} is not null and ${t.initiatorType} <> 'member')`;
  if (filter === 'me') {
    return sql`((${t.initiatorType} = 'member' and ${t.initiatorId} = ${viewerId})
      or (${t.initiatorType} is null and ${t.createdBy}::text = ${viewerId}))`;
  }
  return sql`((${t.initiatorType} = 'member' and ${t.initiatorId} is distinct from ${viewerId})
    or (${t.initiatorType} is null and ${t.createdBy}::text is distinct from ${viewerId}))`;
}

const childSessions = alias(projectSessions, 'child_sessions');

function sessionListFilterSql(filter: SessionListFilter, viewerId: string): SQL | undefined {
  const t = projectSessions;
  const conditions: (SQL | undefined)[] = [];
  if (filter.parent === 'root') conditions.push(isNull(t.parentSessionId));
  else if (filter.parent) conditions.push(eq(t.parentSessionId, filter.parent));
  if (filter.startedBy) conditions.push(startedBySql(filter.startedBy, viewerId));
  if (filter.labels?.length) {
    const has = (table: SessionTable) => sql`${table.labels} @> ${JSON.stringify(filter.labels)}::jsonb`;
    conditions.push(
      filter.parent === 'root'
        ? sql`(${has(t)} or exists (
            select 1 from ${projectSessions} as child_sessions
             where ${childSessions.parentSessionId} = ${t.sessionId}
               and ${childSessions.projectId} = ${t.projectId}
               and ${has(childSessions as unknown as SessionTable)}
          ))`
        : has(t),
    );
  }
  if (filter.q) {
    conditions.push(
      filter.parent === 'root'
        ? sql`(${searchMatchSql(t, filter.q)} or exists (
            select 1 from ${projectSessions} as child_sessions
             where ${childSessions.parentSessionId} = ${t.sessionId}
               and ${childSessions.projectId} = ${t.projectId}
               and ${searchMatchSql(childSessions as unknown as SessionTable, filter.q)}
          ))`
        : searchMatchSql(t, filter.q),
    );
  }
  return conditions.length ? and(...conditions) : undefined;
}

/** JS twin of `searchMatchSql`, for `search_match: self | child`. `ownerText`
 *  is the owner's resolved email and name. */
export function sessionRowMatchesSearch(row: ProjectSessionRow, q: string, ownerText: string[] = []): boolean {
  const needle = q.toLowerCase();
  const hit = (value: unknown) => typeof value === 'string' && value.toLowerCase().includes(needle);
  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  if (hit(meta.custom_name) || hit(meta.name) || hit(row.initiatorId) || hit(row.agentName) || hit(meta.source)) return true;
  if (ownerText.some(hit)) return true;
  if (row.sessionId.toLowerCase().startsWith(needle)) return true;
  if ((row.labels ?? []).some(hit)) return true;
  const snapshot = Array.isArray(meta.opencode_sessions) ? meta.opencode_sessions : [];
  return snapshot.some((entry) => hit((entry as Record<string, unknown> | null)?.title));
}

export interface ProjectSessionInventory {
  /** False when `scope: 'project'` was asked for without manager standing. */
  authorized: boolean;
  /** The rows the viewer may see, already folded for visibility. */
  items: SessionInventoryItem[];
  /**
   * The rows this page SCANNED, pre-fold, in list order. Not "every row the
   * project has" any more — the read is a bounded keyset page (see
   * `session-inventory.ts`), so a project with more sessions than the page
   * holds never loads them all. A caller that needs the whole set pages.
   */
  rows: ProjectSessionRow[];
  /** Feed back as `cursor` for the next page, or null at the end of the list. */
  nextCursor: string | null;
  canManageProject: boolean;
  grantsBySession: Map<string, SecretGrant[]>;
  ownerIdentities: Map<string, SessionOwnerIdentity>;
  runtimeStatusBySession: Map<string, RuntimeStatus>;
  subject: ShareSubject;
  /** `parent=root` only: non-deleted children per served session. */
  childCounts: Map<string, number>;
  /** Display names of member/service-account initiators on this page. */
  initiatorNames: Map<string, string>;
}

/**
 * Read one project's session inventory for one viewer.
 *
 * `probeManageCapability` is injected rather than imported so this module stays
 * free of the request context (and unit-testable without one) — the route
 * passes the same `project.members.manage` probe the lifecycle routes use.
 */
export async function loadProjectSessionInventory(input: {
  projectId: string;
  accountId: string;
  userId: string;
  effectiveRole: ProjectRole;
  scope: ProjectSessionListScope;
  /** `callerKortixSessionId(c)` — null for a Supabase browser JWT. */
  boundCredentialSessionId: string | null;
  /** The caller is an agent session under the `agent_principal` model (spec §2). */
  agentPrincipal?: boolean;
  probeManageCapability: () => Promise<boolean>;
  /** Max VISIBLE items to return. Clamped to `SESSION_PAGE_MAX_LIMIT`. */
  limit?: number;
  /** Opaque cursor from a previous page's `nextCursor`. */
  cursor?: string | null;
  /** Use conversation activity for projects whose imported sessions retain historical dates. */
  orderByActivity?: boolean;
  filter?: SessionListFilter;
}): Promise<ProjectSessionInventory> {
  const filter = input.filter ?? {};
  const filterSql = sessionListFilterSql(filter, input.userId);
  // A cursor is sealed to (project, viewer): it carries the scan position, which
  // can name a row this viewer may not see. See `encodeSessionCursor`.
  const cursorScope: SessionCursorScope = {
    projectId: input.projectId,
    viewerId: input.userId,
    ordering: input.orderByActivity ? 'activity' : undefined,
    // A cursor is a scan position inside ONE filtered list.
    filter:
      filter.parent || filter.startedBy || filter.q || filter.labels?.length
        ? JSON.stringify([
            filter.parent ?? null,
            filter.startedBy ?? null,
            filter.q ?? null,
            ...(filter.labels?.length ? [[...filter.labels].sort()] : []),
          ])
        : undefined,
  };
  const sortAt = input.orderByActivity
    ? sql<Date>`date_trunc('milliseconds', coalesce((${projectSessions.metadata}->>'last_activity_at')::timestamptz, ${projectSessions.updatedAt}))`
    : sql<Date>`${projectSessions.updatedAt}`;
  const rowSortAt = (row: ProjectSessionRow): Date => {
    if (!input.orderByActivity) return row.updatedAt;
    const raw = row.metadata?.last_activity_at;
    if (typeof raw !== 'string') return row.updatedAt;
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? row.updatedAt : parsed;
  };

  const limit = Math.min(
    Math.max(Math.trunc(input.limit ?? SESSION_PAGE_DEFAULT_LIMIT), 1),
    SESSION_PAGE_MAX_LIMIT,
  );

  // The visibility fold drops rows (soft-deleted, warm-unprompted, another
  // member's private session), so a chunk of exactly `limit` rows would
  // under-fill the page. Over-read, then keep pulling chunks until the page is
  // full or the list ends.
  const chunkSize = Math.min(Math.max(limit * 3, 60), 500);

  let cursor = decodeSessionCursor(input.cursor, cursorScope);

  // `async`: calling it starts the read. Awaiting it later only collects it.
  const readChunk = async (after: typeof cursor) =>
    db
      .select()
      .from(projectSessions)
      .where(
        and(
          eq(projectSessions.projectId, input.projectId),
          eq(projectSessions.accountId, input.accountId),
          filterSql,
          // Keyset: strictly after the cursor row in `(sort_at DESC,
          // session_id DESC)`. Ordinary projects use the updated_at index;
          // opted-in imports use their historical conversation activity.
          after
            ? or(
                lt(sortAt, after.updatedAt.toISOString()),
                and(
                  eq(sortAt, after.updatedAt.toISOString()),
                  lt(projectSessions.sessionId, after.sessionId),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(desc(sortAt), desc(projectSessions.sessionId))
      .limit(chunkSize);

  // Step 1 — everything that depends only on the CALLER runs together with the
  // first row chunk. Both are needed before a single row can be folded.
  //
  // Manager standing must be derived exactly as the lifecycle routes derive
  // it (loadVisibleSession): a session-bound agent credential never inherits
  // the launching user's `manage` role. Computing it from the role alone made
  // every list row report `can_manage_lifecycle: true` to a credential whose
  // DELETE would then 403 — the two answers must come from one predicate.
  const standingRead = viewerManagerStanding(
    input.effectiveRole,
    input.boundCredentialSessionId,
    input.probeManageCapability,
  );
  // The manager-only scope is refused before any row is read: an unauthorized
  // caller must not cost a page scan. Its reads start when the verdict allows
  // them, not after the share subject.
  // Oversight widens only the manager inventory; see selectSessionRowsForViewer.
  const managerInventory = input.scope === 'project';
  const firstChunkRead = managerInventory
    ? standingRead.then((allowed) => (allowed ? readChunk(cursor) : []))
    : readChunk(cursor);
  const oversightRead =
    managerInventory && input.boundCredentialSessionId === null
      ? standingRead.then(
          (allowed) => allowed && hasAccountSessionOversight(input.userId, input.accountId),
        )
      : Promise.resolve(false);
  // Both are awaited after the caller reads. A rejection surfaces there, in
  // the original order, and must not be unhandled before.
  firstChunkRead.catch(() => undefined);
  oversightRead.catch(() => undefined);
  const [subject, canManageProject] = await Promise.all([
    resolveShareSubject(input.userId),
    standingRead,
  ]);

  if (managerInventory && !canManageProject) {
    return {
      authorized: false,
      items: [],
      rows: [],
      nextCursor: null,
      canManageProject,
      grantsBySession: new Map(),
      ownerIdentities: new Map(),
      runtimeStatusBySession: new Map(),
      subject,
      childCounts: new Map(),
      initiatorNames: new Map(),
    };
  }

  const accountSessionOversight = await oversightRead;

  const items: SessionInventoryItem[] = [];
  const scannedRows: ProjectSessionRow[] = [];
  const grantsBySession = new Map<string, SecretGrant[]>();
  const ownerIdentities = new Map<string, SessionOwnerIdentity>();
  const runtimeStatusBySession = new Map<string, RuntimeStatus>();

  let nextCursor: string | null = null;
  let exhausted = false;

  // Bounded so a page can never turn into a full-table walk: a project whose
  // rows are almost all invisible to this viewer returns a short page with a
  // cursor instead of scanning to the end of the list on one request.
  const MAX_CHUNKS = 8;

  // Step 2 — the three reads that need these rows but not each other, then the
  // visibility fold. Scoped to the rows given, so their cost is the page's cost
  // and not the project's: the pre-paging version read every sandbox row and
  // resolved every owner in the project on every poll.
  const foldRows = async (rows: ProjectSessionRow[]) => {
    const rowIds = rows.map((row) => row.sessionId);
    const [runtimeRows, rowGrants, rowOwners] = await Promise.all([
      db
        .select({ sessionId: sessionSandboxes.sessionId, status: sessionSandboxes.status })
        .from(sessionSandboxes)
        .where(
          and(
            eq(sessionSandboxes.projectId, input.projectId),
            eq(sessionSandboxes.accountId, input.accountId),
            inArray(sessionSandboxes.sessionId, rowIds),
          ),
        ),
      loadSessionGrants(
        rows.filter((row) => row.visibility === 'restricted').map((row) => row.sessionId),
      ),
      resolveSessionOwnerIdentities(
        [
          ...new Set(
            rows
              .flatMap((row) => [
                row.createdBy,
                row.initiatorType === 'member' || row.initiatorType === 'api' ? row.initiatorId : null,
              ])
              .filter((ownerId): ownerId is string => Boolean(ownerId)),
          ),
        ],
        input.accountId,
      ),
    ]);

    const rowRuntime = new Map(runtimeRows.map((row) => [row.sessionId, row.status]));
    for (const [key, value] of rowRuntime) runtimeStatusBySession.set(key, value);
    for (const [key, value] of rowGrants) grantsBySession.set(key, value);
    for (const [key, value] of rowOwners) ownerIdentities.set(key, value);

    return selectSessionRowsForViewer({
      rows,
      scope: input.scope,
      canManageProject,
      subject,
      grantsBySession: rowGrants,
      runtimeStatusBySession: rowRuntime,
      callerSessionId: input.boundCredentialSessionId,
      boundCredentialSessionId: input.boundCredentialSessionId,
      accountSessionOversight,
      agentPrincipal: input.agentPrincipal === true,
    });
  };

  for (let pass = 0; pass < MAX_CHUNKS && items.length < limit; pass += 1) {
    const chunk = await (pass === 0 ? firstChunkRead : readChunk(cursor));

    if (chunk.length === 0) {
      exhausted = true;
      break;
    }

    const selected = await foldRows(chunk);

    for (const item of selected.items) {
      // A manager's inventory lists sessions it may not open, with the title
      // redacted. Search must not match on that hidden title.
      if (filter.q && !item.canAccess) continue;
      // Stop exactly at the page boundary, and remember the row we stopped on
      // so the next page resumes from it rather than re-serving it.
      if (items.length >= limit) break;
      items.push(item);
      scannedRows.push(item.row);
      nextCursor = cursorForRow({ updatedAt: rowSortAt(item.row), sessionId: item.row.sessionId }, cursorScope);
    }

    // Did the page fill before we reached the end of this chunk? Then the rows
    // we skipped are NOT served yet: the scan position stays at the last row we
    // emitted and the next page picks them up. Only a chunk we folded to its
    // last row advances the cursor past it — and only then can a short chunk
    // mean the list is over. Marking `exhausted` on a chunk we stopped inside
    // would drop its tail permanently.
    if (items.length < limit) {
      const lastChunkRow = chunk[chunk.length - 1]!;
      nextCursor = cursorForRow({ updatedAt: rowSortAt(lastChunkRow), sessionId: lastChunkRow.sessionId }, cursorScope);
      cursor = { updatedAt: rowSortAt(lastChunkRow), sessionId: lastChunkRow.sessionId };
      if (chunk.length < chunkSize) {
        exhausted = true;
        break;
      }
    }
  }

  // A coordinator sorts by its OWN `updated_at`, and a child's turns never
  // touch it. So a coordinator that went quiet while its sub-agents kept
  // working lands on a later page than they do, and every child on this page
  // renders as a stray top-level row. Serve the missing ancestors with the
  // page. They ride outside the keyset (the cursor does not move), so a later
  // page can serve one again; clients de-duplicate by `session_id`.
  const served = new Set(items.map((item) => item.row.sessionId));
  // A `parent`-filtered read is already a tree level: roots have no parent to
  // append, and children are read under the parent the client expanded. A
  // label filter promises only rows carrying every label, so it gets no
  // unlabeled ancestors either.
  const appendAncestors = !filter.parent && !filter.labels?.length;
  for (let depth = 0; appendAncestors && depth < MAX_ANCESTOR_DEPTH; depth += 1) {
    const missing = [
      ...new Set(
        items
          .map((item) => spawnedByOf(item.row))
          .filter((id): id is string => id !== null && !served.has(id)),
      ),
    ];
    if (missing.length === 0) break;
    for (const id of missing) served.add(id);
    const ancestorRows = await db
      .select()
      .from(projectSessions)
      .where(
        and(
          eq(projectSessions.projectId, input.projectId),
          eq(projectSessions.accountId, input.accountId),
          inArray(projectSessions.sessionId, missing),
        ),
      );
    if (ancestorRows.length === 0) break;
    // The same fold as the page: an ancestor this viewer may not see stays out.
    for (const item of (await foldRows(ancestorRows)).items) {
      items.push(item);
      scannedRows.push(item.row);
    }
  }

  const childCounts = new Map<string, number>();
  if (filter.parent === 'root' && items.length > 0) {
    const counts = await db
      .select({ parentSessionId: projectSessions.parentSessionId, count: sql<number>`count(*)::int` })
      .from(projectSessions)
      .where(
        and(
          eq(projectSessions.projectId, input.projectId),
          eq(projectSessions.accountId, input.accountId),
          inArray(projectSessions.parentSessionId, items.map((item) => item.row.sessionId)),
          // The soft-delete marker the visibility fold drops (session-inventory.ts).
          sql`not (${projectSessions.metadata} ? 'deletedAt')`,
        ),
      )
      .groupBy(projectSessions.parentSessionId);
    for (const row of counts) if (row.parentSessionId) childCounts.set(row.parentSessionId, row.count);
  }
  const initiatorNames = new Map<string, string>();
  for (const [id, identity] of ownerIdentities) {
    const name = identity.name ?? identity.email ?? null;
    if (name) initiatorNames.set(id, name);
  }

  return {
    authorized: true,
    childCounts,
    initiatorNames,
    items,
    rows: scannedRows,
    // A page that reached the end of the list has no next cursor; one that
    // stopped early (full page, or the chunk budget) does, even if the next
    // page turns out to be empty.
    nextCursor: exhausted ? null : nextCursor,
    canManageProject,
    grantsBySession,
    ownerIdentities,
    runtimeStatusBySession,
    subject,
  };
}
