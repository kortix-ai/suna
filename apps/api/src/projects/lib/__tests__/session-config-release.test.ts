import { describe, expect, test } from 'bun:test';
import {
  hasConfigReleaseCapability,
  isReleaseStale,
  parseConvergeResponse,
  parseDaemonConfigReport,
  toSessionConfigRelease,
} from '../session-config-release';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

describe('hasConfigReleaseCapability', () => {
  test('only an array that lists config.release.v1', () => {
    expect(hasConfigReleaseCapability(['file.import', 'config.release.v1'])).toBe(true);
    expect(hasConfigReleaseCapability(['file.import'])).toBe(false);
    expect(hasConfigReleaseCapability(undefined)).toBe(false);
    expect(hasConfigReleaseCapability('config.release.v1')).toBe(false);
  });
});

describe('parseDaemonConfigReport', () => {
  test('reads the health block, and a pre-convergence null mode stays null', () => {
    expect(
      parseDaemonConfigReport({
        release_id: A,
        desired_release_id: B,
        source: 'release',
        mode: null,
        proven: true,
        fallback_reason: null,
        failed_release_id: B,
      }),
    ).toEqual({
      release_id: A,
      desired_release_id: B,
      source: 'release',
      mode: null,
      proven: true,
      fallback_reason: null,
      failed_release_id: B,
    });
  });

  test('junk IDs read as null; a non-object is null', () => {
    const parsed = parseDaemonConfigReport({ release_id: 'x', failed_release_id: 42, source: 'nope', proven: 'yes' });
    expect(parsed).toMatchObject({ release_id: null, failed_release_id: null, source: 'image-default', proven: false });
    expect(parseDaemonConfigReport(null)).toBeNull();
    expect(parseDaemonConfigReport([])).toBeNull();
  });
});

describe('parseConvergeResponse', () => {
  test('reads ok false with a top-level reason, and rejects an unknown outcome', () => {
    const body = {
      ok: false,
      outcome: 'declined',
      config: { release_id: A, desired_release_id: B, source: 'release', mode: 'follow-base', proven: true, fallback_reason: 'x', failed_release_id: B },
      reload: null,
      reason: 'GET /agent lacks the default agent',
    };
    expect(parseConvergeResponse(body)).toMatchObject({ ok: false, outcome: 'declined', reason: 'GET /agent lacks the default agent' });
    expect(parseConvergeResponse({ ...body, outcome: 'maybe' })).toBeNull();
    expect(parseConvergeResponse({ ...body, config: null })).toBeNull();
  });
});

describe('toSessionConfigRelease and isReleaseStale', () => {
  const report = {
    release_id: A,
    desired_release_id: A,
    source: 'release' as const,
    mode: null,
    proven: true,
    fallback_reason: null,
    failed_release_id: null,
  };

  test('a null mode reports follow-base; the API desired ID overrides the daemon copy', () => {
    const release = toSessionConfigRelease(report, B);
    expect(release).toEqual({
      mode: 'follow-base',
      source: 'release',
      running_release_id: A,
      desired_release_id: B,
      proven: true,
      fallback_reason: null,
      failed_release_id: null,
    });
    expect(isReleaseStale(release, true)).toBe(true);
    expect(isReleaseStale(toSessionConfigRelease(report, A), true)).toBe(false);
  });

  test('an unknown desired release is null, never false', () => {
    expect(isReleaseStale(toSessionConfigRelease(report, null), false)).toBeNull();
    expect(isReleaseStale(toSessionConfigRelease({ ...report, release_id: null }, null), true)).toBeNull();
  });

  test('a box running nothing while a release is desired is stale', () => {
    expect(isReleaseStale(toSessionConfigRelease({ ...report, release_id: null }, A), true)).toBe(true);
  });
});
