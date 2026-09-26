/**
 * `admitSandboxForSession` — the wrapper the placement chokepoint calls. It
 * reads one health body (already-fetched by the caller — this module never
 * dials the box itself, matching the existing `readSandboxConfigState`
 * reuse pattern in turn-start-convergence.ts), composes the desired document,
 * evaluates admission, and on refusal logs ONE structured event naming which
 * check failed. It never throws — a caller that cannot evaluate admission
 * must decide for itself what "cannot tell" means, not have this throw make
 * that decision by accident.
 */
import { describe, expect, test } from 'bun:test';
import { admitSandboxForSession } from '../admit-sandbox';

const desiredDeps = {
  releaseId: async () => 'rel_current',
  desiredRuntime: async () => ({
    release_id: 'rel_current',
    catalog_fingerprint: 'cat_current',
    daemon_build: 100,
    cli_sha256: 'c'.repeat(64),
    managed_skills_hash: 'm'.repeat(64),
  }),
  minDaemonBuild: 50,
};

describe('admitSandboxForSession', () => {
  test('admits a box whose health proves every check', async () => {
    const events: unknown[] = [];
    const verdict = await admitSandboxForSession(
      {
        health: {
          capabilities: ['config.release.v1'],
          runtime_truth: { daemon_build: 100, catalog_fingerprint: 'cat_current' },
        },
      },
      { ...desiredDeps, onRefused: (event) => events.push(event) },
    );
    expect(verdict.admitted).toBe(true);
    expect(events).toHaveLength(0);
  });

  test('refuses a box unreachable for health (never proved anything) and logs the cause', async () => {
    const events: Array<{ failedCheck: string; cause: string }> = [];
    const verdict = await admitSandboxForSession(
      { health: null },
      { ...desiredDeps, onRefused: (event) => events.push(event) },
    );
    expect(verdict.admitted).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0].failedCheck).toBe('config_release_capability');
  });

  test('refuses a box below the floor and logs the exact check name and cause', async () => {
    const events: Array<{ failedCheck: string; cause: string }> = [];
    const verdict = await admitSandboxForSession(
      {
        health: {
          capabilities: ['config.release.v1'],
          runtime_truth: { daemon_build: 1, catalog_fingerprint: 'cat_current' },
        },
      },
      { ...desiredDeps, onRefused: (event) => events.push(event) },
    );
    expect(verdict.admitted).toBe(false);
    expect(events[0].failedCheck).toBe('daemon_build_floor');
    expect(events[0].cause).toContain('1');
  });

  test('a box that predates runtime_truth entirely (no key at all) is refused, not crashed on', async () => {
    const events: unknown[] = [];
    const verdict = await admitSandboxForSession(
      { health: { capabilities: ['config.release.v1'] } },
      { ...desiredDeps, onRefused: (event) => events.push(event) },
    );
    expect(verdict.admitted).toBe(false);
  });
});
