/**
 * `diffRuntime` — the ONE place desired and actual are compared (Rule 1). Every
 * later reader (the admission gate, `GET /config`'s `runtime` block) reads
 * this verdict rather than re-comparing the two documents itself.
 */
import { describe, expect, test } from 'bun:test';
import { diffRuntime } from '../diff';
import { UNREPORTED_ACTUAL_RUNTIME, type ActualRuntimeDocument } from '../actual';
import type { DesiredRuntimeDocument } from '../desired';

const DESIRED: DesiredRuntimeDocument = {
  release_id: 'rel_current',
  catalog_fingerprint: 'cat_current',
  daemon_build: 42,
  cli_sha256: 'c'.repeat(64),
  managed_skills_hash: 'm'.repeat(64),
};

function actual(overrides: Partial<ActualRuntimeDocument>): ActualRuntimeDocument {
  return { ...UNREPORTED_ACTUAL_RUNTIME, ...overrides };
}

describe('diffRuntime', () => {
  test('every field matching, box reports current for all → overall current', () => {
    const diff = diffRuntime(DESIRED, actual({ ...DESIRED }));
    expect(diff.overall).toBe('current');
    expect(diff.components.every((c) => c.matches)).toBe(true);
  });

  test('a box that reports nothing at all (predates runtime_truth) is converging, never current — unknown is a diff, not a pass', () => {
    const diff = diffRuntime(DESIRED, UNREPORTED_ACTUAL_RUNTIME);
    expect(diff.overall).toBe('converging');
    expect(diff.components.every((c) => c.state === 'unknown')).toBe(true);
  });

  test('one field behind (a stale catalog fingerprint) → converging, not current', () => {
    const diff = diffRuntime(DESIRED, actual({ ...DESIRED, catalog_fingerprint: 'cat_stale' }));
    expect(diff.overall).toBe('converging');
    const catalog = diff.components.find((c) => c.name === 'catalog_fingerprint');
    expect(catalog?.matches).toBe(false);
    expect(catalog?.desired).toBe('cat_current');
    expect(catalog?.actual).toBe('cat_stale');
  });

  test('any component the box marks blocked makes the whole session blocked', () => {
    const diff = diffRuntime(
      DESIRED,
      actual({
        ...DESIRED,
        cli_sha256: 'stale',
        components: {
          cli_sha256: {
            state: 'blocked',
            attempted_at: '2026-09-26T00:00:00.000Z',
            attempts: 4,
            cause: 'EACCES: permission denied',
          },
        },
      }),
    );
    expect(diff.overall).toBe('blocked');
    const cli = diff.components.find((c) => c.name === 'cli_sha256');
    expect(cli?.state).toBe('blocked');
    expect(cli?.cause).toBe('EACCES: permission denied');
    expect(cli?.attempts).toBe(4);
  });

  test('blocked wins over converging when both are present', () => {
    const diff = diffRuntime(
      DESIRED,
      actual({
        release_id: 'rel_stale',
        components: {
          release_id: { state: 'converging', attempted_at: null, attempts: 1, cause: null },
          managed_skills_hash: {
            state: 'blocked',
            attempted_at: '2026-09-26T00:00:00.000Z',
            attempts: 9,
            cause: 'disk full',
          },
        },
      }),
    );
    expect(diff.overall).toBe('blocked');
  });

  test('the box components map is authoritative over a literal value match', () => {
    // Values agree, but the box itself says it is still converging (e.g. it
    // just started an attempt and has not confirmed yet).
    const diff = diffRuntime(
      DESIRED,
      actual({
        ...DESIRED,
        components: {
          daemon_build: { state: 'converging', attempted_at: '2026-09-26T00:00:00.000Z', attempts: 1, cause: null },
        },
      }),
    );
    const daemon = diff.components.find((c) => c.name === 'daemon_build');
    expect(daemon?.matches).toBe(true);
    expect(daemon?.state).toBe('converging');
    expect(diff.overall).toBe('converging');
  });
});
