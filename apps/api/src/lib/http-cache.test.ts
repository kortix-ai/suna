import { describe, expect, test } from 'bun:test';

import { computeEtag, etagMatches } from './http-cache';

describe('computeEtag', () => {
  test('is stable for the same payload', () => {
    const payload = { level: 'none', title: '', updatedAt: '2026-01-01T00:00:00.000Z' };
    expect(computeEtag(payload)).toBe(computeEtag({ ...payload }));
  });

  test('changes when the maintenance level flips', () => {
    const off = { level: 'none', title: '', updatedAt: '2026-01-01T00:00:00.000Z' };
    const on = { level: 'full', title: '', updatedAt: '2026-01-01T00:00:00.000Z' };
    expect(computeEtag(off)).not.toBe(computeEtag(on));
  });

  test('is a quoted value, per the ETag header grammar', () => {
    const etag = computeEtag({ a: 1 });
    expect(etag.startsWith('"')).toBe(true);
    expect(etag.endsWith('"')).toBe(true);
  });
});

describe('etagMatches', () => {
  const etag = computeEtag({ level: 'none' });

  test('matches an exact If-None-Match value', () => {
    expect(etagMatches(etag, etag)).toBe(true);
  });

  test('matches one entry in a comma-separated list', () => {
    expect(etagMatches(`"stale-one", ${etag}, "stale-two"`, etag)).toBe(true);
  });

  test('matches a weak validator prefix', () => {
    expect(etagMatches(`W/${etag}`, etag)).toBe(true);
  });

  test('matches the * wildcard', () => {
    expect(etagMatches('*', etag)).toBe(true);
  });

  test('does not match a different etag', () => {
    expect(etagMatches(computeEtag({ level: 'full' }), etag)).toBe(false);
  });

  test('does not match a missing header', () => {
    expect(etagMatches(undefined, etag)).toBe(false);
    expect(etagMatches(null, etag)).toBe(false);
  });
});
