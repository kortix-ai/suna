/**
 * The capability gate (docs/specs/config-releases.md, "Capability gate").
 *
 * A fake daemon records every request. A daemon that lists
 * `config.release.v1` receives `POST /kortix/config/converge` and no
 * governance push; any other daemon receives only
 * `POST /kortix/refresh?restart=0` and the governance push. No request ever
 * carries `config_dir=1`.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  convergeToReloadResult,
  PREVIOUS_REPOSITORY_REASON,
  reloadDetail,
  reloadNeedsAttention,
  reloadSessionConfig,
  type SessionReloadDeps,
  type SessionReloadResult,
} from '../session-reload';
import type { DaemonConvergeResponse } from '../session-config-release';

const RELEASE_A = 'a'.repeat(64);
const RELEASE_B = 'b'.repeat(64);

const INPUT = {
  projectId: '00000000-0000-4000-8000-000000000001',
  accountId: '00000000-0000-4000-8000-000000000002',
  sessionId: '00000000-0000-4000-8000-000000000003',
  repoUrl: 'https://git.example/p.git',
  defaultBranch: 'main',
  manifestPath: 'kortix.yaml',
  baseRef: 'main',
};

const healthConfig = (overrides: Record<string, unknown> = {}) => ({
  release_id: RELEASE_A,
  desired_release_id: RELEASE_A,
  source: 'release',
  mode: 'follow-base',
  proven: true,
  fallback_reason: null,
  failed_release_id: null,
  ...overrides,
});

function convergeBody(outcome: string, overrides: Record<string, unknown> = {}) {
  return {
    ok: outcome === 'applied' || outcome === 'unchanged',
    outcome,
    config: healthConfig(outcome === 'applied' ? { release_id: RELEASE_B, desired_release_id: RELEASE_B } : {}),
    reload: outcome === 'applied' ? { how: 'restarted', turn_ended: false } : null,
    reason: null,
    ...overrides,
  };
}

function fakeDaemon(opts: {
  capable: boolean;
  /** The project's `config_releases` flag. Default on. */
  releasesEnabled?: boolean;
  previousRepository?: boolean;
  turnInFlight?: boolean;
  converge?: unknown;
  convergeStatus?: number[];
  etagAfter?: string;
}) {
  const requests: Array<{ method: string; path: string }> = [];
  let healthReads = 0;
  const convergeStatuses = [...(opts.convergeStatus ?? [])];
  const pushes: unknown[] = [];
  const recorded: unknown[] = [];
  const deps: SessionReloadDeps = {
    endpoint: async () => ({ baseUrl: 'http://box', headers: {} }),
    fetch: async (url, init) => {
      const u = new URL(url);
      const method = init?.method ?? 'GET';
      requests.push({ method, path: `${u.pathname}${u.search}` });
      if (u.pathname === '/kortix/health') {
        healthReads++;
        return Response.json({
          agent_config_etag: healthReads > 1 && opts.etagAfter ? opts.etagAfter : 'eeee',
          commit_sha: 'c'.repeat(40),
          turn_in_flight: opts.turnInFlight ?? false,
          capabilities: ['file.import', 'file.append', ...(opts.capable ? ['config.release.v1'] : [])],
          ...(opts.capable ? { config: healthConfig() } : {}),
        });
      }
      if (u.pathname === '/kortix/refresh') return Response.json({ repo: { after: { commit: 'd'.repeat(40) } } });
      if (u.pathname === '/kortix/config/converge') {
        const status = convergeStatuses.shift() ?? 200;
        if (status !== 200) return Response.json({ error: 'busy' }, { status });
        return Response.json(opts.converge ?? convergeBody('applied'));
      }
      return Response.json({ error: 'not found' }, { status: 404 });
    },
    pushGovernance: async (input) => {
      pushes.push(input);
      return { applied: true, opencodeReload: 'restarted', opencodeTurnEnded: false } as never;
    },
    latestEtag: async () => 'ffff',
    sleep: async () => {},
    recordReport: async (input) => {
      recorded.push(input.report);
    },
    usesCurrentRepository: async () => opts.previousRepository !== true,
    configReleasesEnabled: async () => opts.releasesEnabled !== false,
  };
  return { deps, requests, pushes, recorded };
}

describe('reloadSessionConfig capability gate', () => {
  test('a capable daemon receives converge, no governance push, and no config_dir=1', async () => {
    const daemon = fakeDaemon({ capable: true, etagAfter: 'ffff' });
    const result = await reloadSessionConfig(INPUT, daemon.deps);

    expect(daemon.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      'GET /kortix/health?turn=1',
      'POST /kortix/refresh?restart=0',
      'POST /kortix/config/converge',
      'GET /kortix/health',
    ]);
    expect(daemon.pushes).toEqual([]);
    expect(result).toMatchObject({
      applied: true,
      agent_files: 'updated',
      opencode_reload: 'restarted',
      turn_ended: false,
      previous_etag: 'eeee',
      etag: 'ffff',
      repo_refreshed: true,
      commit_sha: 'd'.repeat(40),
      config_path: 'release',
      release_outcome: 'applied',
      release: {
        mode: 'follow-base',
        source: 'release',
        running_release_id: RELEASE_B,
        desired_release_id: RELEASE_B,
        proven: true,
        fallback_reason: null,
        failed_release_id: null,
      },
    });
  });

  test('the health report and the converge report both reach the quarantine recorder', async () => {
    const daemon = fakeDaemon({
      capable: true,
      converge: convergeBody('declined', {
        config: healthConfig({ failed_release_id: RELEASE_B, fallback_reason: 'proven check failed' }),
      }),
    });
    await reloadSessionConfig(INPUT, daemon.deps);
    expect(daemon.recorded).toEqual([
      expect.objectContaining({ release_id: RELEASE_A, failed_release_id: null }),
      expect.objectContaining({ failed_release_id: RELEASE_B }),
    ]);
  });

  test('a previous-repository session receives nothing: no health read, no converge, no refresh, no push', async () => {
    for (const capable of [true, false]) {
      const daemon = fakeDaemon({ capable, previousRepository: true });
      const result = await reloadSessionConfig({ ...INPUT, force: true }, daemon.deps);
      expect(daemon.requests).toEqual([]);
      expect(daemon.pushes).toEqual([]);
      expect(result).toMatchObject({ applied: false, reason: PREVIOUS_REPOSITORY_REASON });
    }
  });

  test('refresh_repo false skips the pull on a capable daemon, and converge still runs', async () => {
    const daemon = fakeDaemon({ capable: true });
    await reloadSessionConfig({ ...INPUT, refreshRepo: false }, daemon.deps);
    expect(daemon.requests.map((r) => r.path)).not.toContain('/kortix/refresh?restart=0');
    expect(daemon.requests.map((r) => r.path)).toContain('/kortix/config/converge');
  });

  test('an old daemon receives only the plain refresh and the governance push', async () => {
    const daemon = fakeDaemon({ capable: false });
    const result = await reloadSessionConfig(INPUT, daemon.deps);

    expect(daemon.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      'GET /kortix/health?turn=1',
      'POST /kortix/refresh?restart=0',
    ]);
    expect(daemon.pushes.length).toBe(1);
    expect(result.config_path).toBe('legacy');
    expect(result.agent_files).toBe('unknown');
    expect('release' in result).toBe(false);
  });

  test('no request to either daemon ever carries config_dir=1', async () => {
    for (const capable of [true, false]) {
      for (const refreshRepo of [true, false]) {
        const daemon = fakeDaemon({ capable });
        await reloadSessionConfig({ ...INPUT, refreshRepo }, daemon.deps);
        expect(daemon.requests.some((r) => r.path.includes('config_dir'))).toBe(false);
      }
    }
  });

  test('a running turn is never ended: a capable daemon is not converged mid-turn', async () => {
    const daemon = fakeDaemon({ capable: true, turnInFlight: true });
    const result = await reloadSessionConfig(INPUT, daemon.deps);
    expect(result.reason).toBe('session is mid-turn');
    expect(daemon.requests.map((r) => r.path)).toEqual(['/kortix/health?turn=1']);
    expect(result.release?.running_release_id).toBe(RELEASE_A);
    expect(result.release_outcome).toBeNull();
  });

  test('a busy converge (409) is waited out', async () => {
    const daemon = fakeDaemon({ capable: true, convergeStatus: [409, 409] });
    const result = await reloadSessionConfig(INPUT, daemon.deps);
    expect(daemon.requests.filter((r) => r.path === '/kortix/config/converge').length).toBe(3);
    expect(result.release_outcome).toBe('applied');
  });

  test('a converge that does not answer is reported, with the release state from health', async () => {
    const daemon = fakeDaemon({ capable: true, convergeStatus: [500] });
    const result = await reloadSessionConfig(INPUT, daemon.deps);
    expect(result).toMatchObject({
      applied: false,
      agent_files: 'unknown',
      config_path: 'release',
      release_outcome: null,
      reason: 'the sandbox did not answer the config convergence',
    });
    expect(result.release?.running_release_id).toBe(RELEASE_A);
  });
});

function converge(outcome: DaemonConvergeResponse['outcome'], overrides: Partial<DaemonConvergeResponse> = {}): DaemonConvergeResponse {
  return {
    ok: true,
    outcome,
    config: {
      release_id: RELEASE_A,
      desired_release_id: RELEASE_A,
      source: 'release',
      mode: 'follow-base',
      proven: true,
      fallback_reason: null,
      failed_release_id: null,
    },
    reload: null,
    reason: null,
    ...overrides,
  };
}

describe('convergeToReloadResult', () => {
  const etags = { previousEtag: 'eeee', etagAfter: 'ffff' };

  test('maps every outcome', () => {
    expect(convergeToReloadResult(converge('applied', { reload: { how: 'restarted', turn_ended: true } }), etags)).toMatchObject({
      applied: true,
      agent_files: 'updated',
      opencode_reload: 'restarted',
      turn_ended: true,
      etag: 'ffff',
    });
    expect(convergeToReloadResult(converge('unchanged'), etags)).toMatchObject({
      applied: false,
      agent_files: 'already-current',
      etag: 'eeee',
      reason: 'already current',
    });
    expect(convergeToReloadResult(converge('declined', { reason: 'GET /agent lacks kortix' }), etags)).toMatchObject({
      applied: false,
      opencode_reload: 'kept-old',
      reason: 'GET /agent lacks kortix',
    });
    expect(
      convergeToReloadResult(converge('quarantined', { config: { ...converge('x' as never).config, failed_release_id: RELEASE_B } }), etags)
        .reason,
    ).toContain(RELEASE_B.slice(0, 12));
    expect(convergeToReloadResult(converge('failed', { reason: 'disk full' }), etags)).toMatchObject({
      applied: false,
      reason: 'disk full',
    });
  });
});

function reloadResult(overrides: Partial<SessionReloadResult> = {}): SessionReloadResult {
  return {
    applied: true,
    previous_etag: 'eeee',
    etag: 'ffff',
    repo_refreshed: true,
    commit_sha: null,
    agent_files: 'updated',
    opencode_reload: 'restarted',
    turn_ended: false,
    ...overrides,
  };
}

const releaseState = (overrides: Partial<NonNullable<SessionReloadResult['release']>> = {}) => ({
  mode: 'follow-base' as const,
  source: 'release' as const,
  running_release_id: RELEASE_A,
  desired_release_id: RELEASE_B,
  proven: true,
  fallback_reason: null,
  failed_release_id: null,
  ...overrides,
});

describe('reloadDetail and reloadNeedsAttention with a release', () => {
  test('a fallback leads the sentence and needs attention', () => {
    const result = reloadResult({
      applied: false,
      agent_files: 'unknown',
      reason: 'x',
      release: releaseState({ fallback_reason: 'replacement did not serve GET /agent within 90 s', failed_release_id: RELEASE_B }),
    });
    expect(reloadDetail(result)).toBe(
      'The new config failed to load: replacement did not serve GET /agent within 90 s. An earlier config still runs this session.',
    );
    expect(reloadNeedsAttention(result)).toBe(true);
  });

  test('a fallback names what runs: the platform default config, or the workspace config', () => {
    const image = reloadResult({
      applied: false,
      agent_files: 'unknown',
      reason: 'x',
      release: releaseState({ source: 'image-default', running_release_id: null, fallback_reason: 'boom', failed_release_id: RELEASE_B }),
    });
    expect(reloadDetail(image)).toBe('The new config failed to load: boom. The platform default config runs this session.');
    // `workspace` is not a source: a box never falls back to /workspace under
    // config releases. An earlier release is the only other thing that serves.
    const earlier = reloadResult({
      applied: false,
      agent_files: 'unknown',
      reason: 'x',
      release: releaseState({ source: 'release', running_release_id: RELEASE_A, fallback_reason: 'boom', failed_release_id: RELEASE_B }),
    });
    expect(reloadDetail(earlier)).toBe('The new config failed to load: boom. An earlier config still runs this session.');
  });

  test('a fallback needs attention even on an otherwise applied result', () => {
    const result = reloadResult({ release: releaseState({ fallback_reason: 'disk full.' }) });
    expect(reloadNeedsAttention(result)).toBe(true);
    expect(reloadDetail(result).startsWith('The new config failed to load: disk full. ')).toBe(true);
  });

  test('no reload ever says a session runs its own config files', () => {
    // There is no session-files mode. A session's edits under /workspace reach
    // its box by being pushed to the base branch, not by being adopted.
    const result = reloadResult({ agent_files: 'kept-yours', release: releaseState() });
    expect(reloadDetail(result)).not.toContain('own config files');
  });

  test('an applied release without a fallback is not a warning', () => {
    const result = reloadResult({ release: releaseState() });
    expect(reloadNeedsAttention(result)).toBe(false);
    expect(reloadDetail(result)).toBe('Reloaded. The next prompt runs the new config.');
  });
});

describe('compiled-governance push callers', () => {
  test('only the two legacy paths reference pushSessionAgentConfigToSandbox', async () => {
    // Any other path would push KORTIX_COMPILED_AGENT_CONFIG to a daemon whose
    // release already carries governance. The push also checks the capability
    // itself (agent-config-push.test.ts). Comment lines do not count.
    //
    // Two callers are legitimate, and both are behind a "config releases do
    // not apply here" branch:
    //   • session-reload.ts        — the daemon has no `config.release.v1`,
    //                                or `config_releases` is off.
    //   • session-config-convergence.ts — `config_releases` is off and the
    //                                session was RESTARTED, which pushed the
    //                                compiled governance before config
    //                                releases existed (spec, "Feature flag").
    const src = join(import.meta.dir, '..', '..', '..');
    const users: string[] = [];
    for await (const file of new Bun.Glob('**/*.ts').scan({ cwd: src })) {
      if (file.endsWith('.test.ts') || file.endsWith('projects/lib/sandbox-env-sync.ts')) continue;
      const code = readFileSync(join(src, file), 'utf8')
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join('\n');
      if (code.includes('pushSessionAgentConfigToSandbox')) users.push(relative(src, join(src, file)));
    }
    expect(users.sort()).toEqual([
      'projects/lib/session-config-convergence.ts',
      'projects/lib/session-reload.ts',
    ]);
  });
});

// ── The `config_releases` flag (spec, "Feature flag") ───────────────────────
//
// CHOKEPOINT: `reloadSessionConfig` reads the flag once and ignores the
// daemon's own capability when it is off. A capable daemon then receives
// exactly what an old daemon receives — the plain refresh plus the governance
// push — and the result carries no `release` block, so the CLI and the web
// render the pre-release, etag-based text.
describe('reloadSessionConfig with config_releases off', () => {
  test('a CAPABLE daemon takes the legacy path: no converge, no release block', async () => {
    const daemon = fakeDaemon({ capable: true, releasesEnabled: false });
    const result = await reloadSessionConfig(INPUT, daemon.deps);

    expect(daemon.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      'GET /kortix/health?turn=1',
      'POST /kortix/refresh?restart=0',
    ]);
    expect(daemon.requests.map((r) => r.path)).not.toContain('/kortix/config/converge');
    expect(daemon.pushes.length).toBe(1);
    expect(result.config_path).toBe('legacy');
    expect('release' in result).toBe(false);
    expect('release_outcome' in result).toBe(false);
  });

  test('nothing is written to the project quarantine ledger', async () => {
    const daemon = fakeDaemon({ capable: true, releasesEnabled: false });
    await reloadSessionConfig(INPUT, daemon.deps);
    expect(daemon.recorded).toEqual([]);
  });

  test('a mid-turn refusal reports no release state either', async () => {
    const daemon = fakeDaemon({ capable: true, releasesEnabled: false, turnInFlight: true });
    const result = await reloadSessionConfig(INPUT, daemon.deps);
    expect(result.reason).toBe('session is mid-turn');
    expect(result.config_path).toBe('legacy');
    expect('release' in result).toBe(false);
  });

  test('no request carries config_dir=1 with the flag off either', async () => {
    const daemon = fakeDaemon({ capable: true, releasesEnabled: false });
    await reloadSessionConfig(INPUT, daemon.deps);
    expect(daemon.requests.filter((r) => r.path.includes('config_dir'))).toEqual([]);
  });

  test('turning the flag back ON converges the same session again', async () => {
    const off = fakeDaemon({ capable: true, releasesEnabled: false });
    await reloadSessionConfig(INPUT, off.deps);
    const on = fakeDaemon({ capable: true, releasesEnabled: true, etagAfter: 'ffff' });
    const result = await reloadSessionConfig(INPUT, on.deps);
    expect(on.requests.map((r) => r.path)).toContain('/kortix/config/converge');
    expect(result).toMatchObject({ applied: true, config_path: 'release', release_outcome: 'applied' });
  });
});
