import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
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
export async function listGrantedGatewaySecretNames(accountId: string, userId: string): Promise<string[]> {
  const rows = await db.select({ name: accountSecretResources.name }).from(accountSecretResources)
    .innerJoin(accountSecretGrants, and(eq(accountSecretGrants.secretId, accountSecretResources.secretId), eq(accountSecretGrants.accountId, accountSecretResources.accountId)))
    .innerJoin(accountMembers, and(eq(accountMembers.accountId, accountSecretGrants.accountId), eq(accountMembers.userId, accountSecretGrants.userId)))
    .where(and(
      eq(accountSecretResources.accountId, accountId),
      eq(accountSecretResources.consumer, 'llm_gateway'),
      eq(accountSecretResources.active, true),
      eq(accountSecretGrants.userId, userId),
    ));
  return [...new Set(rows.map((row) => row.name))];
}

/** An unconfigured session uses the caller's newest personal ChatGPT connection. */
export async function resolveDefaultCodexAccountSecret(accountId: string, userId: string): Promise<{
  secretId: string; label: string; value: string;
} | null> {
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
    ))
    .orderBy(desc(accountSecretResources.createdAt), desc(accountSecretResources.secretId))
    .limit(1);
  return row ? { secretId: row.secretId, label: row.label, value: decryptAccountSecret(accountId, row.valueEnc) } : null;
}

/** Resolve at use time so grant revocation and deletion affect the next call. */
export async function resolveSessionProviderSecrets(input: {
  accountId: string;
  userId: string;
  providerId: string;
  name: string;
  advanceIndex?: boolean;
} & ({ sessionId: string; secretIds?: never } | { secretIds: string[]; sessionId?: never })): Promise<{ configured: boolean; coolingDown: boolean; retryAfterSeconds?: number; secrets: { secretId: string; label: string; value: string }[] }> {
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
  const rows = await db.select({
    secretId: accountSecretResources.secretId,
    label: accountSecretResources.label,
    valueEnc: accountSecretResources.valueEnc,
    cooldownUntil: accountSecretResources.cooldownUntil,
  }).from(accountSecretResources)
    .innerJoin(accountSecretGrants, and(eq(accountSecretGrants.secretId, accountSecretResources.secretId), eq(accountSecretGrants.accountId, accountSecretResources.accountId)))
    .innerJoin(accountMembers, and(eq(accountMembers.accountId, accountSecretGrants.accountId), eq(accountMembers.userId, accountSecretGrants.userId)))
    .where(and(
      eq(accountSecretResources.accountId, input.accountId),
      eq(accountSecretResources.providerId, input.providerId),
      eq(accountSecretResources.name, input.name),
      eq(accountSecretResources.consumer, 'llm_gateway'),
      eq(accountSecretResources.active, true),
      eq(accountSecretGrants.userId, input.userId),
      inArray(accountSecretResources.secretId, pool.secretIds),
    ));
  const byId = new Map(rows.map((row) => [row.secretId, row]));
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
