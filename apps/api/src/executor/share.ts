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
 */
import { eq, inArray } from 'drizzle-orm';
import {
  accountGroupMembers,
  projectSecretGrants,
  projectSecrets,
  projectSessionGrants,
  projectSessions,
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
  | { mode: 'members'; memberIds?: readonly string[]; groupIds?: readonly string[] };

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

/**
 * Validate/normalize an untrusted sharing body into a SharingIntent.
 * Shared by the connector sharing route and the project-secrets API. Returns
 * null when `mode` is missing/unknown so callers can 400. A `private` body with
 * no explicit `ownerId` falls back to the acting user.
 */
export function parseSharingIntent(body: any, fallbackOwner: string): SharingIntent | null {
  const mode = typeof body?.mode === 'string' ? body.mode : '';
  if (mode === 'project') return { mode: 'project' };
  if (mode === 'private') {
    const ownerId = typeof body?.ownerId === 'string' && body.ownerId ? body.ownerId : fallbackOwner;
    return { mode: 'private', ownerId };
  }
  if (mode === 'members') {
    const memberIds = Array.isArray(body?.memberIds) ? body.memberIds.filter((x: unknown) => typeof x === 'string') : [];
    const groupIds = Array.isArray(body?.groupIds) ? body.groupIds.filter((x: unknown) => typeof x === 'string') : [];
    return { mode: 'members', memberIds, groupIds };
  }
  return null;
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

/* ─── Session sharing — default private; team-wide or select-members ───────────
 *
 * Same allow-list mechanism as secrets, but sessions have a first-class
 * `private` visibility (owner only) instead of modelling it as restricted+owner.
 * The dashboard's SharingIntent maps: project→project, private→private,
 * members→restricted+grants (empty members collapses back to private).
 * See docs/specs/iam.md.
 */

type SessionVisibility = 'private' | 'project' | 'restricted';

/** Pure: can this subject see/open the session? The owner always can. */
export function isSessionVisibleTo(
  visibility: SessionVisibility,
  ownerId: string | null,
  grants: SecretGrant[],
  subject: ShareSubject,
): boolean {
  if (ownerId && ownerId === subject.userId) return true;
  if (visibility === 'project') return true;
  if (visibility === 'restricted') {
    for (const g of grants) {
      if (g.principalType === 'member' && g.principalId === subject.userId) return true;
      if (g.principalType === 'group' && subject.groupIds.includes(g.principalId)) return true;
    }
  }
  return false;
}

/** Map a sharing intent → persisted (visibility, grants). */
function sessionIntentToVisibility(intent: SharingIntent): {
  visibility: SessionVisibility;
  grants: SecretGrant[];
} {
  if (intent.mode === 'project') return { visibility: 'project', grants: [] };
  if (intent.mode === 'private') return { visibility: 'private', grants: [] };
  const grants: SecretGrant[] = [
    ...(intent.memberIds ?? []).map((id) => ({ principalType: 'member' as const, principalId: id })),
    ...(intent.groupIds ?? []).map((id) => ({ principalType: 'group' as const, principalId: id })),
  ];
  // Empty allow-list collapses to private (owner only).
  if (grants.length === 0) return { visibility: 'private', grants: [] };
  return { visibility: 'restricted', grants };
}

/** Inverse of sessionIntentToVisibility — for rendering the current selection. */
export function visibilityToIntent(visibility: SessionVisibility, grants: SecretGrant[]): SharingIntent {
  if (visibility === 'project') return { mode: 'project' };
  if (visibility === 'private') return { mode: 'private', ownerId: '' };
  const memberIds = grants.filter((g) => g.principalType === 'member').map((g) => g.principalId);
  const groupIds = grants.filter((g) => g.principalType === 'group').map((g) => g.principalId);
  return { mode: 'members', memberIds, groupIds };
}

/** Bulk-load session grants → map sessionId → grants. */
export async function loadSessionGrants(sessionIds: string[]): Promise<Map<string, SecretGrant[]>> {
  const out = new Map<string, SecretGrant[]>();
  if (sessionIds.length === 0) return out;
  const rows = await db
    .select({
      sessionId: projectSessionGrants.sessionId,
      principalType: projectSessionGrants.principalType,
      principalId: projectSessionGrants.principalId,
    })
    .from(projectSessionGrants)
    .where(inArray(projectSessionGrants.sessionId, sessionIds));
  for (const r of rows) {
    const list = out.get(r.sessionId) ?? [];
    list.push({ principalType: r.principalType as 'member' | 'group', principalId: r.principalId });
    out.set(r.sessionId, list);
  }
  return out;
}

/** Persist a session's sharing: set visibility + replace its grants. */
export async function setSessionSharing(sessionId: string, intent: SharingIntent): Promise<void> {
  const { visibility, grants } = sessionIntentToVisibility(intent);
  await db.update(projectSessions).set({ visibility, updatedAt: new Date() }).where(eq(projectSessions.sessionId, sessionId));
  await db.delete(projectSessionGrants).where(eq(projectSessionGrants.sessionId, sessionId));
  if (grants.length > 0) {
    await db.insert(projectSessionGrants).values(
      grants.map((g) => ({ sessionId, principalType: g.principalType, principalId: g.principalId })),
    );
  }
}
