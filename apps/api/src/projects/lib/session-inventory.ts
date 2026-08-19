import {
  isProjectSessionVisibleTo,
  type SecretGrant,
  type ShareSubject,
} from '../../connectors/share';
import type { projectSessions, sessionSandboxes } from '@kortix/db';
import { isWarmProjectSession } from './warm-sessions';

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
  /** The caller's AGENT/SANDBOX token binding (`callerKortixSessionId(c)`).
   *  Only the trigger-session manager override reads it — see share.ts. */
  boundCredentialSessionId: string | null;
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
    const canAccess = isProjectSessionVisibleTo(
      row.visibility as 'private' | 'project' | 'restricted',
      row.createdBy,
      input.grantsBySession.get(row.sessionId) ?? [],
      input.subject,
      {
        origin: row.origin ?? null,
        sessionId: row.sessionId,
        callerSessionId: input.callerSessionId,
        boundCredentialSessionId: input.boundCredentialSessionId,
      },
      { metadata: row.metadata, canManageProject: input.canManageProject },
    );
    return { row, canAccess, runtimeStatus, deletedAt, deletedBy };
  });

  if (input.scope === 'project') {
    // A list row is a disclosure. Keep manager-only lifecycle coverage for
    // sessions the manager can open, including warm and soft-deleted rows, but
    // never return an inaccessible session as a redacted breadcrumb.
    return { authorized: true, items: items.filter((item) => item.canAccess) };
  }

  return {
    authorized: true,
    items: items.filter((item) => {
      if (item.deletedAt) return false;
      if (!item.canAccess) return false;
      // A warm session the user never prompted holds no work of theirs, so
      // listing it is noise: they would see a session in the sidebar they never
      // started. The marker is dropped by the first prompt, and from that moment
      // the row lists like any other session. See lib/warm-sessions.ts.
      //
      // `visible` scope only. The `project` scope keeps accessible warm rows for
      // lifecycle inspection, but it also applies the access filter above.
      if (isWarmProjectSession(item.row.metadata)) return false;
      return item.row.status !== 'stopped' || item.runtimeStatus === 'stopped';
    }),
  };
}
