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
 * milliseconds — Essentia self-host, where the audit write path was saturating
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

import { projectSessions, sessionSandboxes } from '@kortix/db';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { resolveSessionOwnerIdentities, viewerManagerStanding } from './access';
import type { ProjectRole } from '../access';
import {
  selectSessionRowsForViewer,
  type ProjectSessionListScope,
  type SessionInventoryItem,
  type SessionOwnerIdentity,
} from './session-inventory';
import { collectSessionPage, type SessionCursor } from './session-page';

type ProjectSessionRow = typeof projectSessions.$inferSelect;
type RuntimeStatus = typeof sessionSandboxes.$inferSelect.status;

export interface ProjectSessionInventory {
  /** False when `scope: 'project'` was asked for without manager standing. */
  authorized: boolean;
  /** The rows the viewer may see, already folded for visibility. */
  items: SessionInventoryItem[];
  /** Every row the project has, pre-fold — for callers that need the raw set. */
  rows: ProjectSessionRow[];
  canManageProject: boolean;
  grantsBySession: Map<string, SecretGrant[]>;
  ownerIdentities: Map<string, SessionOwnerIdentity>;
  runtimeStatusBySession: Map<string, RuntimeStatus>;
  subject: ShareSubject;
}

interface ProjectSessionInventoryInput {
  projectId: string;
  accountId: string;
  userId: string;
  effectiveRole: ProjectRole;
  scope: ProjectSessionListScope;
  /** `callerKortixSessionId(c)` — null for a Supabase browser JWT. */
  boundCredentialSessionId: string | null;
  probeManageCapability: () => Promise<boolean>;
}

/**
 * Read one project's session inventory for one viewer.
 *
 * `probeManageCapability` is injected rather than imported so this module stays
 * free of the request context (and unit-testable without one) — the route
 * passes the same `project.members.manage` probe the lifecycle routes use.
 */
export async function loadProjectSessionInventory(
  input: ProjectSessionInventoryInput,
): Promise<ProjectSessionInventory> {
  // Step 1 — everything that does not depend on the session rows runs together
  // with the session read itself.
  const [rows, runtimeRows, subject, canManageProject] = await Promise.all([
    db
      .select()
      .from(projectSessions)
      .where(
        and(
          eq(projectSessions.projectId, input.projectId),
          eq(projectSessions.accountId, input.accountId),
        ),
      )
      .orderBy(desc(projectSessions.updatedAt)),
    db
      .select({ sessionId: sessionSandboxes.sessionId, status: sessionSandboxes.status })
      .from(sessionSandboxes)
      .where(
        and(
          eq(sessionSandboxes.projectId, input.projectId),
          eq(sessionSandboxes.accountId, input.accountId),
        ),
      ),
    resolveShareSubject(input.userId),
    // Manager standing must be derived exactly as the lifecycle routes derive
    // it (loadVisibleSession): a session-bound agent credential never inherits
    // the launching user's `manage` role. Computing it from the role alone made
    // every list row report `can_manage_lifecycle: true` to a credential whose
    // DELETE would then 403 — the two answers must come from one predicate.
    viewerManagerStanding(
      input.effectiveRole,
      input.boundCredentialSessionId,
      input.probeManageCapability,
    ),
  ]);

  const runtimeStatusBySession = new Map(
    runtimeRows.map((row) => [row.sessionId, row.status]),
  );

  // Step 2 — the two reads that need the row set, but not each other. Owner
  // identities are resolved over ALL rows (a superset of the selected ones):
  // the result is a Map consumed by lookup, so the extra ids cost one wider
  // `IN (…)` instead of a second serial round trip after the fold.
  const [grantsBySession, ownerIdentities] = await Promise.all([
    loadSessionGrants(
      rows.filter((row) => row.visibility === 'restricted').map((row) => row.sessionId),
    ),
    resolveSessionOwnerIdentities(
      rows
        .map((row) => row.createdBy)
        .filter((ownerId): ownerId is string => Boolean(ownerId)),
      input.accountId,
    ),
  ]);

  const selected = selectSessionRowsForViewer({
    rows,
    scope: input.scope,
    canManageProject,
    subject,
    grantsBySession,
    runtimeStatusBySession,
    callerSessionId: input.boundCredentialSessionId,
    boundCredentialSessionId: input.boundCredentialSessionId,
  });

  return {
    authorized: selected.authorized,
    items: selected.items,
    rows,
    canManageProject,
    grantsBySession,
    ownerIdentities,
    runtimeStatusBySession,
    subject,
  };
}

export interface ProjectSessionInventoryPage {
  /** False when `scope: 'project'` was asked for without manager standing. */
  authorized: boolean;
  /** One page of rows the viewer may see, newest last activity first (then `session_id DESC`). */
  items: SessionInventoryItem[];
  /** Where the next page starts, or null when this page is the last. */
  nextCursor: SessionCursor | null;
  canManageProject: boolean;
  grantsBySession: Map<string, SecretGrant[]>;
  ownerIdentities: Map<string, SessionOwnerIdentity>;
}

/**
 * One page of the inventory `loadProjectSessionInventory` returns whole.
 *
 * Same tenant predicates, same visibility fold, same manager-standing
 * derivation — applied per batch instead of over every row the project has.
 * The per-row reads (runtime status, grants, owner identities) are scoped to
 * the batch, so a page costs the same on a project with 60 sessions as on one
 * with 16,000. Batching and the scan budget live in `session-page.ts`.
 */
export async function loadProjectSessionInventoryPage(
  input: ProjectSessionInventoryInput & { limit: number; after: SessionCursor | null },
): Promise<ProjectSessionInventoryPage> {
  const [subject, canManageProject] = await Promise.all([
    resolveShareSubject(input.userId),
    viewerManagerStanding(
      input.effectiveRole,
      input.boundCredentialSessionId,
      input.probeManageCapability,
    ),
  ]);

  const grantsBySession = new Map<string, SecretGrant[]>();
  const ownerIdentities = new Map<string, SessionOwnerIdentity>();
  if (input.scope === 'project' && !canManageProject) {
    return {
      authorized: false,
      items: [],
      nextCursor: null,
      canManageProject,
      grantsBySession,
      ownerIdentities,
    };
  }

  // The page order is the order every client DISPLAYS: last activity, the
  // same key as `sessionLastActivityAt` in apps/web (project-session-list-helpers.ts):
  //   1. the newer of `metadata.last_activity_at` (the prompt stamp) and the
  //      newest `metadata.opencode_sessions[].updated_at` (epoch ms);
  //   2. `updated_at` when neither exists.
  // NOT `updated_at` alone: bookkeeping writers (branch GC, stop/resume, title
  // sync) advance it with no activity, and a keyset on it delivered a year-old
  // GC'd session on page 1 while thousands of newer ones sat on unloaded pages.
  const activityAt = sql`COALESCE(
    GREATEST(
      CASE WHEN ${projectSessions.metadata}->>'last_activity_at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}'
           THEN (${projectSessions.metadata}->>'last_activity_at')::timestamptz END,
      (SELECT max(to_timestamp((oc->>'updated_at')::double precision / 1000))
         FROM jsonb_array_elements(
           CASE WHEN jsonb_typeof(${projectSessions.metadata}->'opencode_sessions') = 'array'
                THEN ${projectSessions.metadata}->'opencode_sessions' ELSE '[]'::jsonb END
         ) AS oc
        WHERE jsonb_typeof(oc->'updated_at') = 'number')
    ),
    ${projectSessions.updatedAt}
  )`;
  // The exact instant as text. A JS `Date` drops the microseconds, and the
  // keyset below would skip rows in the cursor's millisecond — see
  // session-page.ts.
  const cursorAt = sql<string>`to_char(${activityAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

  const page = await collectSessionPage({
    limit: input.limit,
    after: input.after,
    readBatch: async (after, size) => {
      const batch = await db
        .select({ row: projectSessions, cursorAt })
        .from(projectSessions)
        .where(
          and(
            eq(projectSessions.projectId, input.projectId),
            eq(projectSessions.accountId, input.accountId),
            after
              ? sql`(${activityAt}, ${projectSessions.sessionId}) < (${after.updatedAt}::timestamptz, ${after.sessionId})`
              : undefined,
          ),
        )
        .orderBy(sql`${activityAt} DESC`, desc(projectSessions.sessionId))
        .limit(size);
      return batch.map((entry) => ({
        row: entry.row,
        cursor: { updatedAt: entry.cursorAt, sessionId: entry.row.sessionId },
      }));
    },
    selectVisible: async (rows) => {
      if (rows.length === 0) return [];
      const [runtimeRows, batchGrants, batchOwners] = await Promise.all([
        db
          .select({ sessionId: sessionSandboxes.sessionId, status: sessionSandboxes.status })
          .from(sessionSandboxes)
          .where(
            and(
              eq(sessionSandboxes.projectId, input.projectId),
              eq(sessionSandboxes.accountId, input.accountId),
              inArray(
                sessionSandboxes.sessionId,
                rows.map((row) => row.sessionId),
              ),
            ),
          ),
        loadSessionGrants(
          rows.filter((row) => row.visibility === 'restricted').map((row) => row.sessionId),
        ),
        resolveSessionOwnerIdentities(
          rows
            .map((row) => row.createdBy)
            .filter((ownerId): ownerId is string => Boolean(ownerId)),
          input.accountId,
        ),
      ]);
      for (const [sessionId, grants] of batchGrants) grantsBySession.set(sessionId, grants);
      for (const [ownerId, identity] of batchOwners) ownerIdentities.set(ownerId, identity);

      return selectSessionRowsForViewer({
        rows,
        scope: input.scope,
        canManageProject,
        subject,
        grantsBySession: batchGrants,
        runtimeStatusBySession: new Map(runtimeRows.map((row) => [row.sessionId, row.status])),
        callerSessionId: input.boundCredentialSessionId,
        boundCredentialSessionId: input.boundCredentialSessionId,
      }).items;
    },
    rowOf: (item) => item.row,
  });

  return {
    authorized: true,
    items: page.items,
    nextCursor: page.nextCursor,
    canManageProject,
    grantsBySession,
    ownerIdentities,
  };
}
