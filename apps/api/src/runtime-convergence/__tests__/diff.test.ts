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

  test('a box that reports nothing at all (predates runtime_truth, or is unreachable) is UNKNOWN, never current and never converging — unknown is a diff, not a pass, and not a claimed attempt either', () => {
    // This is the live "before" shape for the incident this fixes: five
    // `unknown` components, zero attempts, nothing attempted_at. Rolling that
    // up to `converging` told the UI a repair was in progress when nothing
    // had ever been tried.
    const diff = diffRuntime(DESIRED, UNREPORTED_ACTUAL_RUNTIME);
    expect(diff.overall).toBe('unknown');
    expect(diff.overall_reason).toBe('runtime_truth_not_reported');
    expect(diff.components.every((c) => c.state === 'unknown')).toBe(true);
    expect(diff.components.every((c) => c.attempts === 0 && c.attempted_at === null)).toBe(true);
  });

  test('the moment a real attempt is scheduled, the SAME shape legitimately reads converging', () => {
    // A component reporting `converging` with a real attempt count is the
    // daemon-side evidence a repair is actually running — not a value that
    // happens to already match, and not silence. `daemon` is the BOX's key
    // for the `daemon_build` field — see COMPONENT_KEY_BY_FIELD in diff.ts.
    const diff = diffRuntime(
      DESIRED,
      actual({
        components: {
          daemon: { state: 'converging', attempted_at: '2026-09-27T00:00:00.000Z', attempts: 1, cause: null },
        },
      }),
    );
    expect(diff.overall).toBe('converging');
    expect(diff.overall_reason).toBeNull();
  });

  test('once every component reports current, overall is current — not unknown, not converging', () => {
    const diff = diffRuntime(
      DESIRED,
      actual({
        ...DESIRED,
        components: {
          config_release: { state: 'current', attempted_at: '2026-09-27T00:05:00.000Z', attempts: 1, cause: null },
          catalog: { state: 'current', attempted_at: '2026-09-27T00:05:00.000Z', attempts: 1, cause: null },
          daemon: { state: 'current', attempted_at: '2026-09-27T00:05:00.000Z', attempts: 1, cause: null },
          cli: { state: 'current', attempted_at: '2026-09-27T00:05:00.000Z', attempts: 1, cause: null },
          managed_skills: { state: 'current', attempted_at: '2026-09-27T00:05:00.000Z', attempts: 1, cause: null },
        },
      }),
    );
    expect(diff.overall).toBe('current');
    expect(diff.overall_reason).toBeNull();
  });

  test('one field behind (a stale catalog fingerprint) → converging, not current', () => {
    const diff = diffRuntime(DESIRED, actual({ ...DESIRED, catalog_fingerprint: 'cat_stale' }));
    expect(diff.overall).toBe('converging');
    const catalog = diff.components.find((c) => c.name === 'catalog_fingerprint');
    expect(catalog?.matches).toBe(false);
    expect(catalog?.desired).toBe('cat_current');
    expect(catalog?.actual).toBe('cat_stale');
  });

  test('any component the box marks blocked makes the whole session blocked, and the cause reaches the diff', () => {
    const diff = diffRuntime(
      DESIRED,
      actual({
        ...DESIRED,
        cli_sha256: 'stale',
        components: {
          cli: {
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
          config_release: { state: 'converging', attempted_at: null, attempts: 1, cause: null },
          managed_skills: {
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
          daemon: { state: 'converging', attempted_at: '2026-09-26T00:00:00.000Z', attempts: 1, cause: null },
        },
      }),
    );
    const daemon = diff.components.find((c) => c.name === 'daemon_build');
    expect(daemon?.matches).toBe(true);
    expect(daemon?.state).toBe('converging');
    expect(diff.overall).toBe('converging');
  });

  test('THE KEY-NAMING BUG this fixes: a box using its OWN (box-side) component names is read correctly, not silently dropped to a literal-value fallback', () => {
    // Before the fix, `actual.components['daemon_build']` was always
    // undefined (the box writes `daemon`, never `daemon_build`), so this
    // exact shape fell back to a literal compare and reported
    // attempts:0/attempted_at:null/cause:null for a component the box had
    // already retried 4 times with a named cause.
    const diff = diffRuntime(
      DESIRED,
      actual({
        ...DESIRED,
        components: {
          daemon: { state: 'converging', attempted_at: '2026-09-27T00:10:00.000Z', attempts: 4, cause: 'daemon-side reason' },
        },
      }),
    );
    const daemonBuild = diff.components.find((c) => c.name === 'daemon_build');
    expect(daemonBuild?.state).toBe('converging');
    expect(daemonBuild?.attempts).toBe(4);
    expect(daemonBuild?.attempted_at).toBe('2026-09-27T00:10:00.000Z');
    expect(daemonBuild?.cause).toBe('daemon-side reason');
  });

  test('a real post-repair box: everything current, catalog still unknown with a named cause', () => {
    // Reproduced from a live report — no real session/sandbox id. The box's
    // OWN component keys, verbatim: config_release, catalog, daemon, cli,
    // managed_skills.
    const diff = diffRuntime(DESIRED, {
      ...DESIRED,
      components: {
        config_release: { state: 'current', attempted_at: '2026-09-27T20:12:00.000Z', attempts: 1, cause: null },
        catalog: { state: 'unknown', attempted_at: null, attempts: 0, cause: 'opencode has not built a provider config yet' },
        daemon: { state: 'current', attempted_at: '2026-09-27T20:12:00.000Z', attempts: 1, cause: null },
        cli: { state: 'current', attempted_at: '2026-09-27T20:12:00.000Z', attempts: 1, cause: null },
        managed_skills: { state: 'current', attempted_at: '2026-09-27T20:12:00.000Z', attempts: 1, cause: null },
      },
    });
    const catalog = diff.components.find((c) => c.name === 'catalog_fingerprint');
    expect(catalog?.state).toBe('unknown');
    expect(catalog?.cause).toBe('opencode has not built a provider config yet');
    // Not `current` (one component isn't), and not `unknown` either: the
    // OTHER four components carry real, recent attempt evidence, so the box
    // is provably mid-convergence, not silent.
    expect(diff.overall).toBe('converging');
  });
});

/**
 * THE CONTRACT TEST for the key-naming bug: the box's `RUNTIME_TRUTH_COMPONENT_NAMES`
 * (`apps/kortix-sandbox-agent-server/src/services/runtime-assets/runtime-truth.ts`) cannot be imported
 * here (a different, separately-deployed app) — mirrored as a literal so a
 * rename on either side fails HERE instead of silently reintroducing the bug
 * where `actual.components[name]` always misses.
 */
describe('COMPONENT_KEY_BY_FIELD — the box/API name mapping stays total', () => {
  // Keep in sync with apps/kortix-sandbox-agent-server/src/services/runtime-assets/runtime-truth.ts's
  // RUNTIME_TRUTH_COMPONENT_NAMES. That file's own test
  // (runtime-truth.test.ts) asserts ITS report always carries exactly this
  // set; this test asserts the API maps every one of them.
  const BOX_COMPONENT_NAMES = ['config_release', 'catalog', 'daemon', 'cli', 'managed_skills'] as const;
  const API_FIELD_NAMES: Array<keyof DesiredRuntimeDocument> = [
    'release_id',
    'catalog_fingerprint',
    'daemon_build',
    'cli_sha256',
    'managed_skills_hash',
  ];

  test('every API field maps to a real box component name, and every box name is used exactly once', async () => {
    // Import the private map through its only public effect: feed a
    // component report under each box name and confirm diffRuntime finds it
    // for the matching field. This exercises the exact lookup production
    // code takes, not a copy of it.
    for (const boxName of BOX_COMPONENT_NAMES) {
      const diff = diffRuntime(
        DESIRED,
        actual({
          components: { [boxName]: { state: 'blocked', attempted_at: 't', attempts: 1, cause: `probe:${boxName}` } },
        }),
      );
      const matched = diff.components.filter((c) => c.cause === `probe:${boxName}`);
      expect(matched.length).toBe(1); // exactly one API field maps to this box name
    }
    // Every API field produced a match above ⇒ the mapping is total onto
    // BOX_COMPONENT_NAMES. Confirm the reverse: every field is covered.
    const coveredFields = new Set<string>();
    for (const boxName of BOX_COMPONENT_NAMES) {
      const diff = diffRuntime(
        DESIRED,
        actual({ components: { [boxName]: { state: 'blocked', attempted_at: 't', attempts: 1, cause: 'x' } } }),
      );
      const hit = diff.components.find((c) => c.state === 'blocked');
      if (hit) coveredFields.add(hit.name);
    }
    expect([...coveredFields].sort()).toEqual([...API_FIELD_NAMES].sort());
  });
});
