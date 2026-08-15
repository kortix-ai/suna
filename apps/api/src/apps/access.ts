import { createHmac, timingSafeEqual } from 'node:crypto';
import { accountGroups, accountMembers, appAccessGrants, apps } from '@kortix/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { resolveShareSubject, type SecretGrant, type ShareSubject } from '../connectors/share';
import { config } from '../config';
import { authorize, PROJECT_ACTIONS } from '../iam';
import { db } from '../shared/db';

export type AppAccessMode = 'private' | 'project' | 'restricted' | 'public' | 'password';
export type AppAccessTokenKind = 'kortix' | 'password';

export interface AppAccessPolicy {
  mode: AppAccessMode;
  revision: number;
  member_ids: string[];
  group_ids: string[];
  password_configured: boolean;
}

export type AppAccessPrincipalValidation =
  | { ok: true }
  | {
      ok: false;
      principalType: 'member' | 'group';
      principalId: string;
    };

interface AppAccessTokenPayload {
  v: 1;
  appId: string;
  kind: AppAccessTokenKind;
  userId?: string;
  revision: number;
  exp: number;
}

export function appAccessCookieName(localHttp = false): string {
  return localHttp ? 'kortix_app_access' : '__Host-kortix_app_access';
}

export function appAccessSecret(): string {
  return process.env.KORTIX_APPS_ACCESS_SECRET || config.API_KEY_SECRET;
}

function signature(body: string, secret: string): string {
  return createHmac('sha256', secret).update('kortix-app-access:v1\0').update(body).digest('base64url');
}

export function createAppAccessToken(input: {
  appId: string;
  kind: AppAccessTokenKind;
  userId?: string;
  revision?: number;
  expiresAt: Date;
}, secret = appAccessSecret()): string {
  const payload: AppAccessTokenPayload = {
    v: 1,
    appId: input.appId,
    kind: input.kind,
    ...(input.userId ? { userId: input.userId } : {}),
    revision: input.revision ?? 0,
    exp: Math.floor(input.expiresAt.getTime() / 1000),
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${signature(body, secret)}`;
}

function equal(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function verifyAppAccessToken(
  token: string,
  appId: string,
  secret = appAccessSecret(),
  now = new Date(),
): AppAccessTokenPayload | null {
  const [body, mac, extra] = token.split('.');
  if (!body || !mac || extra || !equal(mac, signature(body, secret))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as AppAccessTokenPayload;
    if (payload.v !== 1 || payload.appId !== appId || payload.exp <= Math.floor(now.getTime() / 1000)) return null;
    if (!['kortix', 'password'].includes(payload.kind)) return null;
    return payload;
  } catch {
    return null;
  }
}

export function appAccessDecision(input: {
  mode: AppAccessMode;
  ownerId: string | null;
  grants: SecretGrant[];
  subject: ShareSubject | null;
}): boolean {
  if (input.mode === 'public') return true;
  if (!input.subject || input.mode === 'password') return false;
  if (input.ownerId && input.ownerId === input.subject.userId) return true;
  if (input.mode === 'project') return true;
  if (input.mode === 'restricted') {
    return input.grants.some((grant) =>
      grant.principalType === 'member'
        ? grant.principalId === input.subject!.userId
        : input.subject!.groupIds.includes(grant.principalId),
    );
  }
  return false;
}

export async function loadAppAccessGrants(appId: string): Promise<SecretGrant[]> {
  const rows = await db.select({
    principalType: appAccessGrants.principalType,
    principalId: appAccessGrants.principalId,
  }).from(appAccessGrants).where(eq(appAccessGrants.appId, appId));
  return rows.map((row) => ({
    principalType: row.principalType as 'member' | 'group',
    principalId: row.principalId,
  }));
}

export async function serializeAppAccessPolicy(
  row: typeof apps.$inferSelect,
): Promise<AppAccessPolicy> {
  const grants = row.accessMode === 'restricted' ? await loadAppAccessGrants(row.appId) : [];
  return {
    mode: row.accessMode as AppAccessMode,
    revision: row.accessRevision,
    member_ids: grants
      .filter((grant) => grant.principalType === 'member')
      .map((grant) => grant.principalId),
    group_ids: grants
      .filter((grant) => grant.principalType === 'group')
      .map((grant) => grant.principalId),
    password_configured: Boolean(row.accessPasswordHash),
  };
}

/** Reject restricted grants that point outside the App account. */
export async function validateAppAccessPrincipals(
  accountId: string,
  input: { memberIds: string[]; groupIds: string[] },
): Promise<AppAccessPrincipalValidation> {
  const memberIds = [...new Set(input.memberIds)];
  const groupIds = [...new Set(input.groupIds)];
  const [memberRows, groupRows] = await Promise.all([
    memberIds.length > 0
      ? db.select({ userId: accountMembers.userId })
          .from(accountMembers)
          .where(and(
            eq(accountMembers.accountId, accountId),
            inArray(accountMembers.userId, memberIds),
          ))
      : [],
    groupIds.length > 0
      ? db.select({ groupId: accountGroups.groupId })
          .from(accountGroups)
          .where(and(
            eq(accountGroups.accountId, accountId),
            inArray(accountGroups.groupId, groupIds),
          ))
      : [],
  ]);
  const existingMemberIds = new Set(memberRows.map((row) => row.userId));
  const missingMemberId = memberIds.find((id) => !existingMemberIds.has(id));
  if (missingMemberId) {
    return { ok: false, principalType: 'member', principalId: missingMemberId };
  }
  const existingGroupIds = new Set(groupRows.map((row) => row.groupId));
  const missingGroupId = groupIds.find((id) => !existingGroupIds.has(id));
  if (missingGroupId) {
    return { ok: false, principalType: 'group', principalId: missingGroupId };
  }
  return { ok: true };
}

export async function persistAppAccessPolicy(
  current: typeof apps.$inferSelect,
  input: {
    mode: AppAccessMode;
    memberIds?: string[];
    groupIds?: string[];
    password?: string;
  },
): Promise<typeof apps.$inferSelect> {
  const memberIds = [...new Set(input.memberIds ?? [])];
  const groupIds = [...new Set(input.groupIds ?? [])];
  const passwordHash = input.password
    ? await Bun.password.hash(input.password, { algorithm: 'argon2id' })
    : input.mode === 'password' ? current.accessPasswordHash : null;

  return db.transaction(async (tx) => {
    const [updated] = await tx.update(apps).set({
      accessMode: input.mode,
      accessPasswordHash: passwordHash,
      accessRevision: sql`${apps.accessRevision} + 1`,
      updatedAt: new Date(),
    }).where(and(
      eq(apps.appId, current.appId),
      eq(apps.projectId, current.projectId),
      isNull(apps.deletedAt),
    )).returning();
    if (!updated) throw new Error('App access update lost its target row');

    await tx.delete(appAccessGrants).where(eq(appAccessGrants.appId, current.appId));
    if (input.mode === 'restricted') {
      await tx.insert(appAccessGrants).values([
        ...memberIds.map((principalId) => ({
          appId: current.appId,
          principalType: 'member' as const,
          principalId,
        })),
        ...groupIds.map((principalId) => ({
          appId: current.appId,
          principalType: 'group' as const,
          principalId,
        })),
      ]);
    }
    return updated;
  });
}

export async function appAccessibleToUser(
  app: {
    appId: string;
    accountId: string;
    projectId: string;
    accessMode: string;
    createdBy: string | null;
  },
  userId: string,
): Promise<boolean> {
  const projectAccess = await authorize(
    userId,
    app.accountId,
    PROJECT_ACTIONS.PROJECT_READ,
    { type: 'project', id: app.projectId },
  );
  if (!projectAccess.allowed) return false;
  const subject = await resolveShareSubject(userId);
  return appAccessDecision({
    mode: app.accessMode as AppAccessMode,
    ownerId: app.createdBy,
    grants: app.accessMode === 'restricted' ? await loadAppAccessGrants(app.appId) : [],
    subject,
  });
}

/* ─── Team scoping — who on the team sees this App ────────────────────────────
 *
 * The same model sessions use (see connectors/share.ts `isSessionVisibleTo`):
 * an App is `private` to the member who made it, `restricted` to an allow-list
 * of members and groups, or visible to the whole project. Apps carry two extra
 * modes that only describe PUBLIC traffic — `public` and `password` — and both
 * are team-visible: a password protects the App's hostname from the internet,
 * it never hides the App from the teammates who operate it.
 *
 * Before this, `access_mode` governed public traffic only, so a private App was
 * still listed, renamed, resized, redeployed, and deleted by every project
 * member. The management plane now honors the same policy.
 */

/** Who a mode exposes the App to inside the team, before owner/manager. */
export type AppTeamScope = 'owner' | 'shared' | 'team';

export function appTeamScope(mode: AppAccessMode): AppTeamScope {
  if (mode === 'private') return 'owner';
  if (mode === 'restricted') return 'shared';
  return 'team';
}

/**
 * Pure: may this subject see and operate the App? The App's creator always can,
 * and so does a project manager — otherwise a private App becomes unmanageable
 * the moment the member who created it leaves the account.
 */
export function appVisibleToSubject(input: {
  mode: AppAccessMode;
  ownerId: string | null;
  grants: SecretGrant[];
  subject: ShareSubject;
  isProjectManager: boolean;
}): boolean {
  if (input.isProjectManager) return true;
  if (input.ownerId && input.ownerId === input.subject.userId) return true;
  switch (appTeamScope(input.mode)) {
    case 'team':
      return true;
    case 'shared':
      return input.grants.some((grant) =>
        grant.principalType === 'member'
          ? grant.principalId === input.subject.userId
          : input.subject.groupIds.includes(grant.principalId),
      );
    case 'owner':
      return false;
  }
}

/** Bulk-load App grants → map appId → grants. Mirrors loadSessionGrants. */
export async function loadAppAccessGrantsFor(
  appIds: string[],
): Promise<Map<string, SecretGrant[]>> {
  const out = new Map<string, SecretGrant[]>();
  if (appIds.length === 0) return out;
  const rows = await db.select({
    appId: appAccessGrants.appId,
    principalType: appAccessGrants.principalType,
    principalId: appAccessGrants.principalId,
  }).from(appAccessGrants).where(inArray(appAccessGrants.appId, appIds));
  for (const row of rows) {
    const list = out.get(row.appId) ?? [];
    list.push({
      principalType: row.principalType as 'member' | 'group',
      principalId: row.principalId,
    });
    out.set(row.appId, list);
  }
  return out;
}

interface TeamScopedApp {
  appId: string;
  accountId: string;
  projectId: string;
  accessMode: string;
  createdBy: string | null;
}

async function projectManager(accountId: string, projectId: string, userId: string): Promise<boolean> {
  const verdict = await authorize(
    userId,
    accountId,
    PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE,
    { type: 'project', id: projectId },
  );
  return verdict.allowed;
}

/**
 * The subset of `rows` this user may see. One subject resolution, one manager
 * verdict, and one grant query for the whole page — never per App.
 */
export async function filterAppsVisibleToUser<T extends TeamScopedApp>(
  rows: T[],
  userId: string,
): Promise<T[]> {
  if (rows.length === 0) return [];
  const first = rows[0]!;
  const [subject, isProjectManager, grants] = await Promise.all([
    resolveShareSubject(userId),
    projectManager(first.accountId, first.projectId, userId),
    loadAppAccessGrantsFor(
      rows.filter((row) => row.accessMode === 'restricted').map((row) => row.appId),
    ),
  ]);
  return rows.filter((row) => appVisibleToSubject({
    mode: row.accessMode as AppAccessMode,
    ownerId: row.createdBy,
    grants: grants.get(row.appId) ?? [],
    subject,
    isProjectManager,
  }));
}

/** Single-App form of {@link filterAppsVisibleToUser}. */
export async function appVisibleToUser(app: TeamScopedApp, userId: string): Promise<boolean> {
  return (await filterAppsVisibleToUser([app], userId)).length === 1;
}

export function appAccessSessionUrl(
  url: string,
  app: { appId: string; accessRevision: number },
  userId: string,
  now = new Date(),
): { url: string; expiresAt: Date } {
  const expiresAt = new Date(now.getTime() + 5 * 60_000);
  const token = createAppAccessToken({
    appId: app.appId,
    kind: 'kortix',
    userId,
    revision: app.accessRevision,
    expiresAt,
  });
  const target = new URL(url);
  target.searchParams.set('__kortix_access', token);
  return { url: target.toString(), expiresAt };
}

export function appAccessCookie(
  token: string,
  maxAgeSeconds = 8 * 60 * 60,
  localHttp = false,
): string {
  const policy = localHttp
    ? 'Secure; SameSite=None; Partitioned'
    : 'Secure; SameSite=Lax';
  return `${appAccessCookieName(localHttp)}=${token}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; ${policy}`;
}

export function cookieValue(request: Request, name: string): string | null {
  for (const item of (request.headers.get('cookie') || '').split(';')) {
    const [key, ...value] = item.trim().split('=');
    if (key === name) return value.join('=') || null;
  }
  return null;
}
