// ONE CELL SANDBOX FOR A PROJECT, AND NEVER FOR TWO.
//
// The sandbox is what a session pays for: 2443 ms to make one on dev
// 2026-09-07 (POST 198 ms, row running 1296 ms, expose 141 ms, edge live
// +928 ms) against 194 ms for a session on one that already exists. So the
// host is worth having — and worth being careful about, because it is the one
// thing here that two sessions share.
//
// These claims pin the two properties that make it safe: the name is a
// function of the project and nothing else, so a host can never be found by a
// different project; and it is OFF unless someone turned it on.
import { describe, expect, test } from 'bun:test';

process.env.PLATINUM_API_URL = 'https://api.platinum.dev';
process.env.PLATINUM_API_KEY = 'pt_test';
process.env.KORTIX_URL ??= 'https://api.example.com';
process.env.DATABASE_URL ??= 'postgres://x';

const PLATINUM_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

describe('the host name is the registry', () => {
  test('the same project always resolves to the same host', async () => {
    const { sharedCellHostName } = await import('./cell-host-platinum');
    const a = sharedCellHostName('8781c6ce-0313-4fef-b39a-fffd8dded724');
    const b = sharedCellHostName('8781c6ce-0313-4fef-b39a-fffd8dded724');
    expect(a).toBe(b);
  });

  test('A DIFFERENT PROJECT NEVER DOES — this is the whole tenant story', async () => {
    const { sharedCellHostName } = await import('./cell-host-platinum');
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(sharedCellHostName(`project-${i}`));
    expect(seen.size).toBe(500);
    expect(sharedCellHostName('a')).not.toBe(sharedCellHostName('b'));
  });

  test('every name it can produce is a legal Platinum sandbox name', async () => {
    const { sharedCellHostName } = await import('./cell-host-platinum');
    for (const id of ['a', '', '../etc', 'A'.repeat(300), '8781c6ce-0313-4fef-b39a-fffd8dded724']) {
      const n = sharedCellHostName(id);
      expect(n, n).toMatch(PLATINUM_NAME);
      expect(n.length).toBeLessThanOrEqual(63);
    }
  });

  test('a host is recognisable as one, so a session box is never mistaken for it', async () => {
    const { sharedCellHostName, isSharedCellHostName } = await import('./cell-host-platinum');
    expect(isSharedCellHostName(sharedCellHostName('p1'))).toBe(true);
    expect(isSharedCellHostName('kortix-9a8f94a3-65eb-4a5a-93e9-05d88a289f98-a1')).toBe(false);
    expect(isSharedCellHostName('pi-park-aabbccdd-tok')).toBe(false);
    expect(isSharedCellHostName(null)).toBe(false);
  });
});

describe('adopting a host', () => {
  test('is OFF unless it was turned on — a shared box is a decision, not a default', async () => {
    const { sharedCellHostEnabled, adoptSharedCellHost } = await import('./cell-host-platinum');
    expect(sharedCellHostEnabled()).toBe(false);
    // And it must not even look: a lookup is a Platinum call on the session's
    // critical path, which is exactly what this is meant to remove.
    const realFetch = globalThis.fetch;
    let called = 0;
    globalThis.fetch = (async () => { called += 1; return new Response('[]'); }) as typeof fetch;
    const got = await adoptSharedCellHost('p1');
    globalThis.fetch = realFetch;
    expect(got).toBeNull();
    expect(called).toBe(0);
  });

  test('a session with no project cannot adopt anything', async () => {
    const { adoptSharedCellHost } = await import('./cell-host-platinum');
    expect(await adoptSharedCellHost(null)).toBeNull();
    expect(await adoptSharedCellHost(undefined)).toBeNull();
    expect(await adoptSharedCellHost('')).toBeNull();
  });

  test('the base URL rides the proxy on the CELL port, where the worker listens', async () => {
    const { sharedCellBaseUrl } = await import('./cell-host-platinum');
    expect(sharedCellBaseUrl('sbx_h')).toMatch(/\/v1\/p\/sbx_h\/8080$/);
    expect(sharedCellBaseUrl('sbx_h')).not.toMatch(/\/8000$/);
    expect(sharedCellBaseUrl('sbx_h')).not.toMatch(/\/v1\/v1\//);
  });
});
