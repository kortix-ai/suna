import { describe, expect, test } from 'bun:test';
import { buildUpstreamPath } from '../../src/server/upstream-path';

const OWN = '00000000-0000-4000-8000-000000000001';
const VICTIM = '00000000-0000-4000-8000-000000000002';

describe('buildUpstreamPath', () => {
  test('an ordinary path passes through unchanged', () => {
    expect(buildUpstreamPath(['projects', OWN, 'secrets'])).toEqual({
      ok: true,
      path: `projects/${OWN}/secrets`,
    });
  });

  test('THE HOLE: an encoded slash smuggling a traversal is refused', () => {
    // Next decodes `%2F..%2F` into the segment `<own>/../<victim>/secrets`.
    // Joined, the policy sees "a route under <own>" (which the caller owns) and
    // the upstream resolves it to <victim>. This returned 200 with another
    // tenant's secret VALUE before the guard existed.
    const result = buildUpstreamPath(['projects', `${OWN}/../${VICTIM}/secrets`]);
    expect(result.ok).toBe(false);
  });

  test('the traversal-tail variant is refused too', () => {
    expect(buildUpstreamPath(['projects', `${OWN}/../${VICTIM}`, 'secrets']).ok).toBe(false);
  });

  test('escaping the project prefix entirely is refused', () => {
    // `/api/kortix/projects/<own>%2F..%2F..%2Faccounts%2Fme` reached
    // /v1/accounts/me — an account-admin surface the policy blocks outright.
    expect(buildUpstreamPath(['projects', `${OWN}/../../accounts/me`]).ok).toBe(false);
  });

  test('a bare .. segment is refused even without an encoded slash', () => {
    expect(buildUpstreamPath(['projects', OWN, '..', VICTIM, 'secrets']).ok).toBe(false);
    expect(buildUpstreamPath(['projects', '.', OWN]).ok).toBe(false);
  });

  test('a backslash cannot stand in for the slash', () => {
    expect(buildUpstreamPath(['projects', `${OWN}\\..\\${VICTIM}`]).ok).toBe(false);
  });

  test('an empty segment is refused rather than collapsed', () => {
    // `projects//secrets` would let the policy's `[^/]+` capture an empty id.
    expect(buildUpstreamPath(['projects', '', 'secrets']).ok).toBe(false);
  });

  test('a control character is refused', () => {
    expect(buildUpstreamPath(['projects', `${OWN}\u0000`, 'secrets']).ok).toBe(false);
    expect(buildUpstreamPath(['projects', `${OWN}
`, 'secrets']).ok).toBe(false);
  });

  test('a decoded ? # or % is refused: the upstream URL would end or re-decode there', () => {
    // `%3F` decodes to `?`: the policy sees `p/share?/8000/kortix/health`, the upstream `p/share`.
    expect(buildUpstreamPath(['p', 'share?', '8000', 'kortix', 'health']).ok).toBe(false);
    expect(buildUpstreamPath(['p', 'config#', '8000', 'kortix', 'health']).ok).toBe(false);
    // `%252e%252e` decodes to `%2e%2e`, which the URL parser resolves as `..`.
    expect(buildUpstreamPath(['projects', '%2e%2e', 'secrets']).ok).toBe(false);
    expect(buildUpstreamPath(['projects', OWN, '.%2e', 'secrets']).ok).toBe(false);
  });

  test('legitimate paths with dots, dashes and spaces still work', () => {
    // A guard that also breaks ordinary traffic is a worse bug than the hole.
    expect(buildUpstreamPath(['projects', OWN, 'files', 'src', 'index.test.ts']).ok).toBe(true);
    expect(buildUpstreamPath(['p', 'sb_123', '3000', 'index.html']).ok).toBe(true);
    expect(buildUpstreamPath(['projects', OWN, 'secrets', 'MY SECRET']).ok).toBe(true);
    expect(buildUpstreamPath(['projects', OWN, 'files', '.gitignore']).ok).toBe(true);
    expect(buildUpstreamPath(['projects', OWN, 'files', '..hidden']).ok).toBe(true);
  });
});
