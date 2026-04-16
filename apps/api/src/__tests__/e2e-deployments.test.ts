/**
 * E2E tests for deployment routes — CRUD, lifecycle, cross-user isolation.
 *
 * Requires TEST_DATABASE_URL + KORTIX_TEST_DB_CONFIRM for DB-backed deployment tests.
 *
 * Freestyle API calls will fail (no real API key in tests) — deployments are
 * created in DB with status 'failed'. This tests the full request/response
 * flow, validation, per-user isolation, and error handling.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import {
  createTestApp,
  createMockProvider,
  cleanupTestData,
  HAS_SAFE_TEST_DB,
  jsonPost,
  jsonGet,
  jsonDelete,
  TEST_USER_ID,
  OTHER_USER_ID,
  OTHER_USER_EMAIL,
} from './helpers';

const HAS_DB = HAS_SAFE_TEST_DB;

describe.skipIf(!HAS_DB)('Deployments — CRUD & Lifecycle (Freestyle-backed)', () => {
  const dockerProvider = createMockProvider('local_docker');

  const app = createTestApp({
    dockerProvider,
    defaultProvider: 'local_docker',
    mountDeployments: true,
  });

  const otherApp = createTestApp({
    userId: OTHER_USER_ID,
    userEmail: OTHER_USER_EMAIL,
    dockerProvider: createMockProvider('local_docker'),
    defaultProvider: 'local_docker',
    mountDeployments: true,
  });

  let deploymentId: string;

  beforeAll(async () => {
    await cleanupTestData();
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  // ─── POST /v1/deployments — Create ──────────────────────────────────────

  describe('POST /v1/deployments', () => {
    it('creates a git deployment (status = failed because no FREESTYLE_API_KEY)', async () => {
      const res = await jsonPost(app, '/v1/deployments', {
        source_type: 'git',
        source_ref: 'https://github.com/example/app.git',
        domains: ['test-app-e2e.style.dev'],
        build: true,
        framework: 'vite',
      });
      expect(res.status).toBe(201);

      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.deploymentId).toBeDefined();
      expect(body.data.accountId).toBe(TEST_USER_ID);
      expect(body.data.sourceType).toBe('git');
      expect(body.data.sourceRef).toBe('https://github.com/example/app.git');
      expect(body.data.framework).toBe('vite');
      expect(body.data.domains).toEqual(['test-app-e2e.style.dev']);
      // Status will be 'failed' because FREESTYLE_API_KEY is not set in test env
      // or the Freestyle API call will fail
      expect(['pending', 'active', 'failed']).toContain(body.data.status);

      deploymentId = body.data.deploymentId;
    });

    it('creates a code deployment with node_modules', async () => {
      const res = await jsonPost(app, '/v1/deployments', {
        source_type: 'code',
        code: 'import express from "express"; const app = express(); app.get("/", (r,s) => s.json({ok:true})); app.listen(3000);',
        node_modules: { express: '^4.18.2' },
        domains: ['code-test-e2e.style.dev'],
      });
      expect(res.status).toBe(201);

      const body = await res.json();
      expect(body.data.sourceType).toBe('code');
    });

    it('creates a files deployment', async () => {
      const res = await jsonPost(app, '/v1/deployments', {
        source_type: 'files',
        files: [
          { path: 'index.js', content: 'console.log("hello")' },
          { path: 'package.json', content: '{"name":"test"}' },
        ],
        entrypoint: 'index.js',
        domains: ['files-test-e2e.style.dev'],
      });
      expect(res.status).toBe(201);

      const body = await res.json();
      expect(body.data.sourceType).toBe('files');
      expect(body.data.entrypoint).toBe('index.js');
    });

    it('creates a tar deployment', async () => {
      const res = await jsonPost(app, '/v1/deployments', {
        source_type: 'tar',
        tar_url: 'https://example.com/app.tar.gz',
        domains: ['tar-test-e2e.style.dev'],
        build: true,
      });
      expect(res.status).toBe(201);

      const body = await res.json();
      expect(body.data.sourceType).toBe('tar');
    });

    it('creates deployment with all optional config fields', async () => {
      const res = await jsonPost(app, '/v1/deployments', {
        source_type: 'git',
        source_ref: 'https://github.com/example/full-config',
        branch: 'develop',
        root_path: './apps/web',
        domains: ['full-config-e2e.style.dev'],
        build: {
          command: 'npm run build',
          outDir: 'dist',
          envVars: { NODE_ENV: 'production' },
        },
        env_vars: { API_KEY: 'secret', DATABASE_URL: 'postgres://...' },
        entrypoint: 'server.js',
        timeout_ms: 30000,
        framework: 'nextjs',
        clean_urls: true,
        headers: [{ source: '^/assets/.*$', headers: [{ key: 'Cache-Control', value: 'max-age=31536000' }] }],
        redirects: [{ source: '^/old$', destination: '/new', permanent: true }],
        network_permissions: [{ action: 'allow', domain: 'api.stripe.com', behavior: 'exact' }],
      });
      expect(res.status).toBe(201);

      const body = await res.json();
      expect(body.data.sourceType).toBe('git');
      expect(body.data.sourceRef).toBe('https://github.com/example/full-config');
      expect(body.data.framework).toBe('nextjs');
      expect(body.data.entrypoint).toBe('server.js');
      expect(body.data.envVars).toEqual({ API_KEY: 'secret', DATABASE_URL: 'postgres://...' });
    });

    // ─── Validation errors ─────────────────────────────────────────────

    it('returns 400 on missing domains', async () => {
      const res = await jsonPost(app, '/v1/deployments', {
        source_type: 'git',
        source_ref: 'https://github.com/example/repo',
      });
      expect(res.status).toBe(400);
    });

    it('returns 400 on empty domains array', async () => {
      const res = await jsonPost(app, '/v1/deployments', {
        source_type: 'git',
        source_ref: 'https://github.com/example/repo',
        domains: [],
      });
      expect(res.status).toBe(400);
    });

    it('returns 400 on missing source_type', async () => {
      const res = await jsonPost(app, '/v1/deployments', {
        domains: ['test.style.dev'],
      });
      expect(res.status).toBe(400);
    });

    it('returns 400 on invalid source_type', async () => {
      const res = await jsonPost(app, '/v1/deployments', {
        source_type: 'invalid',
        domains: ['test.style.dev'],
      });
      expect(res.status).toBe(400);
    });

    it('returns 400 when git source_type is missing source_ref', async () => {
      const res = await jsonPost(app, '/v1/deployments', {
        source_type: 'git',
        domains: ['test.style.dev'],
      });
      expect(res.status).toBe(400);
    });

    it('returns 400 when code source_type is missing code', async () => {
      const res = await jsonPost(app, '/v1/deployments', {
        source_type: 'code',
        domains: ['test.style.dev'],
      });
      expect(res.status).toBe(400);
    });

    it('returns 400 when files source_type is missing files', async () => {
      const res = await jsonPost(app, '/v1/deployments', {
        source_type: 'files',
        domains: ['test.style.dev'],
      });
      expect(res.status).toBe(400);
    });

    it('returns 400 when tar source_type is missing tar_url', async () => {
      const res = await jsonPost(app, '/v1/deployments', {
        source_type: 'tar',
        domains: ['test.style.dev'],
      });
      expect(res.status).toBe(400);
    });
  });

  // ─── GET /v1/deployments — List ─────────────────────────────────────────

  describe('GET /v1/deployments', () => {
    it('returns deployments for the user', async () => {
      const res = await jsonGet(app, '/v1/deployments');
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data).toBeArray();
      expect(body.data.length).toBeGreaterThanOrEqual(4); // created 4+ above
      expect(body.total).toBeGreaterThanOrEqual(4);
      expect(body.limit).toBeDefined();
      expect(body.offset).toBeDefined();
    });

    it('supports pagination', async () => {
      const res = await jsonGet(app, '/v1/deployments?limit=1&offset=0');
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.length).toBe(1);
      expect(body.limit).toBe(1);
      expect(body.offset).toBe(0);
    });

    it('filters by status', async () => {
      const res = await jsonGet(app, '/v1/deployments?status=failed');
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.every((d: any) => d.status === 'failed')).toBe(true);
    });
  });

  // ─── GET /v1/deployments/:id — Get ──────────────────────────────────────

  describe('GET /v1/deployments/:id', () => {
    it('returns deployment details', async () => {
      const res = await jsonGet(app, `/v1/deployments/${deploymentId}`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.deploymentId).toBe(deploymentId);
    });

    it('returns 404 for non-existent deployment', async () => {
      const res = await jsonGet(app, '/v1/deployments/00000000-0000-0000-0000-000000000099');
      expect(res.status).toBe(404);
    });
  });

  // ─── POST /v1/deployments/:id/stop — Stop ──────────────────────────────

  describe('POST /v1/deployments/:id/stop', () => {
    it('stops a deployment (marks as stopped)', async () => {
      const res = await jsonPost(app, `/v1/deployments/${deploymentId}/stop`, {});
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.status).toBe('stopped');
    });

    it('returns 404 for non-existent deployment', async () => {
      const res = await jsonPost(app, '/v1/deployments/00000000-0000-0000-0000-000000000099/stop', {});
      expect(res.status).toBe(404);
    });
  });

  // ─── POST /v1/deployments/:id/redeploy — Redeploy ──────────────────────

  describe('POST /v1/deployments/:id/redeploy', () => {
    it('creates a new deployment with incremented version', async () => {
      const res = await jsonPost(app, `/v1/deployments/${deploymentId}/redeploy`, {});
      expect(res.status).toBe(201);

      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.deploymentId).toBeDefined();
      expect(body.data.deploymentId).not.toBe(deploymentId); // new deployment
      expect(body.data.version).toBe(2); // incremented
      expect(body.data.sourceType).toBe('git'); // same source config
    });

    it('returns 404 for non-existent deployment', async () => {
      const res = await jsonPost(app, '/v1/deployments/00000000-0000-0000-0000-000000000099/redeploy', {});
      expect(res.status).toBe(404);
    });
  });

  // ─── GET /v1/deployments/:id/logs — Logs ────────────────────────────────

  describe('GET /v1/deployments/:id/logs', () => {
    it('returns empty logs when no freestyleId (deployment never reached Freestyle)', async () => {
      const res = await jsonGet(app, `/v1/deployments/${deploymentId}/logs`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.message).toContain('No Freestyle deployment ID');
    });

    it('returns 404 for non-existent deployment', async () => {
      const res = await jsonGet(app, '/v1/deployments/00000000-0000-0000-0000-000000000099/logs');
      expect(res.status).toBe(404);
    });
  });

  // ─── DELETE /v1/deployments/:id — Delete ────────────────────────────────

  describe('DELETE /v1/deployments/:id', () => {
    it('deletes a deployment', async () => {
      const res = await jsonDelete(app, `/v1/deployments/${deploymentId}`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.success).toBe(true);

      // Verify it's gone
      const getRes = await jsonGet(app, `/v1/deployments/${deploymentId}`);
      expect(getRes.status).toBe(404);
    });

    it('returns 404 for non-existent deployment', async () => {
      const res = await jsonDelete(app, '/v1/deployments/00000000-0000-0000-0000-000000000099');
      expect(res.status).toBe(404);
    });
  });

  // ─── Cross-user isolation ───────────────────────────────────────────────

  describe('Cross-user isolation', () => {
    let isolationDeploymentId: string;

    beforeAll(async () => {
      // Create a deployment as the primary user
      const res = await jsonPost(app, '/v1/deployments', {
        source_type: 'code',
        code: 'console.log("isolated")',
        node_modules: {},
        domains: ['isolated-test.style.dev'],
      });
      const body = await res.json();
      isolationDeploymentId = body.data.deploymentId;
    });

    it("other user cannot list first user's deployments", async () => {
      const res = await jsonGet(otherApp, '/v1/deployments');
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.length).toBe(0);
    });

    it("other user cannot get first user's deployment by ID", async () => {
      const res = await jsonGet(otherApp, `/v1/deployments/${isolationDeploymentId}`);
      expect(res.status).toBe(404);
    });

    it("other user cannot stop first user's deployment", async () => {
      const res = await jsonPost(otherApp, `/v1/deployments/${isolationDeploymentId}/stop`, {});
      expect(res.status).toBe(404);
    });

    it("other user cannot redeploy first user's deployment", async () => {
      const res = await jsonPost(otherApp, `/v1/deployments/${isolationDeploymentId}/redeploy`, {});
      expect(res.status).toBe(404);
    });

    it("other user cannot get logs for first user's deployment", async () => {
      const res = await jsonGet(otherApp, `/v1/deployments/${isolationDeploymentId}/logs`);
      expect(res.status).toBe(404);
    });

    it("other user cannot delete first user's deployment", async () => {
      const res = await jsonDelete(otherApp, `/v1/deployments/${isolationDeploymentId}`);
      expect(res.status).toBe(404);
    });
  });

  // ─── Response format ───────────────────────────────────────────────────

  describe('Response format', () => {
    let formatDeploymentId: string;

    beforeAll(async () => {
      const res = await jsonPost(app, '/v1/deployments', {
        source_type: 'git',
        source_ref: 'https://github.com/example/format-test',
        domains: ['format-test.style.dev'],
        build: true,
        env_vars: { KEY1: 'val1' },
        framework: 'vite',
        entrypoint: 'server.js',
      });
      const body = await res.json();
      formatDeploymentId = body.data.deploymentId;
    });

    it('deployment object has all expected fields', async () => {
      const res = await jsonGet(app, `/v1/deployments/${formatDeploymentId}`);
      const body = await res.json();
      const d = body.data;

      expect(d.deploymentId).toBeDefined();
      expect(d.accountId).toBe(TEST_USER_ID);
      expect(d.sourceType).toBe('git');
      expect(d.sourceRef).toBe('https://github.com/example/format-test');
      expect(d.framework).toBe('vite');
      expect(d.domains).toEqual(['format-test.style.dev']);
      expect(d.envVars).toEqual({ KEY1: 'val1' });
      expect(d.entrypoint).toBe('server.js');
      expect(d.version).toBe(1);
      expect(d.createdAt).toBeDefined();
      expect(d.updatedAt).toBeDefined();
      // These may or may not be set depending on Freestyle response
      expect('freestyleId' in d).toBe(true);
      expect('liveUrl' in d).toBe(true);
      expect('status' in d).toBe(true);
      expect('error' in d).toBe(true);
      expect('buildConfig' in d).toBe(true);
      expect('metadata' in d).toBe(true);
    });

    it('list response has pagination fields', async () => {
      const res = await jsonGet(app, '/v1/deployments?limit=2&offset=1');
      const body = await res.json();

      expect(body.success).toBe(true);
      expect(body.data).toBeArray();
      expect(body.limit).toBe(2);
      expect(body.offset).toBe(1);
      expect(typeof body.total).toBe('number');
    });
  });
});
