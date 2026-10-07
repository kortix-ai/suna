/**
 * Integration test (real local DB) for the two reads behind the token
 * listings: `/settings/tokens` — the page where a person manages THEIR OWN
 * API keys — and the unnarrowed account list `kortix tokens ls` renders.
 *
 * Three different kinds of row live in `account_tokens`: a person's own
 * hand-minted key, a session connector token the runtime mints per sandbox,
 * and a service account's bearer. A personal page must show exactly the
 * first kind, belonging to exactly the person looking at it — so this pins
 * that `listPersonalAccountTokens` filters on the columns that DEFINE the
 * other two (`session_id`, `service_account_id`, `agent_grant`) and on
 * `user_id`, rather than on the `name.startsWith('Connector Session ')`
 * heuristic the browser used to guess with.
 *
 * The unnarrowed list is the revocation surface: every row it lists must be
 * one the revoke endpoint would still accept (`status='active'`,
 * `revoked_at` null), because `kortix tokens ls` → `kortix tokens rm` on a
 * dead row only ever answers "token not found or already revoked".
 */
import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { eq } from 'drizzle-orm';
import { accountMembers, accountTokens, accounts, projects, serviceAccounts } from '@kortix/db';
import { db } from '../shared/db';
import { listAccountTokens, listPersonalAccountTokens } from '../repositories/account-tokens';
import { isTruthyFlag } from '../accounts/core/tokens';
import { insertIntoView } from './helpers/compat-views';

const ACCOUNT = crypto.randomUUID();
const ME = crypto.randomUUID();
const SOMEONE_ELSE = crypto.randomUUID();
const SERVICE_ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();

const MY_KEY = crypto.randomUUID();
const MY_PROJECT_SCOPED_KEY = crypto.randomUUID();
const THEIR_KEY = crypto.randomUUID();
const MY_SESSION_TOKEN = crypto.randomUUID();
/** The row the dogfood journey found (KRTX-1193): the runtime mints a
 *  PROJECT-scoped token per session, so the project CLI-token list used to
 *  show it as an ordinary token of confusing provenance. */
const PROJECT_SESSION_TOKEN = crypto.randomUUID();
const SERVICE_ACCOUNT_BEARER = crypto.randomUUID();
// A session token its session revoked on delete (`revokeSessionConnectorTokens`):
// status='revoked', revoked_at stamped. The dogfood report: `kortix tokens ls`
// still listed it, and revoking it answered 404 "token not found or already
// revoked" — a listed row the revoke endpoint refuses.
const REVOKED_SESSION_TOKEN = crypto.randomUUID();
// The inverse corruption: status still reads 'active' but revoked_at is
// stamped (no DB constraint ties the two columns; the release-gate sweep
// revoked session tokens with a direct UPDATE). `validateAccountToken`
// refuses such a row; the listing must not offer it either.
const ZOMBIE_TOKEN = crypto.randomUUID();

/** The columns every row needs, so each case below shows only its own point. */
const row = (tokenId: string, extra: Partial<typeof accountTokens.$inferInsert>) =>
  ({
    tokenId,
    accountId: ACCOUNT,
    publicKey: `pk_${tokenId.slice(0, 8)}`,
    secretKeyHash: `h_${tokenId.slice(0, 8)}`,
    ...extra,
  }) as typeof accountTokens.$inferInsert;

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'personal-tokens-test' });
  await db.insert(projects).values({
    projectId: PROJECT,
    accountId: ACCOUNT,
    name: 'p1',
    repoUrl: 'https://example.com/p1.git',
  });
  await insertIntoView(db, accountMembers, [
    { userId: ME, accountId: ACCOUNT, accountRole: 'owner' },
    { userId: SOMEONE_ELSE, accountId: ACCOUNT, accountRole: 'member' },
  ]);
  await db.insert(serviceAccounts).values({
    serviceAccountId: SERVICE_ACCOUNT,
    accountId: ACCOUNT,
    name: 'ci',
    publicPrefix: 'kortix_sa_ci…',
    secretHash: 'h_sa',
    createdBy: ME,
  });
  await db.insert(accountTokens).values([
    row(MY_KEY, { userId: ME, name: 'my laptop' }),
    // A human key CAN be project-scoped (the scope picker in the create form),
    // and it is still a personal key — the project binding narrows it, it does
    // not make it machinery.
    row(MY_PROJECT_SCOPED_KEY, {
      userId: ME,
      name: 'my ci key',
      projectId: PROJECT,
    }),
    row(THEIR_KEY, { userId: SOMEONE_ELSE, name: 'their laptop' }),
    // What the runtime mints per sandbox. Named exactly as the old browser
    // heuristic expected, so a filter that still matched on the name would
    // pass this test while a `session_id` filter is what actually holds.
    row(MY_SESSION_TOKEN, {
      userId: ME,
      name: 'Connector Session abcdef12',
      sessionId: crypto.randomUUID(),
      agentGrant: { agent: 'main', connectors: [], permissions: 'all' },
    }),
    row(PROJECT_SESSION_TOKEN, {
      userId: ME,
      projectId: PROJECT,
      name: 'Session deadbeef',
      sessionId: crypto.randomUUID(),
      agentGrant: { agent: 'main', connectors: [], permissions: 'all' },
    }),
    // A service account's bearer: minted under a human's user_id, but it is
    // the automation's identity, not the human's key.
    row(SERVICE_ACCOUNT_BEARER, {
      userId: ME,
      name: 'ci',
      serviceAccountId: SERVICE_ACCOUNT,
    }),
    row(REVOKED_SESSION_TOKEN, {
      userId: ME,
      name: 'Connector Session deadbeef',
      sessionId: crypto.randomUUID(),
      status: 'revoked',
      revokedAt: new Date('2026-01-02T00:00:00.000Z'),
      agentGrant: { agent: 'main', connectors: [], permissions: 'all' },
    }),
    row(ZOMBIE_TOKEN, {
      userId: ME,
      name: 'Connector Session c0ffee1',
      sessionId: crypto.randomUUID(),
      status: 'active',
      revokedAt: new Date('2026-01-03T00:00:00.000Z'),
      agentGrant: { agent: 'main', connectors: [], permissions: 'all' },
    }),
  ]);
});

afterAll(async () => {
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT)); // cascades tokens/members/SAs
});

describe('listPersonalAccountTokens', () => {
  test('returns only the caller’s own hand-minted keys', async () => {
    const ids = (await listPersonalAccountTokens(ACCOUNT, ME)).map((t) => t.tokenId).sort();
    expect(ids).toEqual([MY_KEY, MY_PROJECT_SCOPED_KEY].sort());
  });

  test('never leaks another member’s key', async () => {
    const mine = await listPersonalAccountTokens(ACCOUNT, ME);
    expect(mine.some((t) => t.tokenId === THEIR_KEY)).toBe(false);
    const theirs = await listPersonalAccountTokens(ACCOUNT, SOMEONE_ELSE);
    expect(theirs.map((t) => t.tokenId)).toEqual([THEIR_KEY]);
  });

  test('excludes session connector tokens and service-account bearers', async () => {
    const ids = (await listPersonalAccountTokens(ACCOUNT, ME)).map((t) => t.tokenId);
    expect(ids).not.toContain(MY_SESSION_TOKEN);
    expect(ids).not.toContain(SERVICE_ACCOUNT_BEARER);
  });

  test('the unnarrowed account list returns only the rows that can still act', async () => {
    // The listing feeds `kortix tokens ls` → `tokens rm`: a listed row the
    // revoke endpoint answers "token not found or already revoked" on is the
    // bug this file pins. Live rows only — exactly what
    // `validateAccountToken` accepts (status='active', revoked_at null).
    const ids = (await listAccountTokens(ACCOUNT)).map((t) => t.tokenId).sort();
    expect(ids).toEqual(
      [
        MY_KEY,
        MY_PROJECT_SCOPED_KEY,
        THEIR_KEY,
        MY_SESSION_TOKEN,
        PROJECT_SESSION_TOKEN,
        SERVICE_ACCOUNT_BEARER,
      ].sort(),
    );
    expect(ids).not.toContain(REVOKED_SESSION_TOKEN);
    expect(ids).not.toContain(ZOMBIE_TOKEN);
  });

  test('the project list carries the session_id discriminator key-list surfaces filter on', async () => {
    const rows = await listAccountTokens(ACCOUNT, PROJECT);
    const byId = new Map(rows.map((t) => [t.tokenId, t]));
    // A hand-minted, project-scoped key: a CLI token a person manages.
    expect(byId.get(MY_PROJECT_SCOPED_KEY)?.sessionId).toBeNull();
    // The runtime's per-session KORTIX_TOKEN, scoped to the same project —
    // what GET /projects/:id/cli-token hides (and reports as `session_tokens`).
    expect(byId.get(PROJECT_SESSION_TOKEN)?.sessionId).toEqual(
      expect.any(String),
    );
  });
});

describe('isTruthyFlag — how `?mine` is read', () => {
  test('a bare flag, "true" and "1" all narrow the list', () => {
    expect(isTruthyFlag('')).toBe(true);
    expect(isTruthyFlag('true')).toBe(true);
    expect(isTruthyFlag('1')).toBe(true);
  });

  test('absent, "false" and anything else leave the list unnarrowed', () => {
    expect(isTruthyFlag(undefined)).toBe(false);
    expect(isTruthyFlag('false')).toBe(false);
    expect(isTruthyFlag('0')).toBe(false);
    expect(isTruthyFlag('yes')).toBe(false);
  });
});
