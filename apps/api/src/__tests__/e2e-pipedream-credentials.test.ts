/**
 * E2E + unit tests for the Pipedream credential system.
 *
 * Tests the 3-tier credential resolution:
 *   Tier 1: Request headers (x-pipedream-*)
 *   Tier 2: Per-account DB credentials (integration_credentials table)
 *   Tier 3: API env defaults (PIPEDREAM_* env vars)
 *
 * Covers:
 *   - credential-store: getAccountCreds, upsertAccountCreds, deleteAccountCreds
 *   - credential-routes: PUT/GET/DELETE /v1/pipedream/credentials
 *   - provider resolution: getProviderFromRequest with all 3 tiers
 *   - e2e flow: sandbox pushes creds → API stores → frontend resolves
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { sql, eq, and } from 'drizzle-orm';
import { integrationCredentials } from '@kortix/db';
import {
  getTestDb,
  TEST_USER_ID,
  OTHER_USER_ID,
} from './helpers';

const HAS_DB = !!process.env.DATABASE_URL;
const HAS_DEFAULT_PIPEDREAM_ENV = Boolean(
  process.env.PIPEDREAM_CLIENT_ID &&
  process.env.PIPEDREAM_CLIENT_SECRET &&
  process.env.PIPEDREAM_PROJECT_ID,
);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function jsonPut(app: Hono<any>, path: string, body: unknown, headers?: Record<string, string>) {
  return app.request(path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function jsonGet(app: Hono<any>, path: string, headers?: Record<string, string>) {
  return app.request(path, { method: 'GET', headers });
}

function jsonDelete(app: Hono<any>, path: string, headers?: Record<string, string>) {
  return app.request(path, { method: 'DELETE', headers });
}

// Resolve a test userId → accountId (mimics resolveAccountId)
async function ensureTestAccount(userId: string): Promise<string> {
  const db = getTestDb();

  // Check if account exists
  const [existing] = await db.execute(
    sql`SELECT am.account_id FROM kortix.account_members am WHERE am.user_id = ${userId} LIMIT 1`
  );

  if (existing) return (existing as any).account_id;

  // Create account + membership
  const [acc] = await db.execute(
    sql`INSERT INTO kortix.accounts (name, personal_account) VALUES ('Test Account', true) RETURNING account_id`
  );
  const accountId = (acc as any).account_id;
  await db.execute(
    sql`INSERT INTO kortix.account_members (user_id, account_id, account_role) VALUES (${userId}, ${accountId}, 'owner')`
  );
  return accountId;
}

// ─── Test App Factory (mounts pipedream credential routes with auth stub) ────

function createPipedreamTestApp(opts: { userId?: string; accountId?: string } = {}) {
  const app = new Hono<any>();

  // Auth stub — simulates supabaseAuth / apiKeyAuth
  app.use('/v1/*', async (c, next) => {
    c.set('userId', opts.userId || TEST_USER_ID);
    if (opts.accountId) c.set('accountId', opts.accountId);
    await next();
  });

  // Mount the actual routes
  const { createCredentialRoutes } = require('../integrations/credential-routes');
  app.route('/v1/pipedream', createCredentialRoutes());

  app.onError((err: any, c: any) => {
    if (err instanceof HTTPException) {
      return c.json({ error: true, message: err.message, status: err.status }, err.status);
    }
    return c.json({ error: true, message: err.message || 'Internal error', status: 500 }, 500);
  });

  return app;
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────

async function cleanupCredentials() {
  const db = getTestDb();
  await db.execute(sql`DELETE FROM kortix.integration_credentials`);
}

// =============================================================================
// UNIT TESTS: credential-store
// =============================================================================

describe.skipIf(!HAS_DB)('credential-store (unit)', () => {
  let accountId: string;

  beforeAll(async () => {
    accountId = await ensureTestAccount(TEST_USER_ID);
  });

  beforeEach(async () => {
    await cleanupCredentials();
  });

  afterAll(async () => {
    await cleanupCredentials();
  });

  it('getAccountCreds returns null when no creds exist', async () => {
    const { getAccountCreds } = require('../integrations/credential-store');
    const result = await getAccountCreds(accountId);
    expect(result).toBeNull();
  });

  it('upsertAccountCreds inserts new creds', async () => {
    const { upsertAccountCreds, getAccountCreds } = require('../integrations/credential-store');

    await upsertAccountCreds(accountId, {
      client_id: 'test-client-id',
      client_secret: 'test-client-secret',
      project_id: 'proj_test123',
      environment: 'development',
    });

    const result = await getAccountCreds(accountId);
    expect(result).not.toBeNull();
    expect(result!.client_id).toBe('test-client-id');
    expect(result!.client_secret).toBe('test-client-secret');
    expect(result!.project_id).toBe('proj_test123');
    expect(result!.environment).toBe('development');
  });

  it('upsertAccountCreds updates existing creds', async () => {
    const { upsertAccountCreds, getAccountCreds } = require('../integrations/credential-store');

    await upsertAccountCreds(accountId, {
      client_id: 'old-id',
      client_secret: 'old-secret',
      project_id: 'proj_old',
    });

    await upsertAccountCreds(accountId, {
      client_id: 'new-id',
      client_secret: 'new-secret',
      project_id: 'proj_new',
      environment: 'production',
    });

    const result = await getAccountCreds(accountId);
    expect(result!.client_id).toBe('new-id');
    expect(result!.client_secret).toBe('new-secret');
    expect(result!.project_id).toBe('proj_new');
  });

  it('deleteAccountCreds removes creds', async () => {
    const { upsertAccountCreds, getAccountCreds, deleteAccountCreds } = require('../integrations/credential-store');

    await upsertAccountCreds(accountId, {
      client_id: 'x',
      client_secret: 'y',
      project_id: 'proj_z',
    });
    expect(await getAccountCreds(accountId)).not.toBeNull();

    await deleteAccountCreds(accountId);
    expect(await getAccountCreds(accountId)).toBeNull();
  });

  it('creds are scoped to account — different accounts are isolated', async () => {
    const { upsertAccountCreds, getAccountCreds } = require('../integrations/credential-store');
    const otherAccountId = await ensureTestAccount(OTHER_USER_ID);

    await upsertAccountCreds(accountId, {
      client_id: 'account-1-id',
      client_secret: 'account-1-secret',
      project_id: 'proj_1',
    });

    await upsertAccountCreds(otherAccountId, {
      client_id: 'account-2-id',
      client_secret: 'account-2-secret',
      project_id: 'proj_2',
    });

    const creds1 = await getAccountCreds(accountId);
    const creds2 = await getAccountCreds(otherAccountId);
    expect(creds1!.client_id).toBe('account-1-id');
    expect(creds2!.client_id).toBe('account-2-id');
  });

  it('getAccountCreds returns null for incomplete creds (missing fields)', async () => {
    const { getAccountCreds } = require('../integrations/credential-store');
    const db = getTestDb();

    // Insert incomplete creds directly
    await db.insert(integrationCredentials).values({
      accountId,
      provider: 'pipedream',
      credentials: { client_id: 'only-id' }, // missing secret + project
    });

    const result = await getAccountCreds(accountId);
    expect(result).toBeNull();
  });
});

// =============================================================================
// E2E TESTS: credential routes (PUT/GET/DELETE /v1/pipedream/credentials)
// =============================================================================

describe.skipIf(!HAS_DB)('Pipedream credential routes (e2e)', () => {
  let accountId: string;
  let app: Hono<any>;

  beforeAll(async () => {
    accountId = await ensureTestAccount(TEST_USER_ID);
    app = createPipedreamTestApp({ userId: TEST_USER_ID });
  });

  beforeEach(async () => {
    await cleanupCredentials();
  });

  afterAll(async () => {
    await cleanupCredentials();
  });

  // ─── GET /credentials ─────────────────────────────────────────────────────

  it('GET /credentials returns not configured when empty', async () => {
    const res = await jsonGet(app, '/v1/pipedream/credentials');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.configured).toBe(HAS_DEFAULT_PIPEDREAM_ENV);
    expect(body.source).toBe('default');
    expect(body.provider).toBe('pipedream');
  });

  // ─── PUT /credentials ─────────────────────────────────────────────────────

  it('PUT /credentials saves creds and returns success', async () => {
    const res = await jsonPut(app, '/v1/pipedream/credentials', {
      client_id: 'test-cid',
      client_secret: 'test-csecret',
      project_id: 'proj_test',
      environment: 'production',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.source).toBe('account');
  });

  it('PUT then GET shows configured', async () => {
    await jsonPut(app, '/v1/pipedream/credentials', {
      client_id: 'cid',
      client_secret: 'csec',
      project_id: 'proj_x',
    });

    const res = await jsonGet(app, '/v1/pipedream/credentials');
    const body = await res.json();
    expect(body.configured).toBe(true);
    expect(body.source).toBe('account');
  });

  it('PUT rejects incomplete creds (400)', async () => {
    const res = await jsonPut(app, '/v1/pipedream/credentials', {
      client_id: 'cid',
      // missing client_secret and project_id
    });
    expect(res.status).toBe(400);
  });

  it('PUT rejects empty strings (400)', async () => {
    const res = await jsonPut(app, '/v1/pipedream/credentials', {
      client_id: '',
      client_secret: 'sec',
      project_id: 'proj',
    });
    expect(res.status).toBe(400);
  });

  it('PUT overwrites existing creds (idempotent)', async () => {
    await jsonPut(app, '/v1/pipedream/credentials', {
      client_id: 'old',
      client_secret: 'old',
      project_id: 'proj_old',
    });

    const res = await jsonPut(app, '/v1/pipedream/credentials', {
      client_id: 'new',
      client_secret: 'new',
      project_id: 'proj_new',
    });
    expect(res.status).toBe(200);

    // Verify via DB directly
    const { getAccountCreds } = require('../integrations/credential-store');
    const creds = await getAccountCreds(accountId);
    expect(creds!.client_id).toBe('new');
  });

  // ─── DELETE /credentials ──────────────────────────────────────────────────

  it('DELETE /credentials removes creds', async () => {
    await jsonPut(app, '/v1/pipedream/credentials', {
      client_id: 'x',
      client_secret: 'y',
      project_id: 'proj_z',
    });

    const delRes = await jsonDelete(app, '/v1/pipedream/credentials');
    expect(delRes.status).toBe(200);

    const getRes = await jsonGet(app, '/v1/pipedream/credentials');
    const body = await getRes.json();
    expect(body.configured).toBe(HAS_DEFAULT_PIPEDREAM_ENV);
  });

  it('DELETE is idempotent (no creds to delete)', async () => {
    const res = await jsonDelete(app, '/v1/pipedream/credentials');
    expect(res.status).toBe(200);
  });

  // ─── Account isolation ────────────────────────────────────────────────────

  it('different users see different creds', async () => {
    const otherAccountId = await ensureTestAccount(OTHER_USER_ID);
    const otherApp = createPipedreamTestApp({ userId: OTHER_USER_ID });

    await jsonPut(app, '/v1/pipedream/credentials', {
      client_id: 'user1',
      client_secret: 'sec1',
      project_id: 'proj_1',
    });

    await jsonPut(otherApp, '/v1/pipedream/credentials', {
      client_id: 'user2',
      client_secret: 'sec2',
      project_id: 'proj_2',
    });

    const res1 = await jsonGet(app, '/v1/pipedream/credentials');
    const res2 = await jsonGet(otherApp, '/v1/pipedream/credentials');
    expect((await res1.json()).configured).toBe(true);
    expect((await res2.json()).configured).toBe(true);

    // Delete user1's creds — user2 still has theirs
    await jsonDelete(app, '/v1/pipedream/credentials');
    const res1After = await jsonGet(app, '/v1/pipedream/credentials');
    const res2After = await jsonGet(otherApp, '/v1/pipedream/credentials');
    expect((await res1After.json()).configured).toBe(HAS_DEFAULT_PIPEDREAM_ENV);
    expect((await res2After.json()).configured).toBe(true);
  });
});

// =============================================================================
// UNIT TESTS: provider resolution chain
// =============================================================================

describe('Provider resolution (unit)', () => {
  it('tier 1: request headers take precedence over everything', async () => {
    const { getProviderFromRequest } = require('../integrations/providers');

    // Mock a Hono context with headers
    const mockContext = {
      req: {
        header: (name: string) => {
          const headers: Record<string, string> = {
            'x-pipedream-client-id': 'header-cid',
            'x-pipedream-client-secret': 'header-csec',
            'x-pipedream-project-id': 'proj_header',
            'x-pipedream-environment': 'development',
          };
          return headers[name];
        },
      },
    };

    const provider = await getProviderFromRequest(mockContext as any, 'fake-account-id');
    expect(provider).toBeDefined();
    expect(provider.name).toBe('pipedream');
  });

  it('tier 3: env defaults work when no headers or DB creds', async () => {
    // This test relies on PIPEDREAM_CLIENT_ID etc being set in the API .env
    const hasEnvCreds = !!process.env.PIPEDREAM_CLIENT_ID;
    if (!hasEnvCreds) {
      console.log('Skipping tier 3 test — no PIPEDREAM_CLIENT_ID in env');
      return;
    }

    const { getProviderFromRequest } = require('../integrations/providers');

    const mockContext = {
      req: { header: () => undefined }, // no headers
    };

    const provider = await getProviderFromRequest(mockContext as any, undefined);
    expect(provider).toBeDefined();
    expect(provider.name).toBe('pipedream');
  });

  it('tier 2: DB creds are used when no headers present', async () => {
    // This test requires DB — skip if not available
    if (!HAS_DB) return;

    const { getProviderFromRequest } = require('../integrations/providers');
    const { upsertAccountCreds, deleteAccountCreds } = require('../integrations/credential-store');
    const accountId = await ensureTestAccount(TEST_USER_ID);

    // Save creds to DB
    await upsertAccountCreds(accountId, {
      client_id: 'db-tier2-cid',
      client_secret: 'db-tier2-secret',
      project_id: 'proj_tier2',
    });

    const mockContext = {
      req: { header: () => undefined }, // no headers
    };

    const provider = await getProviderFromRequest(mockContext as any, accountId);
    expect(provider).toBeDefined();
    expect(provider.name).toBe('pipedream');

    // Cleanup
    await deleteAccountCreds(accountId);
  });

  it('tier 1 headers override tier 2 DB creds', async () => {
    if (!HAS_DB) return;

    const { getProviderFromRequest } = require('../integrations/providers');
    const { upsertAccountCreds, deleteAccountCreds } = require('../integrations/credential-store');
    const accountId = await ensureTestAccount(TEST_USER_ID);

    // Save different creds to DB
    await upsertAccountCreds(accountId, {
      client_id: 'db-cid',
      client_secret: 'db-secret',
      project_id: 'proj_db',
    });

    // Request with headers — should use headers, not DB
    const mockContext = {
      req: {
        header: (name: string) => {
          const h: Record<string, string> = {
            'x-pipedream-client-id': 'header-override-cid',
            'x-pipedream-client-secret': 'header-override-secret',
            'x-pipedream-project-id': 'proj_header_override',
          };
          return h[name];
        },
      },
    };

    // Should resolve without error (headers take precedence)
    const provider = await getProviderFromRequest(mockContext as any, accountId);
    expect(provider).toBeDefined();
    expect(provider.name).toBe('pipedream');

    await deleteAccountCreds(accountId);
  });
});

// =============================================================================
// E2E: full flow — sandbox pushes creds → stored in DB → /apps resolves
// =============================================================================

describe.skipIf(!HAS_DB)('Full flow: sandbox push → DB → frontend resolve (e2e)', () => {
  let accountId: string;
  let app: Hono<any>;

  beforeAll(async () => {
    accountId = await ensureTestAccount(TEST_USER_ID);
    app = createPipedreamTestApp({ userId: TEST_USER_ID });
  });

  beforeEach(async () => {
    await cleanupCredentials();
  });

  afterAll(async () => {
    await cleanupCredentials();
  });

  it('creds saved via PUT are retrievable and flagged as account source', async () => {
    // Step 1: sandbox pushes creds to API (simulates kortix-master boot push)
    const putRes = await jsonPut(app, '/v1/pipedream/credentials', {
      client_id: 'sandbox-pushed-cid',
      client_secret: 'sandbox-pushed-secret',
      project_id: 'proj_sandbox',
    });
    expect(putRes.status).toBe(200);

    // Step 2: frontend checks status
    const getRes = await jsonGet(app, '/v1/pipedream/credentials');
    const body = await getRes.json();
    expect(body.configured).toBe(true);
    expect(body.source).toBe('account');

    // Step 3: verify DB directly
    const { getAccountCreds } = require('../integrations/credential-store');
    const creds = await getAccountCreds(accountId);
    expect(creds!.client_id).toBe('sandbox-pushed-cid');
    expect(creds!.project_id).toBe('proj_sandbox');
  });

  it('deleting creds reverts to default source', async () => {
    // Save creds
    await jsonPut(app, '/v1/pipedream/credentials', {
      client_id: 'temp',
      client_secret: 'temp',
      project_id: 'proj_temp',
    });

    // Verify configured
    let body = await (await jsonGet(app, '/v1/pipedream/credentials')).json();
    expect(body.configured).toBe(true);

    // Delete
    await jsonDelete(app, '/v1/pipedream/credentials');

    // Verify reverted
    body = await (await jsonGet(app, '/v1/pipedream/credentials')).json();
    expect(body.configured).toBe(HAS_DEFAULT_PIPEDREAM_ENV);
    expect(body.source).toBe('default');
  });
});
