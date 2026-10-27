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
 *  2. The share subject depends only on the caller, so it runs at the same
 *     time as the first sessions read. The manager-standing probe and, in
 *     `scope=project`, the oversight verdict run BEFORE that read: the page
 *     WHERE (`sessionListViewerSql`) needs both (KRTX-2316).
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
import { qualifiedColumn } from '../../shared/sql-qualified-column';
import { hasAccountSessionOversight } from '../../iam/session-oversight';

import { accountGroupMembers, projectSessionGrants, projectSessions, sessionSandboxes } from '@kortix/db';
import { and, desc, eq, getTableColumns, gte, inArray, isNull, lt, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { SessionStartedByFilter } from './session-initiator';
import { hiddenSpaceIds } from '../../shared/space-access';
import { resolveSessionOwnerIdentities, viewerManagerStanding } from './access';
import { SESSION_DELETE_ROWS_DAYS } from '../session-log-purge';
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
import {
  loadSessionUserStates,
  sessionUserStateSql,
  type SessionListView,
  type SessionUserState,
} from './session-user-state';

type ProjectSessionRow = typeof projectSessions.$inferSelect;
type RuntimeStatus = typeof sessionSandboxes.$inferSelect.status;

/** Spawn-chain levels one page reaches up for a missing coordinator. One
 *  bounded read per level; real chains are 1–3 deep. */
const MAX_ANCESTOR_DEPTH = 10;

function spawnedByOf(row: ProjectSessionRow): string | null {
  const parent = row.metadata?.spawned_by_session;
  return typeof parent === 'string' && parent && parent !== row.sessionId ? parent : null;
}

/** `parent`, `started_by`, `q`, `created_by`, `agent`, `updated_after` of
 *  `GET /:projectId/sessions`. All optional; none set = the legacy flat list. */
export interface SessionListFilter {
  /** 'root' = top-level sessions only; a session id = that session's children. */
  parent?: string | null;
  startedBy?: SessionStartedByFilter | null;
  /** Trimmed, 1..200 chars. Case-insensitive substring. */
  q?: string | null;
  /** The session carries every one of these labels (exact match). */
  labels?: string[] | null;
  /** Only sessions filed into this space (`project_channels`). */
  spaceId?: string | null;
  /** Only sessions filed into this group, or (`'none'`) in no group (`session_groups`). */
  group?: string | 'none' | null;
  /** Only sessions this person started: `started_by=me`'s rule for another user id. */
  createdBy?: string | null;
  /** Only sessions that run this agent (its slug). */
  agent?: string | null;
  /** Only sessions with activity (`updated_at`) at or after this time. */
  updatedAfter?: Date | null;
  /** The person whose pins and archive apply (`personUserId`). Null: an
   *  agent, API key or service account, which reads the raw list. */
  personId?: string | null;
  /** Only the person's pinned or archived sessions. Absent: every session the
   *  person has not archived. */
  view?: SessionListView | null;
  /** Recently deleted (KRTX-2853): only the deleted sessions this viewer may
   *  restore, still inside their restore window. Archived ones included. */
  deleted?: boolean;
}

type SessionTable = typeof projectSessions;

function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/** An agent slug or display name with every run of spaces, hyphens and
 *  underscores as one space: "Store Builder", `store-builder` and
 *  `store_builder` are the same key (KRTX-3017). */
function agentSearchKey(value: string): string {
  return value.toLowerCase().replace(/[\s_-]+/g, ' ').trim();
}

/** Title, first prompt, trigger slug / channel (initiator_id), agent, source,
 *  the owner's email or name, or a session-id prefix (the branch is the session id). The
 *  title is what `serializeSession` resolves: custom_name, the auto name, or a
 *  runtime conversation title in the opencode_sessions snapshot. The owner is
 *  already on every row the viewer may see (`owner_email`/`owner_name`). */
function searchMatchSql(t: SessionTable, q: string): SQL {
  const pattern = likePattern(q);
  const agentKey = agentSearchKey(q);
  // The column holds the slug; a display name is the slug with spaces. A query
  // of separators only has no key and must not match every row.
  const agentByName = agentKey
    ? sql`or regexp_replace(lower(${t.agentName}), '[-_[:space:]]+', ' ', 'g') like ${likePattern(agentKey)}`
    : sql``;
  return sql`(
    ${t.metadata}->>'custom_name' ilike ${pattern}
    or ${t.metadata}->>'name' ilike ${pattern}
    or ${t.metadata}->>'first_prompt' ilike ${pattern}
    or ${t.initiatorId} ilike ${pattern}
    or ${t.agentName} ilike ${pattern}
    ${agentByName}
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
  if (filter === 'me') return startedByPersonSql(viewerId);
  return sql`((${t.initiatorType} = 'member' and ${t.initiatorId} is distinct from ${viewerId})
    or (${t.initiatorType} is null and ${t.createdBy}::text is distinct from ${viewerId}))`;
}

/** A session this person started as a member: a trigger run they own is not theirs. */
function startedByPersonSql(userId: string): SQL {
  const t = projectSessions;
  return sql`((${t.initiatorType} = 'member' and ${t.initiatorId} = ${userId})
    or (${t.initiatorType} is null and ${t.createdBy}::text = ${userId}))`;
}

const childSessions = alias(projectSessions, 'child_sessions');

function sessionListFilterSql(filter: SessionListFilter, viewerId: string): SQL | undefined {
  const t = projectSessions;
  const conditions: (SQL | undefined)[] = [];
  if (filter.parent === 'root') conditions.push(isNull(t.parentSessionId));
  else if (filter.parent) conditions.push(eq(t.parentSessionId, filter.parent));
  if (filter.startedBy) conditions.push(startedBySql(filter.startedBy, viewerId));
  if (filter.spaceId) conditions.push(eq(t.spaceId, filter.spaceId));
  if (filter.group === 'none') conditions.push(isNull(t.groupId));
  else if (filter.group) conditions.push(eq(t.groupId, filter.group));
  if (filter.createdBy) conditions.push(startedByPersonSql(filter.createdBy));
  if (filter.agent) conditions.push(eq(t.agentName, filter.agent));
  if (filter.updatedAfter) conditions.push(gte(t.updatedAt, filter.updatedAfter));
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
  // A deleted session is listed whether or not the person archived it.
  if (!filter.deleted) conditions.push(sessionUserStateSql(filter.view ?? null, filter.personId ?? null));
  return conditions.length ? and(...conditions) : undefined;
}

/**
 * A row without the soft-delete stamp. Spelled exactly as the predicate of
 * `idx_project_sessions_project_live` (packages/db kortix.ts): the planner
 * matches a partial index only on the same expression. `is not true` keeps a
 * row whose metadata is null, as `selectSessionRowsForViewer` does.
 */
const liveSessionSql = sql`(${projectSessions.metadata} ? 'deletedAt') is not true`;
/** `metadata.warm === true`: an unprompted warm draft (lib/warm-sessions.ts). */
const warmSessionSql = sql`(${projectSessions.metadata} -> 'warm') = 'true'::jsonb`;
/** `isTriggerCreatedSessionMetadata` (connectors/share.ts). */
const triggerCreatedSql = sql`(jsonb_typeof(${projectSessions.metadata} -> 'source') = 'string'
  and ${projectSessions.metadata} ->> 'source' like 'trigger:%'
  and ${projectSessions.metadata} ->> 'trigger_kind' = 'git'
  and jsonb_typeof(${projectSessions.metadata} -> 'trigger_slug') = 'string'
  and ${projectSessions.metadata} ->> 'trigger_slug' <> '')`;

/** Who reads the list, with the verdicts the page needs before its first row. */
export interface SessionListViewer {
  scope: ProjectSessionListScope;
  viewerId: string;
  boundCredentialSessionId: string | null;
  agentPrincipal: boolean;
  canManageProject: boolean;
  /** `hasAccountSessionOversight`. Applied to the `project` scope only. */
  accountSessionOversight: boolean;
  /** Recently deleted: `SessionListFilter.deleted`. */
  deleted?: boolean;
  /** The private channels the viewer may not see (`hiddenSpaceIds`). REQUIRED: their sessions never list. */
  hiddenSpaceIds: ReadonlySet<string>;
}

/**
 * The oldest `deletedAt` still restorable: the stamp plus the restore window
 * (`sessionRestoreUntil`) is after now. Compared as text, the ISO instant
 * `deleteSession` writes: a stamp that is not one never fails the query.
 */
export function restorableSinceIso(now = Date.now()): string {
  return new Date(now - SESSION_DELETE_ROWS_DAYS * 86_400_000).toISOString();
}

/**
 * The page WHERE for one viewer: the SQL twin of `selectSessionRowsForViewer`
 * (`isProjectSessionVisibleTo`, `agentSessionStanding`, and the scope's
 * tombstone and warm-draft rules). With it, a page of N rows the viewer may
 * see is one read of N + 1 rows, however many newer rows are private to
 * someone else or deleted (KRTX-1727 scenarios A and B). The JS fold still
 * re-checks every row; this only decides what the page reads.
 */
export function sessionListViewerSql(viewer: SessionListViewer): SQL {
  const t = projectSessions;
  const bound = viewer.boundCredentialSessionId;
  const tombstone = viewer.deleted
    ? // Recently deleted: what the restore route would still take back, and
      // only for its owner or a manager (`canManageLifecycle`).
      sql`(${t.metadata} ? 'deletedAt') is true and (${warmSessionSql}) is not true
        and ${t.metadata} ->> 'deletedAt' > ${restorableSinceIso()}
        ${viewer.canManageProject ? sql`` : sql`and ${t.createdBy} = ${viewer.viewerId}`}`
    : viewer.scope === 'visible'
      ? sql`${liveSessionSql} and (${warmSessionSql}) is not true`
      : // A soft-deleted warm draft holds nothing to audit.
        sql`not ((${t.metadata} ? 'deletedAt') is true and (${warmSessionSql}) is true)`;
  // A session-bound credential reaches its own session and the ones it spawned.
  const own = bound === null
    ? undefined
    : sql`(${t.sessionId} = ${bound} or ${t.metadata} ->> 'spawned_by_session' = ${bound})`;
  // ...and no backend session but its own (`isSessionTargetVisibleToCaller`).
  const narrow = bound === null ? undefined : sql`(${t.origin} <> 'backend' or ${t.sessionId} = ${bound})`;
  const granted = sql`exists (
    select 1 from ${projectSessionGrants} as g
     where g.session_id = ${qualifiedColumn(t.sessionId)}
       and ((g.principal_type = 'member' and g.principal_id::text = ${viewer.viewerId})
         or (g.principal_type = 'group' and g.principal_id in (
               select gm.group_id from ${accountGroupMembers} as gm where gm.user_id = ${viewer.viewerId}))))`;
  // `created_by` is compared as a uuid, never cast to text: the cast hides the
  // column's statistics, the planner then expects a handful of matching rows,
  // and it may read and sort every live row of the project for one page.
  const byRules = sql`(${t.createdBy} = ${viewer.viewerId} or ${t.visibility} = 'project'
    or (${t.visibility} = 'restricted' and ${granted}))`;
  // Oversight and the trigger-run manager override are a human's powers only.
  const canAccess =
    bound === null && viewer.scope === 'project' && viewer.accountSessionOversight
      ? undefined
      : and(
          narrow,
          or(
            own,
            bound === null && viewer.canManageProject
              ? sql`(${t.initiatorType} = 'trigger' or ${triggerCreatedSql})`
              : undefined,
            byRules,
          ),
        );
  // A private channel the viewer is not in hides its sessions, whatever their
  // own sharing (`spaceVisible` in `isProjectSessionVisibleTo`). Oversight,
  // the `undefined` above, is the one power that still lists them.
  const hidden = [...viewer.hiddenSpaceIds];
  const spaceVisible = hidden.length === 0 ? undefined : or(isNull(t.spaceId), notInArray(t.spaceId, hidden));
  // The session's own credential included: a hidden channel refuses it too.
  const access = viewer.agentPrincipal
    ? and(spaceVisible, or(own, and(eq(t.visibility, 'project'), canAccess)))
    : canAccess === undefined
      ? undefined
      : and(spaceVisible, canAccess);
  // A non-manager's project scope (`projectReadView`) reads every session of
  // the project. The tombstone detoasts `metadata` (~6 KB a row) and the
  // planner evaluates it first, so a 16k-session project spent ~600 ms there
  // for the 11% of rows the viewer may open. The CASE checks the plain-column
  // access rules first: the same rows, 670 -> 161 ms on prod. The manager
  // inventory and the `visible` scope keep the AND, which the partial index
  // `idx_project_sessions_project_live` and the keyset pages need.
  if (access && viewer.scope === 'project' && !viewer.deleted && !viewer.canManageProject) {
    return sql`(case when ${access} then ${tombstone} else false end)`;
  }
  return and(tombstone, access) as SQL;
}

/** JS twin of `searchMatchSql`, for `search_match: self | child`. `ownerText`
 *  is the owner's resolved email and name. */
export function sessionRowMatchesSearch(row: ProjectSessionRow, q: string, ownerText: string[] = []): boolean {
  const needle = q.toLowerCase();
  const hit = (value: unknown) => typeof value === 'string' && value.toLowerCase().includes(needle);
  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  if (hit(meta.custom_name) || hit(meta.name) || hit(meta.first_prompt) || hit(row.initiatorId) || hit(row.agentName) || hit(meta.source)) return true;
  const agentKey = agentSearchKey(q);
  if (agentKey && typeof row.agentName === 'string' && agentSearchKey(row.agentName).includes(agentKey)) return true;
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
  /** The person's pin and archive per served session (`filter.personId`). */
  userStates: Map<string, SessionUserState>;
}

type SessionInventoryInput = Parameters<typeof loadProjectSessionInventory>[0];

function sessionCursorScope(input: SessionInventoryInput, filter: SessionListFilter): SessionCursorScope {
  return {
    projectId: input.projectId,
    viewerId: input.userId,
    ordering: input.orderByActivity ? 'activity' : undefined,
    // A cursor is a scan position inside ONE filtered list.
    filter:
      filter.parent || filter.startedBy || filter.q || filter.labels?.length || filter.view || filter.deleted || filter.spaceId ||
      filter.group || filter.createdBy || filter.agent || filter.updatedAfter
        ? JSON.stringify([
            filter.parent ?? null,
            filter.startedBy ?? null,
            filter.q ?? null,
            ...(filter.labels?.length ? [[...filter.labels].sort()] : []),
            ...(filter.view ? [{ view: filter.view }] : []),
            ...(filter.deleted ? [{ deleted: true }] : []),
            ...(filter.spaceId ? [{ space: filter.spaceId }] : []),
            ...(filter.group ? [{ group: filter.group }] : []),
            ...(filter.createdBy ? [{ createdBy: filter.createdBy }] : []),
            ...(filter.agent ? [{ agent: filter.agent }] : []),
            ...(filter.updatedAfter ? [{ updatedAfter: filter.updatedAfter.toISOString() }] : []),
          ])
        : undefined,
  };
}

// Step 2 — the three reads that need these rows but not each other, then the
// visibility fold. Scoped to the rows given, so their cost is the page's cost
// and not the project's: the pre-paging version read every sandbox row and
// resolved every owner in the project on every poll.
async function foldSessionRows(
  rows: ProjectSessionRow[],
  ctx: {
    input: SessionInventoryInput;
    canManageProject: boolean;
    subject: ShareSubject;
    accountSessionOversight: boolean;
    grantsBySession: Map<string, SecretGrant[]>;
    ownerIdentities: Map<string, SessionOwnerIdentity>;
    runtimeStatusBySession: Map<string, RuntimeStatus>;
    userStates: Map<string, SessionUserState>;
    hiddenSpaceIds: ReadonlySet<string>;
  },
) {
  const { input, canManageProject, subject, accountSessionOversight, grantsBySession, ownerIdentities, runtimeStatusBySession, userStates } = ctx;
  const rowIds = rows.map((row) => row.sessionId);
  const personId = input.filter?.personId ?? null;
  const [runtimeRows, rowGrants, rowOwners, rowStates] = await Promise.all([
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
    personId ? loadSessionUserStates(rowIds, personId) : new Map<string, SessionUserState>(),
  ]);

  const rowRuntime = new Map(runtimeRows.map((row) => [row.sessionId, row.status]));
  for (const [key, value] of rowStates) userStates.set(key, value);
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
    deleted: input.filter?.deleted === true,
    hiddenSpaceIds: ctx.hiddenSpaceIds,
  });
}

/** Serves the ancestors a page's children point at but the page does not hold. */
async function appendMissingAncestors(input: {
  projectId: string;
  accountId: string;
  filter: SessionListFilter;
  items: SessionInventoryItem[];
  scannedRows: ProjectSessionRow[];
  foldRows: (rows: ProjectSessionRow[]) => ReturnType<typeof foldSessionRows>;
}): Promise<void> {
  const { filter, items, scannedRows, foldRows } = input;
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
  // A pinned, archived, deleted, space or group view promises only those rows.
  const appendAncestors =
    !filter.parent && !filter.labels?.length && !filter.view && !filter.deleted && !filter.spaceId &&
    !filter.group && !filter.createdBy && !filter.agent && !filter.updatedAfter;
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
          // A coordinator the person archived stays out of their list.
          sessionUserStateSql(null, filter.personId ?? null),
        ),
      );
    if (ancestorRows.length === 0) break;
    // The same fold as the page: an ancestor this viewer may not see stays out.
    for (const item of (await foldRows(ancestorRows)).items) {
      items.push(item);
      scannedRows.push(item.row);
    }
  }
}

/** `parent=root` only: non-deleted children per served session. */
async function loadChildCounts(input: {
  projectId: string;
  accountId: string;
  filter: SessionListFilter;
  items: SessionInventoryItem[];
}): Promise<Map<string, number>> {
  const { filter, items } = input;
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
          liveSessionSql,
        ),
      )
      .groupBy(projectSessions.parentSessionId);
    for (const row of counts) if (row.parentSessionId) childCounts.set(row.parentSessionId, row.count);
  }
  return childCounts;
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
  scope: ProjectSessionListScope;
  /** `callerKortixSessionId(c)` — null for a Supabase browser JWT. */
  boundCredentialSessionId: string | null;
  /** The caller is an agent session under the agent-principal model (spec §2). */
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
  const cursorScope = sessionCursorScope(input, filter);
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

  // `updated_at` at microsecond precision for the cursor of the default order. The
  // activity order already sorts on a millisecond-truncated key.
  const SORT_AT_ISO = sql<string>`to_char(${projectSessions.updatedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
  const rowSortIso = (row: ProjectSessionRow): string | undefined =>
    input.orderByActivity ? undefined : (row as { sortAtIso?: string }).sortAtIso;

  const limit = Math.min(
    Math.max(Math.trunc(input.limit ?? SESSION_PAGE_DEFAULT_LIMIT), 1),
    SESSION_PAGE_MAX_LIMIT,
  );

  // The page WHERE keeps only rows this viewer may see (`sessionListViewerSql`),
  // so `limit` rows fill the page. The one extra row says whether the list
  // goes on, so the last page carries no cursor.
  // ponytail: one statement walks every live row of the project the viewer may
  // not see (20,000 rows: 3.5-5 ms measured, KRTX-2316). Add per-viewer
  // indexes (created_by, visibility) if a project outgrows that.
  const chunkSize = limit + 1;

  let cursor = decodeSessionCursor(input.cursor, cursorScope);

  // `async`: calling it starts the read. Awaiting it later only collects it.
  const readChunk = async (after: typeof cursor, viewerSql: SQL) =>
    db
      .select({ ...getTableColumns(projectSessions), sortAtIso: SORT_AT_ISO })
      .from(projectSessions)
      .where(
        and(
          eq(projectSessions.projectId, input.projectId),
          eq(projectSessions.accountId, input.accountId),
          filterSql,
          viewerSql,
          // Keyset: strictly after the cursor row in `(sort_at DESC,
          // session_id DESC)`. Ordinary projects use the updated_at indexes
          // (the `visible` scope the partial one on live rows); opted-in
          // imports use their historical conversation activity.
          after
            ? or(
                lt(sortAt, after.updatedAtIso ?? after.updatedAt.toISOString()),
                and(
                  eq(sortAt, after.updatedAtIso ?? after.updatedAt.toISOString()),
                  lt(projectSessions.sessionId, after.sessionId),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(desc(sortAt), desc(projectSessions.sessionId))
      .limit(chunkSize);

  // Step 1 — the reads that depend only on the CALLER. The share subject runs
  // together with the first row chunk. Manager standing, and in
  // `scope=project` the oversight verdict, run before it: the chunk's WHERE
  // needs both. All of them are needed before a single row can be folded.
  //
  // Manager standing must be derived exactly as the lifecycle routes derive
  // it (loadVisibleSession): a session-bound agent credential never inherits
  // the launching user's `manage` role. Computing it from the role alone made
  // every list row report `can_manage_lifecycle: true` to a credential whose
  // DELETE would then 403 — the two answers must come from one predicate.
  const standingRead = viewerManagerStanding(
    input.boundCredentialSessionId,
    input.probeManageCapability,
  );
  // The manager-only scope is refused before any row is read: an unauthorized
  // caller must not cost a page scan. Its reads start when the verdict allows
  // them, not after the share subject.
  // Oversight widens only the manager inventory; see selectSessionRowsForViewer.
  const managerInventory = input.scope === 'project';
  const oversightRead =
    managerInventory && input.boundCredentialSessionId === null
      ? standingRead.then(
          (allowed) => allowed && hasAccountSessionOversight(input.userId, input.accountId),
        )
      : Promise.resolve(false);
  // The private channels this viewer may not see: the page WHERE and the fold both drop their sessions.
  const hiddenRead = hiddenSpaceIds(input.projectId, input.userId, input.boundCredentialSessionId);
  hiddenRead.catch(() => undefined);
  const viewerSql = (canManageProject: boolean, accountSessionOversight: boolean, hidden: ReadonlySet<string>) =>
    sessionListViewerSql({
      scope: input.scope,
      viewerId: input.userId,
      boundCredentialSessionId: input.boundCredentialSessionId,
      agentPrincipal: input.agentPrincipal === true,
      canManageProject,
      accountSessionOversight,
      deleted: filter.deleted === true,
      hiddenSpaceIds: hidden,
    });
  // The page WHERE needs the manager standing and the oversight verdict, so
  // the first chunk starts once both are in. It does not wait for the share
  // subject: the WHERE reads the viewer's groups itself, and the subject feeds
  // only the fold that re-checks each row.
  const firstChunkRead = Promise.all([standingRead, oversightRead, hiddenRead]).then(([allowed, oversight, hidden]) =>
    managerInventory && !allowed ? [] : readChunk(cursor, viewerSql(allowed, oversight, hidden)),
  );
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
      userStates: new Map(),
    };
  }

  const accountSessionOversight = await oversightRead;
  const hidden = await hiddenRead;
  const pageSql = viewerSql(canManageProject, accountSessionOversight, hidden);

  const items: SessionInventoryItem[] = [];
  const scannedRows: ProjectSessionRow[] = [];
  const grantsBySession = new Map<string, SecretGrant[]>();
  const ownerIdentities = new Map<string, SessionOwnerIdentity>();
  const runtimeStatusBySession = new Map<string, RuntimeStatus>();
  const userStates = new Map<string, SessionUserState>();

  let nextCursor: string | null = null;
  let exhausted = false;

  // The fold re-checks every row the WHERE let through. A row it refuses
  // (the two disagree) leaves the page short, and the next chunk refills it.
  // Bounded so a page can never turn into a full-table walk.
  const MAX_CHUNKS = 8;
  const foldRows = (rows: ProjectSessionRow[]) =>
    foldSessionRows(rows, {
      input,
      canManageProject,
      subject,
      accountSessionOversight,
      grantsBySession,
      ownerIdentities,
      runtimeStatusBySession,
      userStates,
      hiddenSpaceIds: hidden,
    });

  for (let pass = 0; pass < MAX_CHUNKS && items.length < limit; pass += 1) {
    const chunk = await (pass === 0 ? firstChunkRead : readChunk(cursor, pageSql));

    if (chunk.length === 0) {
      exhausted = true;
      break;
    }

    const selected = await foldRows(chunk);

    let pageFull = false;
    for (const item of selected.items) {
      // A manager's inventory lists sessions it may not open, with the title
      // redacted. Search must not match on that hidden title.
      if (filter.q && !item.canAccess) continue;
      // Stop exactly at the page boundary, and remember the row we stopped on
      // so the next page resumes from it rather than re-serving it.
      if (items.length >= limit) {
        pageFull = true;
        break;
      }
      items.push(item);
      scannedRows.push(item.row);
      nextCursor = cursorForRow({ updatedAt: rowSortAt(item.row), updatedAtIso: rowSortIso(item.row), sessionId: item.row.sessionId }, cursorScope);
    }

    // Did the page fill before we reached the end of this chunk? Then the rows
    // we skipped are NOT served yet: the scan position stays at the last row we
    // emitted and the next page picks them up. Only a chunk we folded to its
    // last row advances the cursor past it — and only then can a short chunk
    // mean the list is over. Marking `exhausted` on a chunk we stopped inside
    // would drop its tail permanently.
    if (pageFull) break;
    const lastChunkRow = chunk[chunk.length - 1]!;
    nextCursor = cursorForRow({ updatedAt: rowSortAt(lastChunkRow), updatedAtIso: rowSortIso(lastChunkRow), sessionId: lastChunkRow.sessionId }, cursorScope);
    cursor = { updatedAt: rowSortAt(lastChunkRow), updatedAtIso: rowSortIso(lastChunkRow), sessionId: lastChunkRow.sessionId };
    if (chunk.length < chunkSize) {
      exhausted = true;
      break;
    }
  }

  await appendMissingAncestors({
    projectId: input.projectId,
    accountId: input.accountId,
    filter,
    items,
    scannedRows,
    foldRows,
  });

  const childCounts = await loadChildCounts({ projectId: input.projectId, accountId: input.accountId, filter, items });
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
    userStates,
  };
}
