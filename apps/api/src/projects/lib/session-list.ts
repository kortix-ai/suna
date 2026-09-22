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
import { hasAccountSessionOversight } from '../../iam/session-oversight';

import { projectSessions, sessionSandboxes } from '@kortix/db';
import { and, desc, eq, inArray, lt, or } from 'drizzle-orm';
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
  probeManageCapability: () => Promise<boolean>;
  /** Max VISIBLE items to return. Clamped to `SESSION_PAGE_MAX_LIMIT`. */
  limit?: number;
  /** Opaque cursor from a previous page's `nextCursor`. */
  cursor?: string | null;
}): Promise<ProjectSessionInventory> {
  // A cursor is sealed to (project, viewer): it carries the scan position, which
  // can name a row this viewer may not see. See `encodeSessionCursor`.
  const cursorScope: SessionCursorScope = {
    projectId: input.projectId,
    viewerId: input.userId,
  };

  const limit = Math.min(
    Math.max(Math.trunc(input.limit ?? SESSION_PAGE_DEFAULT_LIMIT), 1),
    SESSION_PAGE_MAX_LIMIT,
  );

  // Step 1 — everything that depends only on the CALLER runs together with the
  // first row chunk. Both are needed before a single row can be folded.
  const [subject, canManageProject] = await Promise.all([
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

  // The manager-only scope is refused before any row is read: an unauthorized
  // caller must not cost a page scan.
  // Oversight widens only the manager inventory; see selectSessionRowsForViewer.
  const accountSessionOversight =
    input.scope === 'project' &&
    canManageProject &&
    input.boundCredentialSessionId === null &&
    (await hasAccountSessionOversight(input.userId, input.accountId));

  if (input.scope === 'project' && !canManageProject) {
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
    };
  }

  // The visibility fold drops rows (soft-deleted, warm-unprompted, another
  // member's private session), so a chunk of exactly `limit` rows would
  // under-fill the page. Over-read, then keep pulling chunks until the page is
  // full or the list ends.
  const chunkSize = Math.min(Math.max(limit * 3, 60), 500);

  const items: SessionInventoryItem[] = [];
  const scannedRows: ProjectSessionRow[] = [];
  const grantsBySession = new Map<string, SecretGrant[]>();
  const ownerIdentities = new Map<string, SessionOwnerIdentity>();
  const runtimeStatusBySession = new Map<string, RuntimeStatus>();

  let cursor = decodeSessionCursor(input.cursor, cursorScope);
  let nextCursor: string | null = null;
  let exhausted = false;

  // Bounded so a page can never turn into a full-table walk: a project whose
  // rows are almost all invisible to this viewer returns a short page with a
  // cursor instead of scanning to the end of the list on one request.
  const MAX_CHUNKS = 8;

  for (let pass = 0; pass < MAX_CHUNKS && items.length < limit; pass += 1) {
    const chunk = await db
      .select()
      .from(projectSessions)
      .where(
        and(
          eq(projectSessions.projectId, input.projectId),
          eq(projectSessions.accountId, input.accountId),
          // Keyset: strictly after the cursor row in `(updated_at DESC,
          // session_id DESC)`. Written as the expanded OR rather than a row
          // constructor so the planner keeps using the composite index.
          cursor
            ? or(
                lt(projectSessions.updatedAt, cursor.updatedAt),
                and(
                  eq(projectSessions.updatedAt, cursor.updatedAt),
                  lt(projectSessions.sessionId, cursor.sessionId),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(desc(projectSessions.updatedAt), desc(projectSessions.sessionId))
      .limit(chunkSize);

    if (chunk.length === 0) {
      exhausted = true;
      break;
    }

    const chunkIds = chunk.map((row) => row.sessionId);

    // Step 2 — the three reads that need THIS chunk's rows but not each other.
    // Scoped to the chunk, so their cost is the page's cost and not the
    // project's: the pre-paging version read every sandbox row and resolved
    // every owner in the project on every poll.
    const [runtimeRows, chunkGrants, chunkOwners] = await Promise.all([
      db
        .select({ sessionId: sessionSandboxes.sessionId, status: sessionSandboxes.status })
        .from(sessionSandboxes)
        .where(
          and(
            eq(sessionSandboxes.projectId, input.projectId),
            eq(sessionSandboxes.accountId, input.accountId),
            inArray(sessionSandboxes.sessionId, chunkIds),
          ),
        ),
      loadSessionGrants(
        chunk.filter((row) => row.visibility === 'restricted').map((row) => row.sessionId),
      ),
      resolveSessionOwnerIdentities(
        chunk
          .map((row) => row.createdBy)
          .filter((ownerId): ownerId is string => Boolean(ownerId)),
        input.accountId,
      ),
    ]);

    const chunkRuntime = new Map(runtimeRows.map((row) => [row.sessionId, row.status]));
    for (const [key, value] of chunkRuntime) runtimeStatusBySession.set(key, value);
    for (const [key, value] of chunkGrants) grantsBySession.set(key, value);
    for (const [key, value] of chunkOwners) ownerIdentities.set(key, value);

    const selected = selectSessionRowsForViewer({
      rows: chunk,
      scope: input.scope,
      canManageProject,
      subject,
      grantsBySession: chunkGrants,
      runtimeStatusBySession: chunkRuntime,
      callerSessionId: input.boundCredentialSessionId,
      boundCredentialSessionId: input.boundCredentialSessionId,
      accountSessionOversight,
    });

    for (const item of selected.items) {
      // Stop exactly at the page boundary, and remember the row we stopped on
      // so the next page resumes from it rather than re-serving it.
      if (items.length >= limit) break;
      items.push(item);
      scannedRows.push(item.row);
      nextCursor = cursorForRow(item.row, cursorScope);
    }

    // Did the page fill before we reached the end of this chunk? Then the rows
    // we skipped are NOT served yet: the scan position stays at the last row we
    // emitted and the next page picks them up. Only a chunk we folded to its
    // last row advances the cursor past it — and only then can a short chunk
    // mean the list is over. Marking `exhausted` on a chunk we stopped inside
    // would drop its tail permanently.
    if (items.length < limit) {
      const lastChunkRow = chunk[chunk.length - 1]!;
      nextCursor = cursorForRow(lastChunkRow, cursorScope);
      cursor = { updatedAt: lastChunkRow.updatedAt, sessionId: lastChunkRow.sessionId };
      if (chunk.length < chunkSize) {
        exhausted = true;
        break;
      }
    }
  }

  return {
    authorized: true,
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
