// WHETHER A MIRROR READ WAITS FOR GIT.
//
// Measured on dev 2026-09-09, inside readManifestFromRepo on the session-create
// path: a warm mirror costs 3-12 ms, ls-tree and show are free, and a mirror
// past its 60 s TTL costs 462 ms because the caller waits for the fetch. That
// one wait was 92% of POST /v1/projects/:id/sessions (loadProjectAgents 625 ms
// of 675 ms), and sessions arrive minutes apart, so nearly every one paid it.
import { describe, expect, test } from 'bun:test';
import { planMirrorRefresh, type MirrorRefreshInput } from './mirror-refresh-policy';

const plan = (over: Partial<MirrorRefreshInput> = {}) =>
  planMirrorRefresh({ present: true, ageMs: 120_000, ttlMs: 60_000, force: false, backgroundEnabled: true, ...over });

describe('planning a project mirror refresh', () => {
  test('a fresh mirror is served without touching git', () => {
    expect(plan({ ageMs: 0 })).toBe('serve_warm');
    expect(plan({ ageMs: 59_999 })).toBe('serve_warm');
  });

  test('a stale one is served anyway, and refreshed behind the caller', () => {
    expect(plan({ ageMs: 60_000 })).toBe('serve_warm_refresh_behind');
    expect(plan({ ageMs: 10 * 60_000 })).toBe('serve_warm_refresh_behind');
  });

  test('NO mirror always blocks — there is nothing to serve', () => {
    // The one case where "serve what we have" is a lie.
    expect(plan({ present: false })).toBe('block_and_fetch');
    expect(plan({ present: false, ageMs: 0 })).toBe('block_and_fetch');
    expect(plan({ present: false, force: false, backgroundEnabled: true })).toBe('block_and_fetch');
  });

  test('force always blocks — a caller that must see a commit gets the wait', () => {
    // A push webhook or a deploy resolving a SHA is asking about the REMOTE,
    // not about "recently enough".
    expect(plan({ force: true })).toBe('block_and_fetch');
    expect(plan({ force: true, ageMs: 0 })).toBe('block_and_fetch');
  });

  test('with the switch off it is exactly the old behaviour', () => {
    expect(plan({ backgroundEnabled: false, ageMs: 60_000 })).toBe('block_and_fetch');
    expect(plan({ backgroundEnabled: false, ageMs: 0 })).toBe('serve_warm');
    expect(plan({ backgroundEnabled: false, present: false })).toBe('block_and_fetch');
  });

  test('an unreadable age counts as stale, never as fresh', () => {
    // A missing lastRefresh must not be read as "just fetched" — that would
    // serve an arbitrarily old mirror and never refresh it.
    expect(plan({ ageMs: Number.NaN })).toBe('serve_warm_refresh_behind');
    expect(plan({ ageMs: Number.NaN, backgroundEnabled: false })).toBe('block_and_fetch');
  });
});
