import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { accountSecretGrants, accountSecretResources, sessionProviderSecretPools } from '@kortix/db';
import { config } from '../config';
import { db } from '../shared/db';
import { accountMemberJoin } from '../iam/membership-read';

const envelopeVersion = 'v1';

function key(accountId: string): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(config.API_KEY_SECRET), Buffer.from(accountId), Buffer.from('kortix-account-secret-resource-v1'), 32));
}

export function encryptAccountSecret(accountId: string, value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(accountId), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [envelopeVersion, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join(':');
}

export function decryptAccountSecret(accountId: string, envelope: string): string {
  const [version, ivText, tagText, encryptedText] = envelope.split(':');
  if (version !== envelopeVersion || !ivText || !tagText || encryptedText === undefined) throw new Error('Invalid account secret envelope');
  const iv = Buffer.from(ivText, 'base64url');
  const tag = Buffer.from(tagText, 'base64url');
  if (iv.length !== 12 || tag.length !== 16) throw new Error('Invalid account secret envelope');
  const decipher = createDecipheriv('aes-256-gcm', key(accountId), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(Buffer.from(encryptedText, 'base64url')), decipher.final()]).toString('utf8');
}

/**
 * A stored value this API can no longer decrypt (a rotated API_KEY_SECRET, a
 * damaged row) is unusable, not a server error: `null` lets the caller treat
 * that one secret as needing a new value.
 */
export function readAccountSecret(accountId: string, secretId: string, envelope: string): string | null {
  try {
    return decryptAccountSecret(accountId, envelope);
  } catch (err) {
    console.warn(`[account-secret] cannot decrypt secret ${secretId}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** A stored credential as the gateway reads it. `value` is null when it cannot
 *  be decrypted; `updatedAt` is the version a later write-back is guarded by. */
export interface ResolvedAccountSecret {
  secretId: string;
  label: string;
  value: string | null;
  updatedAt: Date;
}

/**
 * How long a resting account waits before one re-try. A user can reset a
 * ChatGPT plan's usage before the reset the provider named; without a re-try the
 * project stays on paid fallback models until that date (2026-10-06).
 */
export const COOLDOWN_PROBE_SECONDS = 15 * 60;

/** The longest rest: ChatGPT's weekly plan limit, plus a day. */
export const MAX_ACCOUNT_SECRET_REST_SECONDS = 8 * 24 * 60 * 60;

/**
 * Record a provider limit across gateway replicas: seconds for a rate limit,
 * days for a plan's usage limit. A concurrent limit never shortens the cooldown.
 */
export async function coolDownAccountSecret(secretId: string, accountId: string, seconds: number): Promise<void> {
  const until = new Date(Date.now() + Math.max(1, Math.min(MAX_ACCOUNT_SECRET_REST_SECONDS, Math.floor(seconds))) * 1000);
  await db.update(accountSecretResources).set({
    cooldownUntil: sql`greatest(coalesce(${accountSecretResources.cooldownUntil}, '-infinity'::timestamptz), ${until.toISOString()}::timestamptz)`,
    cooldownProbeAt: new Date(Date.now() + COOLDOWN_PROBE_SECONDS * 1000),
  }).where(and(eq(accountSecretResources.secretId, secretId), eq(accountSecretResources.accountId, accountId)));
}

/**
 * Lift the rest of every row whose re-try is due, once across replicas: the
 * update claims the row only while its probe time is still the one read, and
 * schedules the next re-try. A lifted row is usable again; when the provider
 * still refuses, its next limit rests the account again (`coolDownAccountSecret`).
 */
async function liftDueCooldowns<T extends { secretId: string; cooldownUntil: Date | null; cooldownProbeAt: Date | null }>(accountId: string, rows: T[]): Promise<T[]> {
  const now = Date.now();
  return Promise.all(rows.map(async (row) => {
    if (!row.cooldownUntil || row.cooldownUntil.getTime() <= now || !row.cooldownProbeAt || row.cooldownProbeAt.getTime() > now) return row;
    const [claimed] = await db.update(accountSecretResources)
      .set({ cooldownUntil: null, cooldownProbeAt: new Date(now + COOLDOWN_PROBE_SECONDS * 1000) })
      .where(and(
        eq(accountSecretResources.secretId, row.secretId),
        eq(accountSecretResources.accountId, accountId),
        eq(accountSecretResources.cooldownProbeAt, row.cooldownProbeAt),
      ))
      .returning({ secretId: accountSecretResources.secretId });
    return claimed ? { ...row, cooldownUntil: null } : row;
  }));
}

/** An owner's "retry now": end the rest of one stored account. False when no row matched. */
export async function clearAccountSecretCooldown(secretId: string, accountId: string): Promise<boolean> {
  const cleared = await db.update(accountSecretResources)
    .set({ cooldownUntil: null, cooldownProbeAt: null })
    .where(and(eq(accountSecretResources.secretId, secretId), eq(accountSecretResources.accountId, accountId)))
    .returning({ secretId: accountSecretResources.secretId });
  return cleared.length > 0;
}

/** Provider names visible to a member for model discovery. Never reads secret values. */
export function secretUsableInProject(row: { projectId: string | null; accessMode: string }, projectId: string, granted: boolean): boolean {
  return (row.projectId === null || row.projectId === projectId) && (row.accessMode === 'project' || granted);
}

/**
 * Is a `private` provider key granted to the personal-key owner? Spec
 * 2026-09-22 §2.3: `grantUserId` null (an agent-principal session with no
 * on-behalf-of human) matches no grant, so only `project`-mode keys remain.
 */
export function personalKeyGranted(rowGrantUserId: string | null, grantUserId: string | null): boolean {
  return grantUserId !== null && rowGrantUserId === grantUserId;
}

/**
 * May `userId` read `projectId`? By default a question about a member, by
 * role. Account-wide MFA (authorize step 6) guards a person's own browser
 * requests, and the route that led here authorized its request with that
 * request's level. Asked with no level, the gate refused every member of an
 * account that requires MFA except a super admin. So no pooled key reached
 * their sessions: a Teams channel never reached the ChatGPT login shared with
 * the whole project, and failed every turn with "Connect Codex" (2026-10-01).
 *
 * A route that asks about the caller's own request, with no authorize call of
 * its own, passes `request` with that request's level.
 */
export async function memberMayReadProject(
  accountId: string,
  projectId: string,
  userId: string,
  request?: { mfaAal: string | undefined },
): Promise<boolean> {
  const [{ actorForUser }, { authorize }, { PROJECT_ACTIONS }] = await Promise.all([
    import('../iam/actor'), import('../iam/authorize'), import('../iam/actions'),
  ]);
  const mfaAal = request ? request.mfaAal : 'aal2';
  return (await authorize(actorForUser(userId, accountId, { mfaAal }), PROJECT_ACTIONS.PROJECT_READ, { type: 'project', id: projectId })).allowed;
}

export async function listGrantedGatewaySecretNames(
  accountId: string,
  projectId: string,
  userId: string,
  /**
   * Whose personal grants count. Absent = `userId`. `null` = none: only keys
   * shared with the whole project, which is all a shared session reaches
   * (spec 2026-09-22 §2.3).
   */
  grantUserId: string | null = userId,
): Promise<string[]> {
  return [...new Set((await listUsableGatewaySecrets({ accountId, projectId, userId, grantUserId })).map((row) => row.name))];
}

export interface UsableGatewaySecret {
  secretId: string;
  providerId: string | null;
  name: string;
  label: string;
  accessMode: string;
}

/** Which active gateway keys to read, and whose member grants count. */
export interface GatewaySecretQuery {
  accountId: string;
  projectId: string;
  /**
   * The only user whose member grants count: a key shared with members is
   * usable only when granted to this user. Null counts no grant: only keys
   * shared with the whole project (spec 2026-09-22 §2.3).
   */
  grantUserId: string | null;
  providerId?: string;
  /** Only keys stored under this key name. */
  name?: string;
  /** Only these keys. */
  ids?: string[];
}

/** The active gateway keys `q` names, oldest first, each with `q.grantUserId`'s grant when one exists. */
function gatewaySecretRows(q: GatewaySecretQuery) {
  return db.select({
    secretId: accountSecretResources.secretId,
    providerId: accountSecretResources.providerId,
    name: accountSecretResources.name,
    label: accountSecretResources.label,
    projectId: accountSecretResources.projectId,
    accessMode: accountSecretResources.accessMode,
    grantUserId: accountSecretGrants.userId,
  }).from(accountSecretResources)
    .leftJoin(accountSecretGrants, and(
      eq(accountSecretGrants.secretId, accountSecretResources.secretId),
      q.grantUserId ? eq(accountSecretGrants.userId, q.grantUserId) : sql`false`,
    ))
    .where(and(
      eq(accountSecretResources.accountId, q.accountId),
      eq(accountSecretResources.consumer, 'llm_gateway'),
      eq(accountSecretResources.active, true),
      ...(q.providerId ? [eq(accountSecretResources.providerId, q.providerId)] : []),
      ...(q.name ? [eq(accountSecretResources.name, q.name)] : []),
      ...(q.ids ? [inArray(accountSecretResources.secretId, q.ids)] : []),
    ))
    .orderBy(asc(accountSecretResources.createdAt), asc(accountSecretResources.secretId))
    .$dynamic();
}

/** The rows usable in `q.projectId` with `q.grantUserId`'s grants, each key once. */
function usableRows(
  q: GatewaySecretQuery,
  rows: Array<UsableGatewaySecret & { projectId: string | null; grantUserId: string | null }>,
): UsableGatewaySecret[] {
  const seen = new Set<string>();
  const usable: UsableGatewaySecret[] = [];
  for (const row of rows) {
    if (seen.has(row.secretId)) continue;
    if (!secretUsableInProject(row, q.projectId, personalKeyGranted(row.grantUserId, q.grantUserId))) continue;
    seen.add(row.secretId);
    usable.push({ secretId: row.secretId, providerId: row.providerId, name: row.name, label: row.label, accessMode: row.accessMode });
  }
  return usable;
}

/**
 * The gateway keys usable in the project with `grantUserId`'s member grants,
 * oldest first. Never reads a value.
 *
 * Checks the keys, not a principal: the caller has already authorized whoever
 * acts. A principal that must read the project uses `listUsableGatewaySecrets`.
 */
export async function queryUsableGatewaySecrets(q: GatewaySecretQuery): Promise<UsableGatewaySecret[]> {
  return usableRows(q, await gatewaySecretRows(q));
}

/**
 * The gateway keys an account member may select in this project, oldest
 * first: `userId` must read the project and have an `account_members` row.
 * Never reads a value. `grantUserId` as in `listGrantedGatewaySecretNames`.
 *
 * A key cooling down after a rate limit is still listed: it belongs to the
 * pool, and the gateway skips it only until its cooldown ends.
 */
export async function listUsableGatewaySecrets(input: Omit<GatewaySecretQuery, 'grantUserId'> & {
  userId: string;
  grantUserId?: string | null;
}): Promise<UsableGatewaySecret[]> {
  const q = { ...input, grantUserId: input.grantUserId === undefined ? input.userId : input.grantUserId };
  if (!(await memberMayReadProject(input.accountId, input.projectId, input.userId))) return [];
  return usableRows(q, await gatewaySecretRows(q)
    .innerJoin(...accountMemberJoin(input.accountId, input.userId)));
}

/** A stored ChatGPT login, read again when the provider refused its token. */
export interface CodexAccountLogin {
  value: string | null;
  updatedAt: Date;
  needsReauthAt: Date | null;
}

export async function loadCodexAccountLogin(accountId: string, secretId: string): Promise<CodexAccountLogin | null> {
  const [row] = await db.select({
    valueEnc: accountSecretResources.valueEnc,
    updatedAt: accountSecretResources.updatedAt,
    needsReauthAt: accountSecretResources.needsReauthAt,
  }).from(accountSecretResources).where(and(
    eq(accountSecretResources.accountId, accountId),
    eq(accountSecretResources.secretId, secretId),
    eq(accountSecretResources.providerId, 'codex'),
    eq(accountSecretResources.name, 'CODEX_AUTH_JSON'),
    eq(accountSecretResources.active, true),
  )).limit(1);
  return row
    ? { value: readAccountSecret(accountId, secretId, row.valueEnc), updatedAt: row.updatedAt, needsReauthAt: row.needsReauthAt }
    : null;
}

/**
 * An unconfigured session uses the caller's newest personal ChatGPT
 * connection, preferring one whose login still works: a connection marked for
 * reconnection is the default only when every other one is marked too.
 */
export async function resolveDefaultCodexAccountSecret(accountId: string, projectId: string, userId: string): Promise<ResolvedAccountSecret | null> {
  if (!(await memberMayReadProject(accountId, projectId, userId))) return null;
  const [row] = await db.select({
    secretId: accountSecretResources.secretId,
    label: accountSecretResources.label,
    valueEnc: accountSecretResources.valueEnc,
    updatedAt: accountSecretResources.updatedAt,
  }).from(accountSecretResources)
    .innerJoin(accountSecretGrants, and(eq(accountSecretGrants.secretId, accountSecretResources.secretId), eq(accountSecretGrants.accountId, accountId)))
    .innerJoin(...accountMemberJoin(accountId, userId))
    .where(and(
      eq(accountSecretResources.accountId, accountId),
      eq(accountSecretResources.providerId, 'codex'),
      eq(accountSecretResources.name, 'CODEX_AUTH_JSON'),
      eq(accountSecretResources.consumer, 'llm_gateway'),
      eq(accountSecretResources.active, true),
      eq(accountSecretResources.createdBy, userId),
      eq(accountSecretGrants.userId, userId),
      or(eq(accountSecretResources.projectId, projectId), isNull(accountSecretResources.projectId)),
    ))
    .orderBy(
      sql`${accountSecretResources.needsReauthAt} is not null`,
      desc(accountSecretResources.createdAt),
      desc(accountSecretResources.secretId),
    )
    .limit(1);
  return row
    ? { secretId: row.secretId, label: row.label, value: readAccountSecret(accountId, row.secretId, row.valueEnc), updatedAt: row.updatedAt }
    : null;
}

/**
 * The project's shared provider accounts a session WITHOUT an explicit pool
 * falls back to: the same keys the model picker lists (`listUsableGatewaySecrets`
 * — `userId` must read the project and be an account member; a key is usable
 * when it is shared with the whole project, or granted to `grantUserId`),
 * oldest first, with their values. A key cooling down after a rate limit is
 * skipped; when every usable key cools down, `retryAfterSeconds` names the
 * earliest one to free up.
 *
 * Resolved at use time, so a revoked grant or a deleted key affects the next call.
 */
export async function resolveProjectSharedProviderSecrets(input: Omit<GatewaySecretQuery, 'providerId'> & {
  userId: string;
  providerId: string;
}): Promise<{ coolingDown: boolean; retryAfterSeconds?: number; secrets: ResolvedAccountSecret[] }> {
  const usable = await listUsableGatewaySecrets(input);
  if (!usable.length) return { coolingDown: false, secrets: [] };
  const rows = await db.select({
    secretId: accountSecretResources.secretId,
    valueEnc: accountSecretResources.valueEnc,
    updatedAt: accountSecretResources.updatedAt,
    cooldownUntil: accountSecretResources.cooldownUntil,
    cooldownProbeAt: accountSecretResources.cooldownProbeAt,
  }).from(accountSecretResources).where(and(
    eq(accountSecretResources.accountId, input.accountId),
    eq(accountSecretResources.active, true),
    inArray(accountSecretResources.secretId, usable.map((row) => row.secretId)),
  ));
  const byId = new Map((await liftDueCooldowns(input.accountId, rows)).map((row) => [row.secretId, row]));
  const ordered = usable.flatMap((key) => {
    const row = byId.get(key.secretId);
    return row ? [{ ...key, ...row }] : [];
  });
  const now = Date.now();
  const ready = ordered.filter((row) => !row.cooldownUntil || row.cooldownUntil.getTime() <= now);
  if (!ready.length) {
    if (!ordered.length) return { coolingDown: false, secrets: [] };
    const earliest = Math.min(...ordered.map((row) => row.cooldownUntil!.getTime()));
    return { coolingDown: true, retryAfterSeconds: Math.max(1, Math.ceil((earliest - now) / 1000)), secrets: [] };
  }
  return { coolingDown: false, secrets: ready.map((row) => ({
    secretId: row.secretId, label: row.label, value: readAccountSecret(input.accountId, row.secretId, row.valueEnc), updatedAt: row.updatedAt,
  })) };
}

/** Resolve at use time so grant revocation and deletion affect the next call. */
export async function resolveSessionProviderSecrets(input: {
  accountId: string;
  projectId: string;
  userId: string;
  /**
   * Whose PERSONAL key grants count (spec 2026-09-22 §2.3). Absent = `userId`
   * (legacy). `null` = none: only project-mode keys are usable.
   */
  grantUserId?: string | null;
  providerId: string;
  name: string;
  advanceIndex?: boolean;
} & ({ sessionId: string; secretIds?: never } | { secretIds: string[]; sessionId?: never })): Promise<{ configured: boolean; coolingDown: boolean; retryAfterSeconds?: number; secrets: ResolvedAccountSecret[] }> {
  const grantUserId = input.grantUserId === undefined ? input.userId : input.grantUserId;
  let pool: { secretIds: string[]; nextIndex: number } | undefined;
  if (input.secretIds !== undefined) {
    pool = { secretIds: input.secretIds, nextIndex: 1 };
  } else if (input.advanceIndex === false) {
    [pool] = await db.select({ secretIds: sessionProviderSecretPools.secretIds, nextIndex: sessionProviderSecretPools.nextIndex })
      .from(sessionProviderSecretPools)
      .where(and(eq(sessionProviderSecretPools.sessionId, input.sessionId), eq(sessionProviderSecretPools.providerId, input.providerId))).limit(1);
  } else {
    [pool] = await db.update(sessionProviderSecretPools)
      .set({ nextIndex: sql`case when ${sessionProviderSecretPools.nextIndex} >= 2147483646 then 0 else ${sessionProviderSecretPools.nextIndex} + 1 end` })
      .where(and(eq(sessionProviderSecretPools.sessionId, input.sessionId), eq(sessionProviderSecretPools.providerId, input.providerId)))
      .returning({ secretIds: sessionProviderSecretPools.secretIds, nextIndex: sessionProviderSecretPools.nextIndex });
  }
  if (!pool) return { configured: false, coolingDown: false, secrets: [] };
  if (!pool.secretIds.length) return { configured: true, coolingDown: false, secrets: [] };
  if (!(await memberMayReadProject(input.accountId, input.projectId, input.userId))) return { configured: true, coolingDown: false, secrets: [] };
  const rows = await db.select({
    secretId: accountSecretResources.secretId,
    label: accountSecretResources.label,
    valueEnc: accountSecretResources.valueEnc,
    updatedAt: accountSecretResources.updatedAt,
    cooldownUntil: accountSecretResources.cooldownUntil,
    cooldownProbeAt: accountSecretResources.cooldownProbeAt,
    projectId: accountSecretResources.projectId,
    accessMode: accountSecretResources.accessMode,
    grantUserId: accountSecretGrants.userId,
  }).from(accountSecretResources)
    .leftJoin(accountSecretGrants, and(
      eq(accountSecretGrants.secretId, accountSecretResources.secretId),
      grantUserId ? eq(accountSecretGrants.userId, grantUserId) : sql`false`,
    ))
    .innerJoin(...accountMemberJoin(input.accountId, input.userId))
    .where(and(
      eq(accountSecretResources.accountId, input.accountId),
      eq(accountSecretResources.providerId, input.providerId),
      eq(accountSecretResources.name, input.name),
      eq(accountSecretResources.consumer, 'llm_gateway'),
      eq(accountSecretResources.active, true),
      inArray(accountSecretResources.secretId, pool.secretIds),
    ));
  const usableRows = rows.filter((row) => secretUsableInProject(
    row, input.projectId, personalKeyGranted(row.grantUserId, grantUserId),
  ));
  const byId = new Map((await liftDueCooldowns(input.accountId, usableRows)).map((row) => [row.secretId, row]));
  const ordered = pool.secretIds.flatMap((id) => {
    const row = byId.get(id);
    return row ? [row] : [];
  });
  const ready = ordered.filter((row) => !row.cooldownUntil || row.cooldownUntil.getTime() <= Date.now());
  if (!ready.length) {
    const earliest = Math.min(...ordered.map((row) => row.cooldownUntil?.getTime() ?? Date.now()));
    return {
      configured: true, coolingDown: ordered.length > 0,
      retryAfterSeconds: ordered.length ? Math.max(1, Math.ceil((earliest - Date.now()) / 1000)) : undefined,
      secrets: [],
    };
  }
  const first = (pool.nextIndex - 1) % ready.length;
  const rotated = [...ready.slice(first), ...ready.slice(0, first)];
  return { configured: true, coolingDown: false, secrets: rotated.map((row) => ({
    secretId: row.secretId, label: row.label, value: readAccountSecret(input.accountId, row.secretId, row.valueEnc), updatedAt: row.updatedAt,
  })) };
}
