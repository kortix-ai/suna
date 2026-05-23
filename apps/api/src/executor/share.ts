/**
 * Project-secret sharing — who can use a secret (and therefore the connector
 * bound to it). Three dashboard options map onto one mechanism:
 *
 *   Project wide   → share_scope='project'                 (everyone)
 *   Select members → share_scope='restricted' + grants     (members and/or groups)
 *   Just me        → share_scope='restricted' + one member grant (the owner)
 *
 * Rule (Marko): empty allow-list = whole project; ≥1 grant = restricted.
 * Pure logic here is unit-tested; DB helpers feed the gateway + CRUD.
 *
 * See docs/specs/executor.md §6.
 */
import { and, eq, inArray } from 'drizzle-orm';
import {
  accountGroupMembers,
  projectSecretGrants,
  projectSecrets,
} from '@kortix/db';
import { db } from '../shared/db';

export type ShareScope = 'project' | 'restricted';

export interface SecretGrant {
  principalType: 'member' | 'group';
  principalId: string;
}

/** The acting identity, resolved to the groups it belongs to. */
export interface ShareSubject {
  userId: string;
  groupIds: string[];
}

/** Pure: may this subject use a secret with the given scope + grants? */
export function isSecretUsableBy(
  shareScope: ShareScope,
  grants: SecretGrant[],
  subject: ShareSubject,
): boolean {
  if (shareScope === 'project') return true;
  for (const g of grants) {
    if (g.principalType === 'member' && g.principalId === subject.userId) return true;
    if (g.principalType === 'group' && subject.groupIds.includes(g.principalId)) return true;
  }
  return false;
}

/** The dashboard's three sharing options, before persistence. */
export type SharingIntent =
  | { mode: 'project' }
  | { mode: 'private'; ownerId: string }
  | { mode: 'members'; memberIds?: string[]; groupIds?: string[] };

/** Normalize a sharing intent into a persisted (scope, grants) pair. */
export function intentToScope(intent: SharingIntent): {
  shareScope: ShareScope;
  grants: SecretGrant[];
} {
  if (intent.mode === 'project') return { shareScope: 'project', grants: [] };
  if (intent.mode === 'private') {
    return { shareScope: 'restricted', grants: [{ principalType: 'member', principalId: intent.ownerId }] };
  }
  const grants: SecretGrant[] = [
    ...(intent.memberIds ?? []).map((id) => ({ principalType: 'member' as const, principalId: id })),
    ...(intent.groupIds ?? []).map((id) => ({ principalType: 'group' as const, principalId: id })),
  ];
  // Empty allow-list collapses to project-wide (Marko's rule).
  if (grants.length === 0) return { shareScope: 'project', grants: [] };
  return { shareScope: 'restricted', grants };
}

/** Inverse of intentToScope — for rendering the dashboard's current selection. */
export function scopeToIntent(shareScope: ShareScope, grants: SecretGrant[]): SharingIntent {
  if (shareScope === 'project') return { mode: 'project' };
  const memberIds = grants.filter((g) => g.principalType === 'member').map((g) => g.principalId);
  const groupIds = grants.filter((g) => g.principalType === 'group').map((g) => g.principalId);
  if (memberIds.length === 1 && groupIds.length === 0) return { mode: 'private', ownerId: memberIds[0]! };
  return { mode: 'members', memberIds, groupIds };
}

/* ─── DB helpers (used by the gateway + CRUD) ─────────────────────────────── */

/** Resolve a user's group memberships → the subject the gateway authorizes with. */
export async function resolveShareSubject(userId: string): Promise<ShareSubject> {
  const rows = await db
    .select({ groupId: accountGroupMembers.groupId })
    .from(accountGroupMembers)
    .where(eq(accountGroupMembers.userId, userId));
  return { userId, groupIds: rows.map((r) => r.groupId) };
}

/** Load a single secret's sharing (scope + grants) by project + name. */
export async function getSecretSharing(
  projectId: string,
  name: string,
): Promise<{ secretId: string; shareScope: ShareScope; grants: SecretGrant[] } | null> {
  const [secret] = await db
    .select({ secretId: projectSecrets.secretId, shareScope: projectSecrets.shareScope })
    .from(projectSecrets)
    .where(and(eq(projectSecrets.projectId, projectId), eq(projectSecrets.name, name)))
    .limit(1);
  if (!secret) return null;
  const grants = await loadGrants([secret.secretId]);
  return { secretId: secret.secretId, shareScope: secret.shareScope as ShareScope, grants: grants.get(secret.secretId) ?? [] };
}

/** Can a user use a named secret in a project? (project-wide or in the allow-list.) */
export async function canUseSecretName(
  projectId: string,
  name: string,
  subject: ShareSubject,
): Promise<boolean> {
  const sharing = await getSecretSharing(projectId, name);
  if (!sharing) return false; // secret doesn't exist → connector can't authenticate
  return isSecretUsableBy(sharing.shareScope, sharing.grants, subject);
}

/** Persist a secret's sharing: set scope + replace its grants atomically-ish. */
export async function setSecretSharing(secretId: string, intent: SharingIntent): Promise<void> {
  const { shareScope, grants } = intentToScope(intent);
  await db.update(projectSecrets).set({ shareScope, updatedAt: new Date() }).where(eq(projectSecrets.secretId, secretId));
  await db.delete(projectSecretGrants).where(eq(projectSecretGrants.secretId, secretId));
  if (grants.length > 0) {
    await db.insert(projectSecretGrants).values(
      grants.map((g) => ({ secretId, principalType: g.principalType, principalId: g.principalId })),
    );
  }
}

/** Bulk-load grants for many secrets → map secretId → grants. */
export async function loadGrants(secretIds: string[]): Promise<Map<string, SecretGrant[]>> {
  const out = new Map<string, SecretGrant[]>();
  if (secretIds.length === 0) return out;
  const rows = await db
    .select({
      secretId: projectSecretGrants.secretId,
      principalType: projectSecretGrants.principalType,
      principalId: projectSecretGrants.principalId,
    })
    .from(projectSecretGrants)
    .where(inArray(projectSecretGrants.secretId, secretIds));
  for (const r of rows) {
    const list = out.get(r.secretId) ?? [];
    list.push({ principalType: r.principalType as 'member' | 'group', principalId: r.principalId });
    out.set(r.secretId, list);
  }
  return out;
}
