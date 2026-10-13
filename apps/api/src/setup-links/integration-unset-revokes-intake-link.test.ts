/**
 * `kortix secrets unset` must revoke the secret's outstanding intake links.
 *
 * Setup-link tokens are stateless (value-only AEAD envelopes), so before
 * KRTX-2056 a minted link stayed valid until natural expiry and a submit on it
 * after unset re-created the secret — silent resurrection of exactly what the
 * owner removed. The unset route now records a tombstone for the secret NAME in
 * the delete's transaction, and both public intake routes reject a token whose
 * fields name a secret deleted after the token was minted.
 *
 * Real DB, real routes: the intake submit goes through the public setup-links
 * app and the unset through the authenticated project secrets route (auth
 * mocked, everything else real). A link minted AFTER the unset must still work:
 * "request a secret that does not exist yet" is the feature, not the bug.
 */
import { afterAll, beforeAll, expect, mock, test } from 'bun:test';
import { accounts, projectSecrets, projects } from '@kortix/db';
import { and, eq, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import postgres from 'postgres';
import { db } from '../shared/db';
import { mintSetupLink } from './token';

const propagated: string[] = [];
// Spread the real module: a wholesale stub drops every export another importer
// in the graph needs (the secrets routes also use `syncSessionSecretsToSandbox`).
const realSync = await import('../projects/lib/sandbox-env-sync');
mock.module('../projects/lib/sandbox-env-sync', () => ({
  ...realSync,
  propagateProjectSecretsToActiveSandboxes: async (id: string) => {
    propagated.push(id);
  },
}));

const USER_ID = '11111111-1111-4111-8111-111111111111';
// The unset route authenticates; the intake routes are public. Pass the auth
// gate without touching the real database writes underneath.
const realAccess = await import('../projects/lib/access');
mock.module('../projects/lib/access', () => ({
  ...realAccess,
  loadProjectForUser: async () => ({
    row: { accountId: ACCOUNT_ID, projectId: PROJECT_ID, name: 'unset-revoke test' },
    userId: USER_ID,
  }),
  assertProjectCapability: async () => {},
}));
const realAuth = await import('../middleware/auth');
mock.module('../middleware/auth', () => ({
  ...realAuth,
  supabaseAuth: async (_c: unknown, next: () => Promise<void>) => next(),
}));

const { setupLinksPublicApp } = await import('./public-app');
const { projectsApp } = await import('../projects/lib/app');
const { registerSecretsRoutes } = await import('../projects/routes/secrets');
registerSecretsRoutes();

const ACCOUNT_ID = crypto.randomUUID();
const PROJECT_ID = crypto.randomUUID();
const KEY = 'UNSET_REVOKE_KEY';
const CANCELLED_KEY = 'UNSET_CANCELLED_KEY';
const sql = postgres(process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '', { max: 1 });
let oldToken: string;
let freshToken: string;

function unsetApp() {
  const app = new Hono<{ Variables: { userId: string; authType: string } }>();
  app.use('*', async (c, next) => {
    c.set('userId', USER_ID);
    c.set('authType', 'pat');
    await next();
  });
  app.route('/v1/projects', projectsApp);
  return app;
}

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT_ID, name: 'Unset revokes intake link test' });
  await db.insert(projects).values({
    projectId: PROJECT_ID,
    accountId: ACCOUNT_ID,
    name: 'Unset revokes intake link test',
    repoUrl: 'https://example.test/test.git',
  });
  oldToken = mintSetupLink(PROJECT_ID, { kind: 'secret', fields: [{ name: KEY }], scope: 'runtime', uid: null, sid: null }).token;
});

afterAll(async () => {
  // account → project → secrets/tombstones all cascade.
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT_ID));
  await sql.end();
});

async function sharedRowCount(): Promise<number> {
  return (await db
    .select({ id: projectSecrets.secretId })
    .from(projectSecrets)
    .where(and(eq(projectSecrets.projectId, PROJECT_ID), isNull(projectSecrets.ownerUserId)))).length;
}

async function submit(token: string, value: string): Promise<Response> {
  return setupLinksPublicApp.request(`/secret/${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ values: { [KEY]: value } }),
  });
}

test('unset kills the outstanding link: the page and the submit reject, nothing is re-created', async () => {
  // The journey's happy leg first: the link works while the secret is set.
  expect((await setupLinksPublicApp.request(`/secret/${oldToken}`)).status).toBe(200);
  expect((await submit(oldToken, 'first-value')).status).toBe(200);
  expect(await sharedRowCount()).toBe(1);

  // `kortix secrets unset UNSET_REVOKE_KEY`
  const deleted = await unsetApp().request(`/v1/projects/${PROJECT_ID}/secrets/${KEY}`, { method: 'DELETE' });
  expect(deleted.status).toBe(200);
  expect(await sharedRowCount()).toBe(0);

  const dead = 'This link is no longer valid';
  const page = await setupLinksPublicApp.request(`/secret/${oldToken}`);
  expect(page.status).toBe(409);
  expect(((await page.json()) as { error: string }).error).toContain(dead);

  const resubmit = await submit(oldToken, 'resurrection-attempt');
  expect(resubmit.status).toBe(409);
  const body = (await resubmit.json()) as { error: string };
  expect(body.error).toContain(dead);
  expect(body.error).toContain(KEY);
  // The acceptance core: the old link must NOT re-create the secret.
  expect(await sharedRowCount()).toBe(0);
});

test('unset of a name nobody has filled yet kills its outstanding link too', async () => {
  // The agent cancels a request before the human submits: no row ever
  // existed, but the outstanding link would create the secret on submit.
  const token = mintSetupLink(PROJECT_ID, { kind: 'secret', fields: [{ name: CANCELLED_KEY }], scope: 'runtime', uid: null, sid: null }).token;
  expect((await setupLinksPublicApp.request(`/secret/${token}`)).status).toBe(200);

  const deleted = await unsetApp().request(`/v1/projects/${PROJECT_ID}/secrets/${CANCELLED_KEY}`, { method: 'DELETE' });
  expect(deleted.status).toBe(200);
  expect(await sharedRowCount()).toBe(0);

  const page = await setupLinksPublicApp.request(`/secret/${token}`);
  expect(page.status).toBe(409);
  const resubmit = await setupLinksPublicApp.request(`/secret/${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ values: { [CANCELLED_KEY]: 'cancelled-value' } }),
  });
  expect(resubmit.status).toBe(409);
  expect(await sharedRowCount()).toBe(0);
});

test('a link minted after the unset still works — the request flow is not over-blocked', async () => {
  freshToken = mintSetupLink(PROJECT_ID, { kind: 'secret', fields: [{ name: KEY }], scope: 'runtime', uid: null, sid: null }).token;
  expect((await setupLinksPublicApp.request(`/secret/${freshToken}`)).status).toBe(200);
  expect((await submit(freshToken, 'fresh-value')).status).toBe(200);
  const rows = await db
    .select({ name: projectSecrets.name })
    .from(projectSecrets)
    .where(and(eq(projectSecrets.projectId, PROJECT_ID), isNull(projectSecrets.ownerUserId)));
  expect(rows).toEqual([{ name: KEY }]);
});
