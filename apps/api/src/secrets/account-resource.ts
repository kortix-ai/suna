import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { accountMembers, accountSecretGrants, accountSecretResources, sessionProviderSecretPools } from '@kortix/db';
import { config } from '../config';
import { db } from '../shared/db';

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

/** Record a provider limit across gateway replicas. A concurrent limit never shortens the cooldown. */
export async function coolDownAccountSecret(secretId: string, accountId: string, seconds: number): Promise<void> {
  const until = new Date(Date.now() + Math.max(1, Math.min(60, Math.floor(seconds))) * 1000);
  await db.update(accountSecretResources).set({
    cooldownUntil: sql`greatest(coalesce(${accountSecretResources.cooldownUntil}, '-infinity'::timestamptz), ${until.toISOString()}::timestamptz)`,
  }).where(and(eq(accountSecretResources.secretId, secretId), eq(accountSecretResources.accountId, accountId)));
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

export async function memberMayReadProject(accountId: string, projectId: string, userId: string): Promise<boolean> {
  const [{ actorForUser }, { authorize }, { PROJECT_ACTIONS }] = await Promise.all([
    import('../iam/actor'), import('../iam/authorize'), import('../iam/actions'),
  ]);
  return (await authorize(actorForUser(userId, accountId), PROJECT_ACTIONS.PROJECT_READ, { type: 'project', id: projectId })).allowed;
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

/**
 * The gateway keys a member may select in this project, oldest first. Never
 * reads a value. `grantUserId` as in `listGrantedGatewaySecretNames`.
 *
 * A key cooling down after a rate limit is still listed: it belongs to the
 * pool, and the gateway skips it only until its cooldown ends.
 */
export async function listUsableGatewaySecrets(input: {
  accountId: string;
  projectId: string;
  userId: string;
  grantUserId?: string | null;
  providerId?: string;
  /** Only these keys. */
  ids?: string[];
}): Promise<UsableGatewaySecret[]> {
  const grantUserId = input.grantUserId === undefined ? input.userId : input.grantUserId;
  if (!(await memberMayReadProject(input.accountId, input.projectId, input.userId))) return [];
  const rows = await db.select({
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
      grantUserId ? eq(accountSecretGrants.userId, grantUserId) : sql`false`,
    ))
    .innerJoin(accountMembers, and(eq(accountMembers.accountId, input.accountId), eq(accountMembers.userId, input.userId)))
    .where(and(
      eq(accountSecretResources.accountId, input.accountId),
      eq(accountSecretResources.consumer, 'llm_gateway'),
      eq(accountSecretResources.active, true),
      ...(input.providerId ? [eq(accountSecretResources.providerId, input.providerId)] : []),
      ...(input.ids ? [inArray(accountSecretResources.secretId, input.ids)] : []),
    ))
    .orderBy(asc(accountSecretResources.createdAt), asc(accountSecretResources.secretId));
  const seen = new Set<string>();
  const usable: UsableGatewaySecret[] = [];
  for (const row of rows) {
    if (seen.has(row.secretId)) continue;
    if (!secretUsableInProject(row, input.projectId, personalKeyGranted(row.grantUserId, grantUserId))) continue;
    seen.add(row.secretId);
    usable.push({ secretId: row.secretId, providerId: row.providerId, name: row.name, label: row.label, accessMode: row.accessMode });
  }
  return usable;
}

/** An unconfigured session uses the caller's newest personal ChatGPT connection. */
export async function resolveDefaultCodexAccountSecret(accountId: string, projectId: string, userId: string): Promise<{
  secretId: string; label: string; value: string;
} | null> {
  if (!(await memberMayReadProject(accountId, projectId, userId))) return null;
  const [row] = await db.select({
    secretId: accountSecretResources.secretId,
    label: accountSecretResources.label,
    valueEnc: accountSecretResources.valueEnc,
  }).from(accountSecretResources)
    .innerJoin(accountSecretGrants, and(eq(accountSecretGrants.secretId, accountSecretResources.secretId), eq(accountSecretGrants.accountId, accountId)))
    .innerJoin(accountMembers, and(eq(accountMembers.accountId, accountId), eq(accountMembers.userId, userId)))
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
    .orderBy(desc(accountSecretResources.createdAt), desc(accountSecretResources.secretId))
    .limit(1);
  return row ? { secretId: row.secretId, label: row.label, value: decryptAccountSecret(accountId, row.valueEnc) } : null;
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
} & ({ sessionId: string; secretIds?: never } | { secretIds: string[]; sessionId?: never })): Promise<{ configured: boolean; coolingDown: boolean; retryAfterSeconds?: number; secrets: { secretId: string; label: string; value: string }[] }> {
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
    cooldownUntil: accountSecretResources.cooldownUntil,
    projectId: accountSecretResources.projectId,
    accessMode: accountSecretResources.accessMode,
    grantUserId: accountSecretGrants.userId,
  }).from(accountSecretResources)
    .leftJoin(accountSecretGrants, and(
      eq(accountSecretGrants.secretId, accountSecretResources.secretId),
      grantUserId ? eq(accountSecretGrants.userId, grantUserId) : sql`false`,
    ))
    .innerJoin(accountMembers, and(eq(accountMembers.accountId, input.accountId), eq(accountMembers.userId, input.userId)))
    .where(and(
      eq(accountSecretResources.accountId, input.accountId),
      eq(accountSecretResources.providerId, input.providerId),
      eq(accountSecretResources.name, input.name),
      eq(accountSecretResources.consumer, 'llm_gateway'),
      eq(accountSecretResources.active, true),
      inArray(accountSecretResources.secretId, pool.secretIds),
    ));
  const byId = new Map(rows.filter((row) => secretUsableInProject(
    row, input.projectId, personalKeyGranted(row.grantUserId, grantUserId),
  )).map((row) => [row.secretId, row]));
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
    secretId: row.secretId, label: row.label, value: decryptAccountSecret(input.accountId, row.valueEnc),
  })) };
}
