/**
 * E2E tests for health and 404 endpoints.
 *
 * These tests do NOT require a database — they exercise the pure HTTP
 * handlers that return static / computed JSON.
 */
import { describe, it, expect } from 'bun:test';
import api from '../index';

async function request(path: string): Promise<Response> {
  const res = await api.fetch(new Request(`http://local.test${path}`), undefined as any);
  if (!res) throw new Error(`No HTTP response for ${path}`);
  return res;
}

describe('Health & System endpoints', () => {
  // ─── GET /health ────────────────────────────────────────────────────────

  it('GET /health returns 200 with status ok and service name', async () => {
    const res = await request('/health');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.service).toBe('kortix-api');
    expect(body.timestamp).toBeDefined();
  });

  // ─── GET /v1/health ─────────────────────────────────────────────────────

  it('GET /v1/health returns 200 with status ok', async () => {
    const res = await request('/v1/health');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.service).toBe('kortix-api');
    expect(body.timestamp).toBeDefined();
  });

  // ─── 404 ────────────────────────────────────────────────────────────────

  it('Unknown route returns 404 with error body', async () => {
    const res = await request('/this/does/not/exist');
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.error).toBe(true);
    expect(body.message).toBe('Not found');
    expect(body.status).toBe(404);
  });

  it('Unknown /v1 sub-route returns 404', async () => {
    const res = await request('/v1/nonexistent-endpoint');
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.error).toBe(true);
    expect(body.status).toBe(404);
  });
});
