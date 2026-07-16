import { describe, expect, test } from 'bun:test';

import { startCallbackServer } from '../api/browser-auth.ts';

// The `kortix login` browser-callback flow: the dashboard's `/cli/authorize`
// page does a cross-origin `fetch()` (its own origin → this loopback
// listener) with a JSON body, which is a CORS-preflighted request. These
// tests exercise the real HTTP server (not the CLI-side plumbing) to lock in
// its CORS contract — including the Private/Local Network Access preflight
// header some Chrome versions require even for loopback-to-loopback fetches,
// which otherwise fails with the same generic "Failed to fetch" a CORS
// block would produce (see browser-auth.ts's OPTIONS handler comment).

describe('startCallbackServer — CORS contract', () => {
  test('OPTIONS preflight returns 204 with the standard CORS headers', async () => {
    const session = await startCallbackServer();
    try {
      const resp = await fetch(`http://127.0.0.1:${session.port}/callback`, {
        method: 'OPTIONS',
        headers: {
          Origin: 'http://localhost:13737',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'content-type',
        },
      });
      expect(resp.status).toBe(204);
      expect(resp.headers.get('access-control-allow-origin')).toBe('*');
      expect(resp.headers.get('access-control-allow-methods')).toContain('POST');
      expect(resp.headers.get('access-control-allow-headers')?.toLowerCase()).toContain(
        'content-type',
      );
    } finally {
      session.close();
    }
  });

  test('preflight with Access-Control-Request-Private-Network echoes the allow header', async () => {
    const session = await startCallbackServer();
    try {
      const resp = await fetch(`http://127.0.0.1:${session.port}/callback`, {
        method: 'OPTIONS',
        headers: {
          Origin: 'http://localhost:13737',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Private-Network': 'true',
        },
      });
      expect(resp.status).toBe(204);
      expect(resp.headers.get('access-control-allow-private-network')).toBe('true');
    } finally {
      session.close();
    }
  });

  test('preflight without the private-network request header omits the allow header', async () => {
    const session = await startCallbackServer();
    try {
      const resp = await fetch(`http://127.0.0.1:${session.port}/callback`, {
        method: 'OPTIONS',
        headers: { Origin: 'http://localhost:13737' },
      });
      expect(resp.headers.get('access-control-allow-private-network')).toBeNull();
    } finally {
      session.close();
    }
  });

  test('a matching POST resolves awaitToken with the token', async () => {
    const session = await startCallbackServer();
    const resp = await fetch(`http://127.0.0.1:${session.port}/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: session.state, token: 'kortix_pat_abc123' }),
    });
    expect(resp.status).toBe(200);
    const result = await session.awaitToken;
    expect(result.token).toBe('kortix_pat_abc123');
  });

  test('state mismatch is rejected with 403 and does not resolve the token', async () => {
    const session = await startCallbackServer();
    try {
      const resp = await fetch(`http://127.0.0.1:${session.port}/callback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: 'wrong-state', token: 'kortix_pat_abc123' }),
      });
      expect(resp.status).toBe(403);
    } finally {
      session.close();
    }
  });
});
