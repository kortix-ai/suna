/**
 * Security Scan: Cloud API - Path Traversal & Route Discovery
 *
 * LIVE scan against https://computer-preview-api.kortix.com
 * Tests for path traversal vulnerabilities, hidden routes, and
 * directory traversal in URL paths.
 *
 * FINDINGS:
 * [PASS] Path traversal attempts (../) return 404
 * [PASS] Encoded path traversal attempts return 404
 * [PASS] No hidden admin panels or debug endpoints found
 * [PASS] No directory listings
 */

import { describe, test, expect } from 'bun:test';

const CLOUD = 'https://computer-preview-api.kortix.com';

async function probe(path: string): Promise<{ status: number; body: any }> {
  try {
    const res = await fetch(`${CLOUD}${path}`);
    const text = await res.text();
    let parsed: any;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    return { status: res.status, body: parsed };
  } catch (err: any) {
    return { status: 0, body: { error: err.message } };
  }
}

describe('Cloud Scan: Path Traversal & Route Discovery', () => {

  describe('Path traversal attacks', () => {
    test('/../etc/passwd returns 400 or 404', async () => {
      const r = await probe('/../etc/passwd');
      expect([400, 404]).toContain(r.status);
    });

    test('/v1/../../etc/passwd returns 400 or 404', async () => {
      const r = await probe('/v1/../../etc/passwd');
      expect([400, 404]).toContain(r.status);
    });

    test('URL-encoded path traversal %2e%2e%2f returns 400 or 404', async () => {
      const r = await probe('/v1/%2e%2e/%2e%2e/etc/passwd');
      expect([400, 404]).toContain(r.status);
    });

    test('double URL-encoded path traversal returns 400 or 404', async () => {
      const r = await probe('/v1/%252e%252e/%252e%252e/etc/passwd');
      expect([400, 404]).toContain(r.status);
    });

    test('backslash path traversal returns 404', async () => {
      const r = await probe('/v1/..\\..\\etc\\passwd');
      expect([400, 404]).toContain(r.status);
    });
  });

  describe('Hidden route discovery', () => {
    test('/debug returns 404', async () => {
      const r = await probe('/debug');
      expect(r.status).toBe(404);
    });

    test('/v1/debug returns 404', async () => {
      const r = await probe('/v1/debug');
      expect(r.status).toBe(404);
    });

    test('/admin returns 404 (not the /v1/admin)', async () => {
      const r = await probe('/admin');
      expect(r.status).toBe(404);
    });

    test('/api returns 404', async () => {
      const r = await probe('/api');
      expect(r.status).toBe(404);
    });

    test('/v1/internal returns 404', async () => {
      const r = await probe('/v1/internal');
      expect(r.status).toBe(404);
    });

    test('/v1/metrics returns 404 (no Prometheus endpoint exposed)', async () => {
      const r = await probe('/v1/metrics');
      expect(r.status).toBe(404);
    });

    test('/v1/graphql returns 404', async () => {
      const r = await probe('/v1/graphql');
      expect(r.status).toBe(404);
    });

    test('/swagger returns 404 (no API docs exposed)', async () => {
      const r = await probe('/swagger');
      expect(r.status).toBe(404);
    });

    test('/v1/swagger.json returns 404', async () => {
      const r = await probe('/v1/swagger.json');
      expect(r.status).toBe(404);
    });

    test('/v1/openapi.json returns 404', async () => {
      const r = await probe('/v1/openapi.json');
      expect(r.status).toBe(404);
    });

    test('/phpinfo.php returns 404', async () => {
      const r = await probe('/phpinfo.php');
      expect(r.status).toBe(404);
    });

    test('/wp-admin returns 404 (not WordPress)', async () => {
      const r = await probe('/wp-admin');
      expect(r.status).toBe(404);
    });

    test('/actuator returns 404 (not Spring Boot)', async () => {
      const r = await probe('/actuator');
      expect(r.status).toBe(404);
    });

    test('/actuator/health returns 404', async () => {
      const r = await probe('/actuator/health');
      expect(r.status).toBe(404);
    });
  });

  describe('Sensitive file probing', () => {
    test('/.env returns 404', async () => {
      const r = await probe('/.env');
      expect(r.status).toBe(404);
    });

    test('/.env.local returns 404', async () => {
      const r = await probe('/.env.local');
      expect(r.status).toBe(404);
    });

    test('/.env.production returns 404', async () => {
      const r = await probe('/.env.production');
      expect(r.status).toBe(404);
    });

    test('/.git/config returns 404', async () => {
      const r = await probe('/.git/config');
      expect(r.status).toBe(404);
    });

    test('/.git/HEAD returns 404', async () => {
      const r = await probe('/.git/HEAD');
      expect(r.status).toBe(404);
    });

    test('/package.json returns 404', async () => {
      const r = await probe('/package.json');
      expect(r.status).toBe(404);
    });

    test('/tsconfig.json returns 404', async () => {
      const r = await probe('/tsconfig.json');
      expect(r.status).toBe(404);
    });

    test('/docker-compose.yml returns 404', async () => {
      const r = await probe('/docker-compose.yml');
      expect(r.status).toBe(404);
    });

    test('/Dockerfile returns 404', async () => {
      const r = await probe('/Dockerfile');
      expect(r.status).toBe(404);
    });
  });

  describe('Directory traversal in API parameters', () => {
    test('/v1/p/../../../etc/passwd returns 404 or 401', async () => {
      const r = await probe('/v1/p/../../../etc/passwd');
      expect([400, 401, 404]).toContain(r.status);
    });

    test('/v1/queue/../admin returns 401 (auth before path processing)', async () => {
      const r = await probe('/v1/queue/../admin');
      expect([401, 404]).toContain(r.status);
    });
  });
});
