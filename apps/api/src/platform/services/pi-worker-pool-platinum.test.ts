/**
 * The Platinum pool's registry lives in the sandbox NAME, because Platinum has
 * no label or metadata mutation — PATCH /v1/sandboxes/:id renames and nothing
 * else. So the name has to carry both facts a parked box needs (which image it
 * came from, and the token that proves the claimer found it through the pool),
 * survive Platinum's name rules, and stop looking parked the instant a claim
 * renames it. These are the claims that make that safe to rely on.
 */
import { describe, expect, test } from 'bun:test';
import {
  claimUrl,
  claimedBaseUrl,
  newParkToken,
  parkName,
  parkedFromRows,
  parseParkName,
} from './pi-worker-pool-platinum';

const PLATINUM_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

describe('the park name is the registry', () => {
  test('a park name round-trips the image hash and the token', () => {
    const token = newParkToken();
    const name = parkName('AB12CD34EF56', token);
    expect(parseParkName(name)).toEqual({ hash8: 'ab12cd34', token });
  });

  test('every park name Platinum could be asked to create is a legal sandbox name', () => {
    for (let i = 0; i < 50; i++) {
      const name = parkName(Buffer.from(String(i)).toString('hex').padEnd(12, 'f'), newParkToken());
      expect(name, name).toMatch(PLATINUM_NAME);
      expect(name.length).toBeLessThanOrEqual(63);
    }
  });

  test('a name that is not ours is not parsed as parked — the session box name included', () => {
    expect(parseParkName('kortix-8ff21396-449f-4520-a7ac-a780f95a1303-a1')).toBeNull();
    expect(parseParkName('pi-park-')).toBeNull();          // no hash, no token
    expect(parseParkName('pi-park-abc')).toBeNull();       // hash without a token
    expect(parseParkName(null)).toBeNull();
    expect(parseParkName(undefined)).toBeNull();
  });

  test('two tokens minted in a row differ — a park name is not guessable from another box', () => {
    const seen = new Set(Array.from({ length: 200 }, () => newParkToken()));
    expect(seen.size).toBe(200);
  });
});

describe('reading the pool out of a sandbox list', () => {
  const rows = [
    { id: 'sbx_1', name: parkName('aabbccdd1122', 'tok1'), state: 'running', createdAt: '2026-09-06T10:00:00Z' },
    { id: 'sbx_2', name: 'kortix-9a8f94a3-65eb-4a5a-93e9-05d88a289f98-a1', state: 'running', createdAt: '2026-09-06T10:01:00Z' },
    { id: 'sbx_3', name: parkName('aabbccdd1122', 'tok3'), state: 'stopped', created_at: '2026-09-06T09:00:00Z' },
    { id: 'sbx_4', name: null, state: 'running' },
  ];

  test('only park-named rows are the pool, with their hash, token, state and age', () => {
    const parked = parkedFromRows(rows as never);
    expect(parked.map((p) => p.externalId)).toEqual(['sbx_1', 'sbx_3']);
    expect(parked[0]).toMatchObject({ contentHash: 'aabbccdd', parkToken: 'tok1', state: 'running' });
    expect(parked[0].createdAt?.toISOString()).toBe('2026-09-06T10:00:00.000Z');
    // snake_case from the API is read too — the row shape differs by route.
    expect(parked[1].createdAt?.toISOString()).toBe('2026-09-06T09:00:00.000Z');
  });

  test('a session box can never be mistaken for a parked one — that is what makes the rename a de-registration', () => {
    const claimed = { id: 'sbx_1', name: 'kortix-9a8f94a3-65eb-4a5a-93e9-05d88a289f98-a1', state: 'running' };
    expect(parkedFromRows([claimed] as never)).toEqual([]);
  });
});

describe('the URLs a claim uses', () => {
  test('claim and base URLs ride the API\'s own sandbox proxy, with no double /v1', () => {
    expect(claimUrl('sbx_9')).toMatch(/\/v1\/p\/sbx_9\/8000\/kortix\/claim$/);
    expect(claimedBaseUrl('sbx_9')).toMatch(/\/v1\/p\/sbx_9\/8000$/);
    expect(claimUrl('sbx_9')).not.toMatch(/\/v1\/v1\//);
    expect(claimedBaseUrl('sbx_9')).not.toMatch(/\/v1\/v1\//);
    expect(claimUrl('sbx_9').startsWith(claimedBaseUrl('sbx_9'))).toBe(true);
  });
});
