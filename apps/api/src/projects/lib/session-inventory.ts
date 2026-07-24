import {
  isSessionVisibleTo,
  type SecretGrant,
  type ShareSubject,
} from '../../executor/share';
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
    );
    return { row, canAccess, runtimeStatus, deletedAt, deletedBy };
  });

  if (input.scope === 'project') return { authorized: true, items };

  return {
    authorized: true,
    items: items.filter((item) => {
      if (item.deletedAt) return false;
      if (!item.canAccess) return false;
      return item.row.status !== 'stopped' || item.runtimeStatus === 'stopped';
    }),
  };
}
