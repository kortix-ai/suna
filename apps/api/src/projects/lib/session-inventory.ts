import {
  isSessionVisibleTo,
  type SecretGrant,
  type ShareSubject,
} from '../../connectors/share';
import type { projectSessions, sessionSandboxes } from '@kortix/db';

type ProjectSessionRow = typeof projectSessions.$inferSelect;
type RuntimeStatus = typeof sessionSandboxes.$inferSelect.status;

export type ProjectSessionListScope = 'visible' | 'project';

export interface SessionInventoryItem {
  row: ProjectSessionRow;
  canAccess: boolean;
  runtimeStatus: RuntimeStatus | null;
  deletedAt: string | null;
  deletedBy: string | null;
}

export interface SessionOwnerIdentity {
  type: 'user' | 'service_account' | 'unknown';
  name: string | null;
  email: string | null;
}

export function mergeSessionOwnerIdentities(input: {
  ownerIds: string[];
  users: Map<
    string,
    { exists: boolean; email: string | null; displayName?: string | null }
  >;
  serviceAccounts: Array<{
    serviceAccountId: string;
    name: string;
    agentName: string | null;
  }>;
}): Map<string, SessionOwnerIdentity> {
  const serviceAccounts = new Map(
    input.serviceAccounts.map((identity) => [
      identity.serviceAccountId,
      identity,
    ]),
  );
  const result = new Map<string, SessionOwnerIdentity>();

  for (const ownerId of input.ownerIds) {
    const user = input.users.get(ownerId);
    if (user?.exists) {
      result.set(ownerId, {
        type: 'user',
        name: user.displayName || user.email,
        email: user.email,
      });
      continue;
    }

    const serviceAccount = serviceAccounts.get(ownerId);
    if (serviceAccount) {
      result.set(ownerId, {
        type: 'service_account',
        name: serviceAccount.agentName || serviceAccount.name,
        email: null,
      });
      continue;
    }

    result.set(ownerId, { type: 'unknown', name: null, email: null });
  }

  return result;
}

export function selectSessionRowsForViewer(input: {
  rows: ProjectSessionRow[];
  scope: ProjectSessionListScope;
  canManageProject: boolean;
  subject: ShareSubject;
  /** The caller's own session when the credential is bound to one (sandbox
   *  token). Stops a sandbox listing SIBLING backend sessions, which all share
   *  one `created_by`. */
  callerSessionId: string | null;
  grantsBySession: Map<string, SecretGrant[]>;
  runtimeStatusBySession: Map<string, RuntimeStatus>;
}): { authorized: boolean; items: SessionInventoryItem[] } {
  if (input.scope === 'project' && !input.canManageProject) {
    return { authorized: false, items: [] };
  }

  const items = input.rows.map((row) => {
    const metadata = (row.metadata ?? {}) as Record<string, unknown>;
    const deletedAt =
      typeof metadata.deletedAt === 'string' ? metadata.deletedAt : null;
    const deletedBy =
      typeof metadata.deletedBy === 'string' ? metadata.deletedBy : null;
    const runtimeStatus =
      input.runtimeStatusBySession.get(row.sessionId) ?? null;
    const canAccess = isSessionVisibleTo(
      row.visibility as 'private' | 'project' | 'restricted',
      row.createdBy,
      input.grantsBySession.get(row.sessionId) ?? [],
      input.subject,
      {
        origin: row.origin ?? null,
        sessionId: row.sessionId,
        callerSessionId: input.callerSessionId,
      },
    );
    return { row, canAccess, runtimeStatus, deletedAt, deletedBy };
  });

  if (input.scope === 'project') {
    return { authorized: true, items };
  }

  return {
    authorized: true,
    items: items.filter((item) => {
      if (item.deletedAt) return false;
      if (!item.canAccess) return false;
      if (isUnclaimedWarmSession(item.row.metadata)) return false;
      return item.row.status !== 'stopped' || item.runtimeStatus === 'stopped';
    }),
  };
}

/**
 * An UNCLAIMED warm session — one the project index page pre-created
 * speculatively and nobody ever used
 * (`apps/web/src/hooks/projects/use-warm-index-session.ts`,
 * `POST /projects/:id/sessions/warm`).
 *
 * It holds no user work, so listing it is noise: the user sees a session in the
 * sidebar that they never started. Claiming it flips the marker to `claimed`,
 * and from that moment it lists like any other session.
 *
 * Anything that is NOT `claimed` is unclaimed — `available` AND `discarded`.
 * `discarded` matters as much as `available` and is easy to miss:
 * `discardAvailableWarmProjectSession` only ever writes over a row that is
 * still `available` (see its WHERE clause in `warm-session-store.ts`), so a
 * discarded row is by construction one a human never touched. It is also the
 * STEADY STATE, not a rare edge: the reaper stops an unclaimed warm box after
 * `warmPoolGrantMs()` (60 min) and leaves the row at `available` with
 * `status = 'stopped'`; the next warm ensure finds it incompatible and marks it
 * `discarded`. Matching only `available` would therefore put an empty session
 * in the sidebar of every user who opens a project, leaves for an hour, and
 * comes back.
 *
 * `visible` scope only. The `project` scope is the manager's full inventory —
 * somebody auditing every session in the project must still see the warm rows,
 * because they are real rows that held a real sandbox.
 */
function isUnclaimedWarmSession(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return false;
  const warm = (metadata as Record<string, unknown>).warm_session;
  if (!warm || typeof warm !== 'object' || Array.isArray(warm)) return false;
  const state = (warm as Record<string, unknown>).state;
  return state === 'available' || state === 'discarded';
}
