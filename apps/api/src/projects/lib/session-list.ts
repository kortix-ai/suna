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
import { and, desc, eq } from 'drizzle-orm';
import { resolveSessionOwnerIdentities, viewerManagerStanding } from './access';
import type { ProjectRole } from '../access';
import {
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
  /** Every row the project has, pre-fold — for callers that need the raw set. */
  rows: ProjectSessionRow[];
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
}): Promise<ProjectSessionInventory> {
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
