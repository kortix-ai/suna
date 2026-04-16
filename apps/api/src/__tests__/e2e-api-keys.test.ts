/**
 * E2E tests for the API key management routes (kortix.api_keys).
 *
 * Routes tested (mounted at /v1/platform/api-keys):
 *   POST   /                        → Create a new API key for a sandbox
 *   GET    /?sandbox_id=xxx         → List all API keys for a sandbox
 *   PATCH  /:keyId/revoke           → Revoke an API key
 *   DELETE /:keyId                  → Hard-delete an API key
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import {
  createTestApp,
  createMockProvider,
  cleanupTestData,
  HAS_SAFE_TEST_DB,
  jsonPost,
  jsonGet,
  jsonPatch,
  jsonDelete,
  TEST_USER_ID,
  OTHER_USER_ID,
  OTHER_USER_EMAIL,
} from './helpers';

const HAS_DB = HAS_SAFE_TEST_DB;

describe.skipIf(!HAS_DB)('Platform — API Keys (kortix schema)', () => {
  const app = createTestApp({
    dockerProvider: createMockProvider('local_docker'),
    daytonaProvider: createMockProvider('daytona'),
    defaultProvider: 'local_docker',
  });

  const otherApp = createTestApp({
    userId: OTHER_USER_ID,
    userEmail: OTHER_USER_EMAIL,
    dockerProvider: createMockProvider('local_docker'),
    daytonaProvider: createMockProvider('daytona'),
    defaultProvider: 'local_docker',
  });

  let sandboxId: string;
  let createdKeyId: string;
  let createdSecretKey: string;

  beforeAll(async () => {
    await cleanupTestData();

    // Create a sandbox to scope API keys to
    const res = await jsonPost(app, '/v1/platform/init', {});
    const body = await res.json();
    sandboxId = body.data.sandbox_id;
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  // ─── POST /v1/platform/api-keys ─────────────────────────────────────────

  describe('POST /v1/platform/api-keys', () => {
    it('creates an API key and returns secret ONCE (201)', async () => {
      const res = await jsonPost(app, '/v1/platform/api-keys', {
        sandbox_id: sandboxId,
        title: 'Test Key',
        description: 'Integration test key',
      });
      expect(res.status).toBe(201);

      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.key_id).toBeDefined();
      expect(body.data.public_key).toMatch(/^pk_[A-Za-z0-9]{32}$/);
      expect(body.data.secret_key).toMatch(/^kortix_[A-Za-z0-9]{32}$/);
      expect(body.data.sandbox_id).toBe(sandboxId);
      expect(body.data.title).toBe('Test Key');
      expect(body.data.description).toBe('Integration test key');
      expect(body.data.status).toBe('active');

      // Save for later tests
      createdKeyId = body.data.key_id;
      createdSecretKey = body.data.secret_key;
    });

    it('rejects missing sandbox_id (400)', async () => {
      const res = await jsonPost(app, '/v1/platform/api-keys', {
        title: 'No Sandbox',
      });
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error).toContain('sandbox_id');
    });

    it('rejects missing title (400)', async () => {
      const res = await jsonPost(app, '/v1/platform/api-keys', {
        sandbox_id: sandboxId,
      });
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error).toContain('title');
    });

    it('rejects empty title (400)', async () => {
      const res = await jsonPost(app, '/v1/platform/api-keys', {
        sandbox_id: sandboxId,
        title: '   ',
      });
      expect(res.status).toBe(400);
    });

    it('rejects non-existent sandbox (404)', async () => {
      const res = await jsonPost(app, '/v1/platform/api-keys', {
        sandbox_id: '00000000-0000-0000-0000-000000000000',
        title: 'Ghost Sandbox',
      });
      expect(res.status).toBe(404);
    });

    it('creates key with expiration', async () => {
      const res = await jsonPost(app, '/v1/platform/api-keys', {
        sandbox_id: sandboxId,
        title: 'Expiring Key',
        expires_in_days: 30,
      });
      expect(res.status).toBe(201);

      const body = await res.json();
      expect(body.data.expires_at).toBeDefined();

      // Should be ~30 days from now
      const expiresAt = new Date(body.data.expires_at);
      const daysFromNow = (expiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
      expect(daysFromNow).toBeGreaterThan(29);
      expect(daysFromNow).toBeLessThan(31);
    });
  });

  // ─── GET /v1/platform/api-keys ──────────────────────────────────────────

  describe('GET /v1/platform/api-keys', () => {
    it('lists keys for sandbox (no secrets returned)', async () => {
      const res = await jsonGet(app, `/v1/platform/api-keys?sandbox_id=${sandboxId}`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data).toBeArray();
      expect(body.data.length).toBeGreaterThanOrEqual(2); // Test Key + Expiring Key

      // Verify NO secret_key or secret_key_hash in response
      for (const key of body.data) {
        expect(key.secret_key).toBeUndefined();
        expect(key.secret_key_hash).toBeUndefined();
        expect(key.secretKeyHash).toBeUndefined();
        expect(key.public_key).toBeDefined();
        expect(key.key_id).toBeDefined();
        expect(key.sandbox_id).toBe(sandboxId);
      }
    });

    it('rejects missing sandbox_id param (400)', async () => {
      const res = await jsonGet(app, '/v1/platform/api-keys');
      expect(res.status).toBe(400);
    });

    it('rejects non-existent sandbox (404)', async () => {
      const res = await jsonGet(app, '/v1/platform/api-keys?sandbox_id=00000000-0000-0000-0000-000000000000');
      expect(res.status).toBe(404);
    });
  });

  // ─── PATCH /v1/platform/api-keys/:keyId/revoke ──────────────────────────

  describe('PATCH /v1/platform/api-keys/:keyId/revoke', () => {
    it('revokes an active key', async () => {
      const res = await jsonPatch(app, `/v1/platform/api-keys/${createdKeyId}/revoke`, {});
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.success).toBe(true);

      // Verify it appears as revoked in the list
      const listRes = await jsonGet(app, `/v1/platform/api-keys?sandbox_id=${sandboxId}`);
      const listBody = await listRes.json();
      const revokedKey = listBody.data.find((k: any) => k.key_id === createdKeyId);
      expect(revokedKey.status).toBe('revoked');
    });

    it('returns 404 for already-revoked key', async () => {
      const res = await jsonPatch(app, `/v1/platform/api-keys/${createdKeyId}/revoke`, {});
      expect(res.status).toBe(404);
    });

    it('returns 404 for non-existent key', async () => {
      const res = await jsonPatch(app, '/v1/platform/api-keys/00000000-0000-0000-0000-000000000000/revoke', {});
      expect(res.status).toBe(404);
    });
  });

  // ─── DELETE /v1/platform/api-keys/:keyId ────────────────────────────────

  describe('DELETE /v1/platform/api-keys/:keyId', () => {
    it('hard-deletes a key', async () => {
      const res = await jsonDelete(app, `/v1/platform/api-keys/${createdKeyId}`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.success).toBe(true);

      // Verify gone from list
      const listRes = await jsonGet(app, `/v1/platform/api-keys?sandbox_id=${sandboxId}`);
      const listBody = await listRes.json();
      const gone = listBody.data.find((k: any) => k.key_id === createdKeyId);
      expect(gone).toBeUndefined();
    });

    it('returns 404 for already-deleted key', async () => {
      const res = await jsonDelete(app, `/v1/platform/api-keys/${createdKeyId}`);
      expect(res.status).toBe(404);
    });
  });

  // ─── Cross-user isolation ───────────────────────────────────────────────

  describe('Cross-user isolation', () => {
    it("other user cannot list first user's sandbox keys", async () => {
      const res = await jsonGet(otherApp, `/v1/platform/api-keys?sandbox_id=${sandboxId}`);
      // Should 404 because sandbox belongs to first user
      expect(res.status).toBe(404);
    });

    it("other user cannot create keys for first user's sandbox", async () => {
      const res = await jsonPost(otherApp, '/v1/platform/api-keys', {
        sandbox_id: sandboxId,
        title: 'Sneaky Key',
      });
      expect(res.status).toBe(404);
    });

    it("other user cannot revoke first user's keys", async () => {
      // Create a fresh key to try to revoke
      const createRes = await jsonPost(app, '/v1/platform/api-keys', {
        sandbox_id: sandboxId,
        title: 'Cross-User Test',
      });
      const { data } = await createRes.json();

      // Other user tries to revoke
      const res = await jsonPatch(otherApp, `/v1/platform/api-keys/${data.key_id}/revoke`, {});
      expect(res.status).toBe(404);

      // Clean up
      await jsonDelete(app, `/v1/platform/api-keys/${data.key_id}`);
    });
  });

  // ─── Secret key never leaked ────────────────────────────────────────────

  describe('Secret key security', () => {
    it('secret_key only returned on creation, never on list', async () => {
      // Create
      const createRes = await jsonPost(app, '/v1/platform/api-keys', {
        sandbox_id: sandboxId,
        title: 'Security Test',
      });
      const createBody = await createRes.json();
      expect(createBody.data.secret_key).toMatch(/^kortix_/);

      // List — must NOT contain secret
      const listRes = await jsonGet(app, `/v1/platform/api-keys?sandbox_id=${sandboxId}`);
      const listBody = await listRes.json();
      const found = listBody.data.find((k: any) => k.key_id === createBody.data.key_id);
      expect(found).toBeDefined();
      expect(found.secret_key).toBeUndefined();
      expect(found.secret_key_hash).toBeUndefined();

      // Clean up
      await jsonDelete(app, `/v1/platform/api-keys/${createBody.data.key_id}`);
    });
  });

  // ─── Sandbox archival ─────────────────────────────────────────────────────

  describe('Sandbox archival', () => {
    it('archiving sandbox does NOT cascade-delete keys (soft archive, not hard delete)', async () => {
      // Create a key
      const createRes = await jsonPost(app, '/v1/platform/api-keys', {
        sandbox_id: sandboxId,
        title: 'Archive Test',
      });
      const keyId = (await createRes.json()).data.key_id;
      expect(createRes.status).toBe(201);

      // Archive the sandbox (sets status='archived', row still exists)
      const archiveRes = await jsonDelete(app, '/v1/platform/sandbox');
      expect(archiveRes.status).toBe(200);

      // Key still exists — can be hard-deleted by owner
      const keyDeleteRes = await jsonDelete(app, `/v1/platform/api-keys/${keyId}`);
      expect(keyDeleteRes.status).toBe(200);
    });
  });
});
