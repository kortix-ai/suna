import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { accountMembers, accounts, projectBackends, projectMembers, projects } from '@kortix/db';
import { config } from '../config';
import { db } from '../shared/db';
import { app } from '../index';
import { createAccountToken } from '../repositories/account-tokens';
import { insertIntoView } from '../__tests__/helpers/compat-views';
import { encryptProjectSecret } from '../projects/surface';
import { generateBackendAuthKey } from './auth';
import { CONVEX_CLI_VERSION } from './convex-image';

// The backend routes against the real DB, with no Platinum call: the
// credentials and token responses must not be cached (L4), every backend names
// the Convex CLI version that matches it (M8), and a create past the project
// cap answers 409 backend_limit before any machine exists (M3).
const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const MANAGER = crypto.randomUUID();
const RUNNING = crypto.randomUUID();
const ADMIN_KEY = 'synthetic-admin|key';

let secret = '';
let tokenId = '';
const originalPlatinumKey = config.PLATINUM_API_KEY;

beforeAll(async () => {
  // `backends` is available only where Platinum is configured; no call reaches it here.
  config.PLATINUM_API_KEY = 'pt_synthetic_backend_routes';
  await db.execute(sql`alter table kortix.account_tokens add column if not exists agent_grant jsonb`);
  await db.execute(sql`alter table kortix.account_tokens add column if not exists session_id text`);
  await db.execute(sql`alter table kortix.account_tokens add column if not exists service_account_id uuid`);
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'backend-routes-test' });
  await db.insert(projects).values({
    projectId: PROJECT,
    accountId: ACCOUNT,
    name: 'backend-routes-test',
    repoUrl: 'https://example.com/backend-routes.git',
    metadata: { experimental: { backends: true } },
  });
  await insertIntoView(db, accountMembers, { userId: MANAGER, accountId: ACCOUNT, accountRole: 'owner', isSuperAdmin: false });
  await insertIntoView(db, projectMembers, { accountId: ACCOUNT, projectId: PROJECT, userId: MANAGER, projectRole: 'manager' });
  const token = await createAccountToken({ accountId: ACCOUNT, userId: MANAGER, name: 'backend-routes-test' });
  tokenId = token.tokenId;
  secret = token.secretKey;
  await db.insert(projectBackends).values({
    backendId: RUNNING,
    projectId: PROJECT,
    accountId: ACCOUNT,
    name: 'main',
    status: 'running',
    provider: 'platinum',
    externalId: 'sbx-synthetic',
    url: 'https://main.backends.example.test',
    siteUrl: 'https://main-site.backends.example.test',
    adminKeyEnc: encryptProjectSecret(PROJECT, ADMIN_KEY),
    authKeyEnc: encryptProjectSecret(PROJECT, generateBackendAuthKey()),
    cpu: 1,
    memoryGb: 1,
    diskGb: 10,
  });
});

afterAll(async () => {
  config.PLATINUM_API_KEY = originalPlatinumKey;
  await db.execute(sql`delete from kortix.account_tokens where token_id = ${tokenId}`);
  await db.delete(projectBackends).where(eq(projectBackends.accountId, ACCOUNT));
  await db.delete(projects).where(eq(projects.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

const call = (method: string, path: string, body?: unknown) =>
  app.request(`/v1/projects/${PROJECT}/backends${path}`, {
    method,
    headers: { Authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

describe('backend routes', () => {
  test('credentials answer with Cache-Control: no-store and the admin key', async () => {
    const res = await call('GET', `/${RUNNING}/credentials`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect((await res.json()).admin_key).toBe(ADMIN_KEY);
  });

  test('a member token answers with Cache-Control: no-store', async () => {
    const res = await call('POST', `/${RUNNING}/token`, {});
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(typeof (await res.json()).token).toBe('string');
  });

  test('every backend names the matching Convex CLI version', async () => {
    const res = await call('GET', `/${RUNNING}`);
    expect(res.status).toBe(200);
    expect((await res.json()).backend.convex_version).toBe(CONVEX_CLI_VERSION);
    const list = await call('GET', '');
    expect((await list.json()).backends[0].convex_version).toBe(CONVEX_CLI_VERSION);
  });

  test('a create past the project cap answers 409 backend_limit and inserts nothing', async () => {
    await db.insert(projectBackends).values(
      ['second', 'third'].map((name) => ({
        projectId: PROJECT,
        accountId: ACCOUNT,
        name,
        status: 'error',
        provider: 'platinum',
        cpu: 1,
        memoryGb: 1,
        diskGb: 10,
      })),
    );
    const res = await call('POST', '', { name: 'fourth' });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('backend_limit');
    expect(body.error).toContain('at most 3 backends');
    const rows = await db.select().from(projectBackends).where(eq(projectBackends.projectId, PROJECT));
    expect(rows.map((r) => r.name).sort()).toEqual(['main', 'second', 'third']);
  });
});
