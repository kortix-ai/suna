// OAuth housekeeping on PostgreSQL: abandoned self-registered clients and
// expired authorization requests are deleted in bounded, idempotent runs.
import { describe, expect, test } from 'bun:test';
import { oauthAccessTokens, oauthAuthorizationRequests, oauthClients, oauthConsents } from '@kortix/db';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../../lib/db';
import { SELF_REGISTERED_DESCRIPTION } from './requests';
import { sweepAbandonedSelfRegisteredClients, sweepExpiredAuthorizationRequests } from './requests';

const confirmed = Boolean(
  process.env.TEST_DATABASE_URL &&
    process.env.KORTIX_TEST_DB_CONFIRM === 'I_UNDERSTAND_THIS_DELETES_TEST_DATA' &&
    process.env.INTERNAL_KORTIX_ENV !== 'prod',
);
const withDb = confirmed ? describe : describe.skip;

const DAY = 24 * 3600 * 1000;
const alive = async (ids: string[]) =>
  (await db.select({ id: oauthClients.clientId }).from(oauthClients).where(inArray(oauthClients.clientId, ids))).map((r) => r.id);

async function client(ageDays: number, description: string | null = SELF_REGISTERED_DESCRIPTION) {
  const [row] = await db
    .insert(oauthClients)
    .values({ clientSecretHash: 'x', name: 'sweep-test', description, clientType: 'public', createdAt: new Date(Date.now() - ageDays * DAY) })
    .returning({ id: oauthClients.clientId });
  return row!.id;
}

withDb('oauth sweeps', () => {
  test('deletes only old self-registered clients with no consent and no token; idempotent; bounded', async () => {
    const stale = await client(8);
    const staleToo = await client(9);
    const fresh = await client(1);
    const withConsent = await client(8);
    const withToken = await client(8);
    const registeredByAccount = await client(8, 'Registered by an account');
    await db.insert(oauthConsents).values({ userId: crypto.randomUUID(), clientId: withConsent, scopes: ['kortix'] });
    await db.insert(oauthAccessTokens).values({
      tokenHash: `sweep-${crypto.randomUUID()}`,
      clientId: withToken,
      userId: crypto.randomUUID(),
      accountId: crypto.randomUUID(),
      expiresAt: new Date(Date.now() - DAY),
    });
    const all = [stale, staleToo, fresh, withConsent, withToken, registeredByAccount];

    // limit 1 deletes exactly one candidate, never a protected row.
    expect(await sweepAbandonedSelfRegisteredClients(new Date(), 1)).toBe(1);
    expect(await sweepAbandonedSelfRegisteredClients(new Date(), 500)).toBeGreaterThanOrEqual(1);
    expect((await alive(all)).sort()).toEqual([fresh, withConsent, withToken, registeredByAccount].sort());
    // A second run finds nothing of ours (concurrent or repeated runs are harmless).
    await sweepAbandonedSelfRegisteredClients();
    expect((await alive(all)).sort()).toEqual([fresh, withConsent, withToken, registeredByAccount].sort());

    await db.delete(oauthClients).where(inArray(oauthClients.clientId, all));
  });

  test('deletes expired authorization requests and keeps live ones', async () => {
    const cid = await client(0);
    const base = { clientId: cid, redirectUri: 'https://app.example.test/cb', scopes: [], codeChallenge: 'c', codeChallengeMethod: 'S256' };
    const [expired] = await db
      .insert(oauthAuthorizationRequests)
      .values({ ...base, requestIdHash: `sweep-${crypto.randomUUID()}`, expiresAt: new Date(Date.now() - 60_000) })
      .returning({ id: oauthAuthorizationRequests.id });
    const [live] = await db
      .insert(oauthAuthorizationRequests)
      .values({ ...base, requestIdHash: `sweep-${crypto.randomUUID()}`, expiresAt: new Date(Date.now() + 5 * 60_000) })
      .returning({ id: oauthAuthorizationRequests.id });
    await sweepExpiredAuthorizationRequests();
    const left = (await db.select({ id: oauthAuthorizationRequests.id }).from(oauthAuthorizationRequests).where(eq(oauthAuthorizationRequests.clientId, cid))).map((r) => r.id);
    expect(left).toEqual([live!.id]);
    expect(left).not.toContain(expired!.id);
    await db.delete(oauthClients).where(eq(oauthClients.clientId, cid));
  });
});
