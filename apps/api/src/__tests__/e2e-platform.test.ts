/**
 * E2E tests for the platform (sandbox lifecycle) routes.
 *
 * Uses mock providers via DI — no Docker or Daytona needed.
 * Requires TEST_DATABASE_URL + KORTIX_TEST_DB_CONFIRM for sandbox CRUD tests.
 *
 * Routes tested (sandbox-cloud router mounted at /v1/platform/sandbox):
 *   GET    /v1/platform/providers
 *   POST   /v1/platform/init              (ensure — idempotent create-or-return)
 *   GET    /v1/platform/sandbox           (get active)
 *   GET    /v1/platform/sandbox/list      (list all)
 *   POST   /v1/platform/sandbox/stop      (stop active)
 *   POST   /v1/platform/sandbox/restart   (restart active)
 *   DELETE /v1/platform/sandbox           (archive active)
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

describe.skipIf(!HAS_DB)('Platform — Sandbox Lifecycle', () => {
  const dockerProvider = createMockProvider('local_docker');
  const daytonaProvider = createMockProvider('daytona');

  const app = createTestApp({
    dockerProvider,
    daytonaProvider,
    defaultProvider: 'local_docker',
  });

  // Separate app for cross-user isolation tests
  const otherApp = createTestApp({
    userId: OTHER_USER_ID,
    userEmail: OTHER_USER_EMAIL,
    dockerProvider: createMockProvider('local_docker'),
    daytonaProvider: createMockProvider('daytona'),
    defaultProvider: 'local_docker',
  });

  beforeAll(async () => {
    await cleanupTestData();
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  // ─── GET /v1/platform/providers ──────────────────────────────────────────

  describe('GET /v1/platform/providers', () => {
    it('returns available providers and default', async () => {
      const res = await jsonGet(app, '/v1/platform/providers');
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.providers).toBeArray();
      expect(body.data.providers.length).toBeGreaterThanOrEqual(1);
      expect(body.data.default).toBe('local_docker');
    });
  });

  // ─── POST /v1/platform/init ──────────────────────────────────────────────

  describe('POST /v1/platform/init', () => {
    it('creates a sandbox on first call (201, created: true)', async () => {
      const res = await jsonPost(app, '/v1/platform/init', {});
      expect(res.status).toBe(201);

      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.created).toBe(true);
      expect(body.data.sandbox_id).toBeDefined();
      expect(body.data.provider).toBe('local_docker');
      expect(body.data.status).toBe('active');
      expect(body.data.base_url).toBeDefined();

      // Provider should have been called
      expect(dockerProvider.calls.create.length).toBe(1);
    });

    it('returns existing sandbox on second call (200, created: false)', async () => {
      const res = await jsonPost(app, '/v1/platform/init', {});
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.created).toBe(false);
      expect(body.data.sandbox_id).toBeDefined();

      // Provider should NOT have been called again
      expect(dockerProvider.calls.create.length).toBe(1);
    });

    it('uses specific provider when requested', async () => {
      // Archive the existing sandbox first so init creates a new one
      await jsonDelete(app, '/v1/platform/sandbox');

      const res = await jsonPost(app, '/v1/platform/init', {
        provider: 'daytona',
      });
      expect(res.status).toBe(201);

      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.created).toBe(true);
      expect(body.data.provider).toBe('daytona');
      expect(daytonaProvider.calls.create.length).toBe(1);
    });
  });

  // ─── GET /v1/platform/sandbox ────────────────────────────────────────────

  describe('GET /v1/platform/sandbox', () => {
    it('returns the active sandbox', async () => {
      const res = await jsonGet(app, '/v1/platform/sandbox');
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.status).toBe('active');
      expect(body.data.sandbox_id).toBeDefined();
    });

    it('returns 404 when no sandbox exists', async () => {
      // Other user has no sandbox
      const res = await jsonGet(otherApp, '/v1/platform/sandbox');
      expect(res.status).toBe(404);

      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.error).toContain('No sandbox found');
    });
  });

  // ─── GET /v1/platform/sandbox/list ──────────────────────────────────────

  describe('GET /v1/platform/sandbox/list', () => {
    it('returns all sandboxes including archived', async () => {
      const res = await jsonGet(app, '/v1/platform/sandbox/list');
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data).toBeArray();
      // We should have at least 2 (one archived, one active)
      expect(body.data.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ─── POST /v1/platform/sandbox/stop ──────────────────────────────────────

  describe('POST /v1/platform/sandbox/stop', () => {
    it('stops the active sandbox', async () => {
      const res = await jsonPost(app, '/v1/platform/sandbox/stop', {});
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.success).toBe(true);
    });
  });

  // ─── POST /v1/platform/sandbox/restart ────────────────────────────────────

  describe('POST /v1/platform/sandbox/restart', () => {
    it('restarts the sandbox', async () => {
      const res = await jsonPost(app, '/v1/platform/sandbox/restart', {});
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.success).toBe(true);
    });
  });

  // ─── DELETE /v1/platform/sandbox ─────────────────────────────────────────

  describe('DELETE /v1/platform/sandbox', () => {
    it('archives the active sandbox', async () => {
      const res = await jsonDelete(app, '/v1/platform/sandbox');
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.success).toBe(true);

      // Verify it's now archived — GET /sandbox should 404
      const afterRes = await jsonGet(app, '/v1/platform/sandbox');
      expect(afterRes.status).toBe(404);
    });
  });

  // ─── Cross-user isolation ───────────────────────────────────────────────

  describe('Cross-user isolation', () => {
    it("other user cannot see first user's sandboxes", async () => {
      const res = await jsonGet(otherApp, '/v1/platform/sandbox/list');
      expect(res.status).toBe(200);

      const body = await res.json();
      // Other user should have zero sandboxes
      expect(body.data.length).toBe(0);
    });

    it("other user cannot stop first user's sandbox", async () => {
      // Create a sandbox for primary user first
      await jsonPost(app, '/v1/platform/init', {});

      // Other user tries to stop — their account has no active sandbox
      const res = await jsonPost(otherApp, '/v1/platform/sandbox/stop', {});
      expect(res.status).toBe(404);
    });

    it("other user cannot delete first user's sandbox", async () => {
      // Other user tries to delete — their account has no active sandbox
      const res = await jsonDelete(otherApp, '/v1/platform/sandbox');
      expect(res.status).toBe(404);
    });
  });
});
