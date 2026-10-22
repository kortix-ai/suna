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
    managed_model_ids: ['deepseek-v4.1-flash', 'glm-5.3-flash', 'kimi-k3'],
    managed_catalog_fallback_reason: null,
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
      managed_model_ids: ['deepseek-v4.1-flash', 'glm-5.3-flash', 'kimi-k3'],
      managed_catalog_fallback_reason: null,
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
      managed_model_ids: null,
      managed_catalog_fallback_reason: null,
    });
  });

  // 2026-09-26: a real dev box woken that day still served the 2026-08-10
  // managed lineup — the incident this field exists to make visible.
  test('the fallback reason surfaces when a box could not confirm the live lineup', () => {
    const report = parseDaemonRuntimeReport({
      build: 1,
      components: {},
      agentSwapPending: false,
      pinned: false,
      running: {
        managed_model_ids: null,
        managed_catalog_fallback_reason:
          'servable models unavailable at https://gw.kortix.test/v1/models?scope=picker; running the baked/bundled managed lineup',
      },
    });
    expect(report?.running?.managed_model_ids).toBeNull();
    expect(report?.running?.managed_catalog_fallback_reason).toContain('servable models unavailable');
  });

  test('a malformed managed_model_ids array is filtered rather than trusted whole', () => {
    const report = parseDaemonRuntimeReport({
      build: 1,
      components: {},
      agentSwapPending: false,
      pinned: false,
      running: {
        managed_model_ids: ['deepseek-v4.1-flash', 42, '', 'x'.repeat(300), null, 'kimi-k3'],
      },
    });
    expect(report?.running?.managed_model_ids).toEqual(['deepseek-v4.1-flash', 'kimi-k3']);
  });

  test('managed_model_ids that is not an array parses as null, never a throw', () => {
    const report = parseDaemonRuntimeReport({
      build: 1,
      components: {},
      agentSwapPending: false,
      pinned: false,
      running: { managed_model_ids: 'deepseek-v4.1-flash' },
    });
    expect(report?.running?.managed_model_ids).toBeNull();
  });
});

describe('the OpenCode release a W3 daemon reports (E17)', () => {
  const running = (fields: Record<string, unknown>) =>
    parseDaemonRuntimeReport({ ...FULL, running: { ...FULL.running, opencode_version: undefined, ...fields } })?.running
      ?.opencode_version;

  test('an OpenCode box names its harness, and the release is compared', () => {
    expect(running({ harness: 'opencode', harness_version: '1.18.30' })).toBe('1.18.30');
  });

  test('a pi box has no OpenCode to converge, so nothing is compared', () => {
    expect(running({ harness: 'pi', harness_version: 'pi-agent-core@0.85.1', opencode_version: null })).toBeNull();
  });

  test('a pre-W3 daemon names no harness; its opencode_version still counts', () => {
    expect(running({ opencode_version: '1.18.23' })).toBe('1.18.23');
  });
});
