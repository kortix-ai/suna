import { describe, expect, test } from 'bun:test';
import { parseActualRuntime, UNREPORTED_ACTUAL_RUNTIME } from '../actual';

describe('parseActualRuntime', () => {
  test('a box that predates runtime_truth reports nothing — every field unknown, not a crash', () => {
    expect(parseActualRuntime(undefined)).toEqual(UNREPORTED_ACTUAL_RUNTIME);
    expect(parseActualRuntime(null)).toEqual(UNREPORTED_ACTUAL_RUNTIME);
    expect(parseActualRuntime('garbage')).toEqual(UNREPORTED_ACTUAL_RUNTIME);
    expect(parseActualRuntime(42)).toEqual(UNREPORTED_ACTUAL_RUNTIME);
  });

  test('reads a full document', () => {
    const doc = parseActualRuntime({
      release_id: 'rel_abc',
      catalog_fingerprint: 'cat_1',
      daemon_build: 1787241641,
      cli_sha256: 'a'.repeat(64),
      managed_skills_hash: 'b'.repeat(64),
      components: {
        release_id: { state: 'current', attempted_at: '2026-09-26T00:00:00.000Z', attempts: 1, cause: null },
        cli_sha256: { state: 'blocked', attempted_at: '2026-09-26T00:05:00.000Z', attempts: 4, cause: 'EACCES: permission denied' },
      },
    });
    expect(doc.release_id).toBe('rel_abc');
    expect(doc.catalog_fingerprint).toBe('cat_1');
    expect(doc.daemon_build).toBe(1787241641);
    expect(doc.cli_sha256).toBe('a'.repeat(64));
    expect(doc.managed_skills_hash).toBe('b'.repeat(64));
    expect(doc.components.release_id).toEqual({
      state: 'current',
      attempted_at: '2026-09-26T00:00:00.000Z',
      attempts: 1,
      cause: null,
    });
    expect(doc.components.cli_sha256.state).toBe('blocked');
    expect(doc.components.cli_sha256.cause).toBe('EACCES: permission denied');
  });

  test('daemon_build may be a string; kept as reported', () => {
    const doc = parseActualRuntime({ daemon_build: '1787241641' });
    expect(doc.daemon_build).toBe('1787241641');
  });

  test('an unrecognized component state parses as unknown, never fabricated', () => {
    const doc = parseActualRuntime({ components: { cli_sha256: { state: 'weird' } } });
    expect(doc.components.cli_sha256.state).toBe('unknown');
    expect(doc.components.cli_sha256.attempts).toBe(0);
  });

  test('a negative or non-finite attempts count floors to 0', () => {
    const doc = parseActualRuntime({ components: { x: { state: 'converging', attempts: -3 } } });
    expect(doc.components.x.attempts).toBe(0);
    const doc2 = parseActualRuntime({ components: { x: { state: 'converging', attempts: Number.NaN } } });
    expect(doc2.components.x.attempts).toBe(0);
  });
});
