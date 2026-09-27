/**
 * The health `runtime` block, as the API reads it.
 *
 * It was served by the daemon and read by NOBODY — `git grep -n
 * runtimeConvergenceReport -- apps/api` returned nothing, and
 * `readSandboxConfigState` destructured only the config fields. So `pinned:
 * true`, which the daemon re-reads from disk on every health call precisely so a
 * rollback is visible, reached the control plane and was dropped. That box
 * crash-looped an update, will not self-heal, and needs a human.
 */
import { describe, expect, test } from 'bun:test';
import { parseDaemonRuntimeReport } from '../daemon-runtime-report';

const FULL = {
  build: 1787241641,
  at: '2026-09-25T10:00:00.000Z',
  components: { cli: 'current', agent: 'staged' },
  agentSwapPending: true,
  pinned: false,
  running: {
    cli_sha256: 'a'.repeat(64),
    managed_skills_hash: 'b'.repeat(64),
    agent_sha256: 'c'.repeat(64),
    agent_path: '/opt/kortix/agent.current',
    staged_agent_sha256: 'd'.repeat(64),
    opencode_version: '1.18.23',
    build: 1787241641,
  },
};

describe('parseDaemonRuntimeReport', () => {
  test('reads a full report', () => {
    const report = parseDaemonRuntimeReport(FULL);
    expect(report).not.toBeNull();
    expect(report?.build).toBe(1787241641);
    expect(report?.agentSwapPending).toBe(true);
    expect(report?.pinned).toBe(false);
    expect(report?.running).toEqual({
      cli_sha256: 'a'.repeat(64),
      managed_skills_hash: 'b'.repeat(64),
      agent_sha256: 'c'.repeat(64),
      staged_agent_sha256: 'd'.repeat(64),
      opencode_version: '1.18.23',
    });
  });

  test('a daemon that predates the running block still parses — pinned must survive', () => {
    const report = parseDaemonRuntimeReport({
      build: 7,
      at: null,
      components: {},
      agentSwapPending: false,
      pinned: true,
    });
    expect(report?.pinned).toBe(true);
    expect(report?.running).toBeNull();
  });

  test('anything that is not an object is null, never a throw', () => {
    expect(parseDaemonRuntimeReport(undefined)).toBeNull();
    expect(parseDaemonRuntimeReport(null)).toBeNull();
    expect(parseDaemonRuntimeReport('runtime')).toBeNull();
    expect(parseDaemonRuntimeReport([])).toBeNull();
  });

  test('wrong-typed fields degrade to null/false instead of poisoning the read', () => {
    const report = parseDaemonRuntimeReport({
      build: 'nope',
      agentSwapPending: 'yes',
      pinned: 1,
      running: { cli_sha256: 42, opencode_version: '' },
    });
    expect(report?.build).toBeNull();
    expect(report?.agentSwapPending).toBe(false);
    // Only a literal `true` latches the alarm: a truthy-but-wrong value must not
    // page someone, and must not be read as "fine" either — it is simply absent.
    expect(report?.pinned).toBe(false);
    expect(report?.running).toEqual({
      cli_sha256: null,
      managed_skills_hash: null,
      agent_sha256: null,
      staged_agent_sha256: null,
      opencode_version: null,
    });
  });
});
