/**
 * HTTP-level regression for the listing `kortix tokens ls` renders: the
 * unnarrowed `GET /v1/accounts/tokens` must offer only tokens that can still
 * act. A session token its session revoked on delete (`revokeSessionConnectorTokens`
 * — the session-delete path) used to stay listed, and revoking it answered
 * 404 "token not found or already revoked" — the exact dogfood report this
 * file pins (KRTX-1675). Real route, real auth middleware, real DB:
 * in-process `app.request`, the idiom of integration-agent-scope-http.test.ts.
 */
import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { eq } from 'drizzle-orm';
import { accountMembers, accountTokens, accounts, projects } from '@kortix/db';
import { db } from '../shared/db';
import { app } from '../index';
import { createAccountToken, revokeSessionConnectorTokens } from '../repositories/account-tokens';
import { insertIntoView } from './helpers/compat-views';

const ACCOUNT = crypto.randomUUID();
const ME = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const LIVE_SESSION = crypto.randomUUID();
const DEAD_SESSION = crypto.randomUUID();

let bearer = '';
let liveTokenId = '';
let deadTokenId = '';

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'tokens-listing-http' });
  await db.insert(projects).values({
    projectId: PROJECT,
    accountId: ACCOUNT,
    name: 'p1',
    repoUrl: 'https://example.com/p1.git',
  });
  await insertIntoView(db, accountMembers, [
    { userId: ME, accountId: ACCOUNT, accountRole: 'owner' },
  ]);

  // The credential the request authenticates with: the caller's own PAT.
  const pat = await createAccountToken({ accountId: ACCOUNT, userId: ME, name: 'cli' });
  bearer = `Bearer ${pat.secretKey}`;

  // What the runtime mints per sandbox and injects as KORTIX_TOKEN: one live
  // session, one session the journey deleted. Revocation goes through the
  // production session-delete path, not a hand-written UPDATE.
  await createAccountToken({
    accountId: ACCOUNT,
    userId: ME,
    projectId: PROJECT,
    sessionId: LIVE_SESSION,
    name: 'Connector Session live0001',
    agentGrant: { agent: 'main', connectors: [], permissions: 'all' },
  });
  await createAccountToken({
    accountId: ACCOUNT,
    userId: ME,
    projectId: PROJECT,
    sessionId: DEAD_SESSION,
    name: 'Connector Session dead0002',
    agentGrant: { agent: 'main', connectors: [], permissions: 'all' },
  });
  expect(await revokeSessionConnectorTokens(DEAD_SESSION, ACCOUNT)).toBe(1);

  const rows = await db
    .select({ tokenId: accountTokens.tokenId, sessionId: accountTokens.sessionId })
    .from(accountTokens)
    .where(eq(accountTokens.accountId, ACCOUNT));
  liveTokenId = rows.find((r) => r.sessionId === LIVE_SESSION)!.tokenId;
  deadTokenId = rows.find((r) => r.sessionId === DEAD_SESSION)!.tokenId;
  expect(liveTokenId).toBeTruthy();
  expect(deadTokenId).toBeTruthy();
});

afterAll(async () => {
  // account rows cascade tokens/members/projects.
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

const listTokens = (query = '') =>
  app.request(`/v1/accounts/tokens${query}`, {
    headers: { Authorization: bearer },
  });

describe('GET /v1/accounts/tokens — the listing `kortix tokens ls` renders', () => {
  test('lists the live session token, not the one its session revoked', async () => {
    const r = await listTokens();
    expect(r.status).toBe(200);
    const rows = (await r.json()) as Array<{ token_id: string; status: string }>;
    const ids = rows.map((t) => t.token_id);
    expect(ids).toContain(liveTokenId);
    expect(ids).not.toContain(deadTokenId);
    // No listed row is dead: a revoked row in the payload is the bug.
    expect(rows.some((t) => t.status !== 'active')).toBe(false);
  });

  test('revoking the dead row answers 404 token not found or already revoked', async () => {
    const r = await app.request(`/v1/accounts/tokens/${deadTokenId}`, {
      method: 'DELETE',
      headers: { Authorization: bearer },
    });
    expect(r.status).toBe(404);
    expect(((await r.json()) as { error: string }).error).toBe('token not found or already revoked');
  });

  test('?mine=true still returns only personal keys — unchanged', async () => {
    const r = await listTokens('?mine=true');
    expect(r.status).toBe(200);
    const rows = (await r.json()) as Array<{ token_id: string; name: string }>;
    expect(rows.map((t) => t.name)).toEqual(['cli']);
  });
});
