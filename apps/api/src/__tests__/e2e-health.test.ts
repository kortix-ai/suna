/**
 * E2E tests for health, system-status, and 404 endpoints.
 *
 * These tests do NOT require a database — they exercise the pure HTTP
 * handlers that return static / computed JSON.
 */
import { describe, it, expect } from 'bun:test';
import { createTestApp, jsonGet } from './helpers';

const app = createTestApp();

describe('Health & System endpoints', () => {
  // ─── GET /health ────────────────────────────────────────────────────────

  it('GET /health returns 200 with status ok and service name', async () => {
    const res = await jsonGet(app, '/health');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.service).toBe('kortix-api');
    expect(body.timestamp).toBeDefined();
  });

  // ─── GET /v1/health ─────────────────────────────────────────────────────

  it('GET /v1/health returns 200 with status ok', async () => {
    const res = await jsonGet(app, '/v1/health');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.service).toBe('kortix');
    expect(body.timestamp).toBeDefined();
  });

  // ─── GET /v1/system/status ──────────────────────────────────────────────

  it('GET /v1/system/status returns maintenance & technical issue objects', async () => {
    const res = await jsonGet(app, '/v1/system/status');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.maintenanceNotice).toBeDefined();
    expect(typeof body.maintenanceNotice.enabled).toBe('boolean');
    expect(body.technicalIssue).toBeDefined();
    expect(typeof body.technicalIssue.enabled).toBe('boolean');
    expect(body.updatedAt).toBeDefined();
  });

  // ─── 404 ────────────────────────────────────────────────────────────────

  it('Unknown route returns 404 with error body', async () => {
    const res = await jsonGet(app, '/this/does/not/exist');
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.error).toBe(true);
    expect(body.message).toBe('Not found');
    expect(body.status).toBe(404);
  });

  it('Unknown /v1 sub-route returns 404', async () => {
    const res = await jsonGet(app, '/v1/nonexistent-endpoint');
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.error).toBe(true);
    expect(body.status).toBe(404);
  });
});
