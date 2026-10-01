import { describe, expect, test } from 'bun:test';
import type { SandboxExecResult } from '../../platform/providers';
import {
  LEGACY_BOOTSTRAP_COOLDOWN_MS,
  LEGACY_BOOTSTRAP_MAX_ATTEMPTS,
  LEGACY_BOOTSTRAP_MAX_COOLDOWN_MS,
  LEGACY_BOOTSTRAP_METADATA_KEY,
  LEGACY_CHECK_METADATA_KEY,
  LEGACY_CHECK_TTL_MS,
  REQUIRED_RUNTIME_CAPABILITIES,
  bootstrapExecCommand,
  bootstrapLegacyRuntime,
  classifyDaemonHealth,
  DEAD_DAEMON_REPAIR_BUDGET_MS,
  DEAD_DAEMON_REPAIR_REQUESTED_KEY,
  decideDeadDaemonOnOpen,
  describeLegacyBootstrapRetry,
  legacyBootstrapCooldownMs,
  parseScriptReport,
  relaunchStrategyFor,
  renderLegacyBootstrapScript,
  type ExpectedRunningAssets,
  type LegacyBootstrapDeps,
  type StaleReason,
} from './legacy-runtime-bootstrap';

const LEGACY_HEALTH = { daemon: 'ok', status: 'ok', opencode: 'ok', runtimeReady: true, uptime_s: 3514521 };
const MANIFEST: ExpectedRunningAssets = {
  cli_sha256: 'c'.repeat(64),
  managed_skills_hash: 'm'.repeat(64),
  agent_sha256: 'a'.repeat(64),
};
// A fully converged daemon: every required capability, `running` present and
// matching the manifest sha-to-sha, no swap pending, nothing pinned, nothing
// failed. The negative fixture — must classify 'current' and must never be
// routed into a repair.
const CURRENT_HEALTH = {
  daemon: 'ok',
  opencode: 'ok',
  capabilities: [...REQUIRED_RUNTIME_CAPABILITIES],
  uptime_s: 600,
  runtime: {
    build: 1788044234,
    components: { agent: 'current', opencode: 'current', cli: 'current', skills: 'current' },
    agentSwapPending: false,
    pinned: false,
    running: {
      cli_sha256: MANIFEST.cli_sha256,
      managed_skills_hash: MANIFEST.managed_skills_hash,
      agent_sha256: MANIFEST.agent_sha256,
    },
  },
};

/**
 * THE REAL BOX. Live `/kortix/health` through the provider ingress (not the
 * DB-gated proxy — the box is alive; its `session_sandboxes` row status is a
 * separate, orthogonal question this fixture does not speak to): `daemon:
 * "ok"`, `opencode: "ok"`, `runtimeReady: true`, 31.8 days of uptime, a
 * `runtime` block with a plain build number, `components: {cli: "failed",
 * skills: "current", agent: "staged", opencode: "current"}`,
 * `agentSwapPending: true`, `pinned: false`. NO `capabilities` key. NO
 * `runtime.running` key at all — this daemon predates running-asset truth.
 * Reproduced verbatim from the live report; no real sandbox/session id is
 * embedded here, only the shape of what the box answered.
 */
const REAL_STALE_HEALTH = {
  daemon: 'ok',
  status: 'ok',
  runtimeReady: true,
  opencode: 'ok',
  uptime_s: 2745710,
  runtime: {
    build: 1790538288,
    at: '2026-09-27T20:11:13.916Z',
    components: { cli: 'failed', skills: 'current', agent: 'staged', opencode: 'current' },
    agentSwapPending: true,
    pinned: false,
  },
};

describe('classifyDaemonHealth', () => {
  test('no runtime block on an ok daemon = legacy', () => {
    expect(classifyDaemonHealth(LEGACY_HEALTH).klass).toBe('legacy');
  });
  test('runtime block, capability present, running matches the manifest sha-to-sha, no swap pending, nothing pinned = current', () => {
    const c = classifyDaemonHealth(CURRENT_HEALTH, MANIFEST);
    expect(c).toEqual({
      klass: 'current',
      runtimeBuild: 1788044234,
      opencode: 'ok',
      opencodeComponent: 'current',
      staleReasons: [],
      detail: [],
    });
  });
  test('null / non-object = unreachable, daemon not ok = not-ok', () => {
    expect(classifyDaemonHealth(null).klass).toBe('unreachable');
    expect(classifyDaemonHealth('x').klass).toBe('unreachable');
    expect(classifyDaemonHealth({ daemon: 'starting' }).klass).toBe('not-ok');
  });
  test('a genuinely fresh daemon (running present but every field unconfirmed, build not yet settled) stays current, not stale — a first-pass-pending box, not a legacy one', () => {
    const c = classifyDaemonHealth({
      daemon: 'ok',
      opencode: 'ok',
      capabilities: [...REQUIRED_RUNTIME_CAPABILITIES],
      runtime: { build: null, components: {}, agentSwapPending: false, pinned: false, running: { cli_sha256: null, managed_skills_hash: null, agent_sha256: null } },
    });
    expect(c.klass).toBe('current');
    expect(c.staleReasons).toEqual([]);
  });

  test('THE REAL BOX: `runtime.running` unreported + missing capability + agentSwapPending + a failed component = stale — runtime.build is NEVER read as evidence of currency', () => {
    const c = classifyDaemonHealth(REAL_STALE_HEALTH, MANIFEST);
    expect(c.klass).toBe('stale');
    expect(c.runtimeBuild).toBe(1790538288); // reported for visibility only — not an input to klass
    const expected: StaleReason[] = ['running_assets_unreported', 'missing_capability', 'agent_swap_pending', 'component_failed'];
    expect([...c.staleReasons].sort()).toEqual([...expected].sort());
    expect(c.detail.some((d) => d.includes('running'))).toBe(true);
    expect(c.detail.some((d) => d.includes('agentSwapPending'))).toBe(true);
    expect(c.detail.some((d) => d.includes('cli'))).toBe(true);
  });

  test('a HUGE runtime.build number alone proves nothing — without running/capabilities it is still stale', () => {
    // The real box's build (1790538288) is numerically LARGER than the
    // CURRENT fixture's (1788044234). A build-floor heuristic would call it
    // "newer" and therefore current. It is not.
    expect(REAL_STALE_HEALTH.runtime.build).toBeGreaterThan(CURRENT_HEALTH.runtime.build);
    expect(classifyDaemonHealth(REAL_STALE_HEALTH).klass).toBe('stale');
  });

  test('`runtime.running` absent alone is enough to classify stale, independent of every other field', () => {
    const health = { ...CURRENT_HEALTH, runtime: { build: CURRENT_HEALTH.runtime.build, components: CURRENT_HEALTH.runtime.components, agentSwapPending: false, pinned: false } };
    const c = classifyDaemonHealth(health, MANIFEST);
    expect(c.klass).toBe('stale');
    expect(c.staleReasons).toEqual(['running_assets_unreported']);
  });

  test('`runtime.running` present but sha-mismatched against the manifest = stale, sha-to-sha, never version-string', () => {
    const health = {
      ...CURRENT_HEALTH,
      runtime: { ...CURRENT_HEALTH.runtime, running: { ...CURRENT_HEALTH.runtime.running, cli_sha256: 'stale-sha' } },
    };
    const c = classifyDaemonHealth(health, MANIFEST);
    expect(c.klass).toBe('stale');
    expect(c.staleReasons).toEqual(['running_assets_stale']);
    expect(c.detail[0]).toContain('cli_sha256');
  });

  test('without an expected manifest passed in, the sha compare is skipped but `running` absence still catches it', () => {
    // No second argument: the wiring layer always passes one in production;
    // a caller without the manifest handy still gets the rule-1 signal.
    const withRunningButNoExpected = classifyDaemonHealth(CURRENT_HEALTH);
    expect(withRunningButNoExpected.klass).toBe('current');
    const health = { ...CURRENT_HEALTH, runtime: { build: CURRENT_HEALTH.runtime.build, components: CURRENT_HEALTH.runtime.components, agentSwapPending: false, pinned: false } };
    expect(classifyDaemonHealth(health).klass).toBe('stale');
  });

  test('missing the required capability alone is enough to classify stale', () => {
    const health = { ...CURRENT_HEALTH, capabilities: [] };
    const c = classifyDaemonHealth(health, MANIFEST);
    expect(c.klass).toBe('stale');
    expect(c.staleReasons).toEqual(['missing_capability']);
  });

  test('a pi box is not stale for lacking config.release.v1: pi has no config releases', () => {
    // Only the OpenCode runtime advertises the capability. Requiring it of pi
    // relaunched every idle pi box on each session open, and the relaunch could
    // never converge, so /start answered `starting` until the retries ran out.
    const pi = classifyDaemonHealth({ ...CURRENT_HEALTH, harness: 'pi', capabilities: ['file.import', 'file.append'] }, MANIFEST);
    expect(pi.klass).toBe('current');
    expect(pi.staleReasons).toEqual([]);
    const opencode = classifyDaemonHealth({ ...CURRENT_HEALTH, harness: 'opencode', capabilities: [] }, MANIFEST);
    expect(opencode.staleReasons).toEqual(['missing_capability']);
  });

  test('a W3 daemon names its harness in the closed block; the classifier reads id and state from it', () => {
    const block = (id: string) => ({ id, version: null, state: 'ok', ready: true, error: null, session: { id: null, required: false }, turn: null, details: {} });
    const pi = classifyDaemonHealth({ ...CURRENT_HEALTH, harness: block('pi'), opencode: undefined, capabilities: ['file.import'] }, MANIFEST);
    expect(pi.klass).toBe('current');
    expect(pi.opencode).toBe('ok');
    const opencode = classifyDaemonHealth({ ...CURRENT_HEALTH, harness: block('opencode'), capabilities: [] }, MANIFEST);
    expect(opencode.staleReasons).toEqual(['missing_capability']);
  });

  test('agentSwapPending: true is stale immediately — no grace window; a running box has no natural self-promotion path', () => {
    const health = { ...CURRENT_HEALTH, runtime: { ...CURRENT_HEALTH.runtime, components: { ...CURRENT_HEALTH.runtime.components, agent: 'staged' }, agentSwapPending: true } };
    const c = classifyDaemonHealth(health, MANIFEST);
    expect(c.klass).toBe('stale');
    expect(c.staleReasons).toEqual(['agent_swap_pending']);
  });

  test('ANY failed component makes the box stale, opencode included — the classifier no longer allowlists which components count', () => {
    const health = { ...CURRENT_HEALTH, runtime: { ...CURRENT_HEALTH.runtime, components: { ...CURRENT_HEALTH.runtime.components, opencode: 'failed' } } };
    const c = classifyDaemonHealth(health, MANIFEST);
    expect(c.klass).toBe('stale');
    expect(c.staleReasons).toEqual(['component_failed']);
    expect(c.detail[0]).toContain('opencode');
  });

  test('pinned: true = blocked, not stale — never repaired, regardless of how many other checks would also fail', () => {
    const health = {
      ...REAL_STALE_HEALTH,
      runtime: { ...REAL_STALE_HEALTH.runtime, pinned: true },
    };
    const c = classifyDaemonHealth(health, MANIFEST);
    expect(c.klass).toBe('blocked');
    expect(c.staleReasons).toEqual([]);
    expect(c.detail[0]).toContain('pinned');
  });
});

describe('relaunchStrategyFor', () => {
  test('platinum relaunches in place; daytona/e2b converge at next start; unknown unsupported', () => {
    expect(relaunchStrategyFor('platinum')).toBe('pt-app');
    expect(relaunchStrategyFor('daytona')).toBe('next-start');
    expect(relaunchStrategyFor('e2b')).toBe('next-start');
    expect(relaunchStrategyFor('local')).toBeNull();
  });
});

describe('decideDeadDaemonOnOpen', () => {
  const since = Date.parse('2026-09-29T14:08:18Z');
  const now = since + 40_000;
  const at = (ms: number) => new Date(ms).toISOString();

  test('a dead daemon on Platinum asks for a relaunch instead of parking', () => {
    expect(decideDeadDaemonOnOpen({ provider: 'platinum', metadata: {}, unreachableSinceMs: since, nowMs: now })).toBe('request');
  });

  test('a request from an earlier unreachable spell does not count', () => {
    const metadata = { [DEAD_DAEMON_REPAIR_REQUESTED_KEY]: at(since - 1) };
    expect(decideDeadDaemonOnOpen({ provider: 'platinum', metadata, unreachableSinceMs: since, nowMs: now })).toBe('request');
  });

  test('an asked-for relaunch holds the open until its budget runs out, then parks', () => {
    const metadata = { [DEAD_DAEMON_REPAIR_REQUESTED_KEY]: at(since + 30_000) };
    expect(decideDeadDaemonOnOpen({ provider: 'platinum', metadata, unreachableSinceMs: since, nowMs: now })).toBe('wait');
    expect(
      decideDeadDaemonOnOpen({ provider: 'platinum', metadata, unreachableSinceMs: since, nowMs: since + 30_000 + DEAD_DAEMON_REPAIR_BUDGET_MS }),
    ).toBe('park');
  });

  test('a relaunch that failed after it was asked for parks at once', () => {
    const metadata = {
      [DEAD_DAEMON_REPAIR_REQUESTED_KEY]: at(since + 30_000),
      [LEGACY_BOOTSTRAP_METADATA_KEY]: { state: 'failed', attempts: 1, manifestBuild: 1, lastAttemptAt: at(since + 31_000), finishedAt: at(since + 35_000) },
    };
    expect(decideDeadDaemonOnOpen({ provider: 'platinum', metadata, unreachableSinceMs: since, nowMs: now })).toBe('park');
  });

  test('providers that relaunch on their own start keep parking', () => {
    expect(decideDeadDaemonOnOpen({ provider: 'daytona', metadata: {}, unreachableSinceMs: since, nowMs: now })).toBe('park');
    expect(decideDeadDaemonOnOpen({ provider: 'e2b', metadata: {}, unreachableSinceMs: since, nowMs: now })).toBe('park');
  });
});

describe('renderLegacyBootstrapScript', () => {
  test('carries no secret, verifies every download, keeps the baked binary, restores on failure', () => {
    const s = renderLegacyBootstrapScript({ relaunch: 'pt-app' });
    expect(s).not.toMatch(/kortix_(sb|pat)_[A-Za-z0-9]{8,}|Bearer [A-Za-z0-9]/);
    expect(s).toContain('readenv KORTIX_SANDBOX_TOKEN');
    expect(s).toContain('/v1/runtime-assets/manifest');
    expect(s).toContain('sha256sum');
    expect(s).toContain('agent.next.sha256');
    expect(s).not.toMatch(/mv[^\n]*\/usr\/local\/bin\/kortix-agent\b/);
    expect(s).toContain('"$ENTRYPOINT.legacy"');
    expect(s).toContain('bash -n');
    expect(s).toContain('/sbin/pt-app');
    expect(s).toContain('restoring the legacy chain');
    expect(s).toContain('global-bin-dir=');
    expect(s).toContain('npm install -g "pnpm@$want"');
    expect(s).toContain("RELAUNCH='pt-app'");
  });
  test('pt-app re-checks OpenCode idle after the download, before the token swap and the kill', () => {
    const s = renderLegacyBootstrapScript({ relaunch: 'pt-app' });
    const guard = s.indexOf('"stage\\":\\"deferred_busy');
    expect(guard).toBeGreaterThan(s.indexOf('download "$AGENT_PATH"'));
    expect(guard).toBeLessThan(s.indexOf('if [ -n "$NEW_KORTIX_TOKEN" ]'));
    expect(guard).toBeLessThan(s.indexOf('\nstop_runtime_chain\n'));
    expect(s).toContain('http://127.0.0.1:4096/session/status');
  });
  test('next-start strategy stages only', () => {
    const s = renderLegacyBootstrapScript({ relaunch: 'next-start' });
    expect(s).toContain("RELAUNCH='next-start'");
    expect(s).toContain('"stage\\":\\"staged');
  });
  test('embeds the entrypoint when given, and the script prefers the manifest copy', () => {
    const s = renderLegacyBootstrapScript({ relaunch: 'pt-app', entrypointSource: '#!/bin/bash\necho supervisor\n' });
    expect(s).toContain(`EMBEDDED_EP_B64='${Buffer.from('#!/bin/bash\necho supervisor\n').toString('base64')}'`);
    expect(s).toContain('EP_SOURCE=embedded');
    expect(renderLegacyBootstrapScript({ relaunch: 'pt-app' })).toContain("EMBEDDED_EP_B64=''");
  });
  test('rejects an unsafe opencode home', () => {
    expect(() => renderLegacyBootstrapScript({ relaunch: 'pt-app', opencodeHome: '/x; rm -rf /' })).toThrow();
    expect(renderLegacyBootstrapScript({ relaunch: 'pt-app' })).toContain("OPENCODE_HOME='auto'");
  });
  test('exec command carries the script as base64 and runs it with bash', () => {
    const cmd = bootstrapExecCommand('echo hi');
    expect(cmd[0]).toBe('bash');
    expect(cmd[2]).toContain(Buffer.from('echo hi').toString('base64'));
    expect(cmd[2]).toContain('bash /tmp/kx-legacy-bootstrap.sh');
  });
});

describe('parseScriptReport', () => {
  const exec = (stdout: string, exitCode = 0): SandboxExecResult => ({ exitCode, stdout, stderr: '' });
  test('reads the last JSON line', () => {
    const r = parseScriptReport(exec('noise\n{"ok":true,"stage":"relaunched","agent_sha256":"abc"}\n'));
    expect(r).toEqual({ ok: true, stage: 'relaunched', agent_sha256: 'abc' });
  });
  test('null without a report line', () => {
    expect(parseScriptReport(exec('nothing here', 1))).toBeNull();
  });
});

type Calls = { patches: Record<string, unknown>[]; audits: unknown[]; execs: string[][] };

function makeDeps(over: Partial<LegacyBootstrapDeps> & { health?: unknown[]; status?: Record<string, unknown> | null }, calls: Calls, clock = { t: 1_000_000 }): LegacyBootstrapDeps {
  const healths = over.health ?? [LEGACY_HEALTH, CURRENT_HEALTH];
  let i = 0;
  return {
    now: () => clock.t,
    sleep: async (ms) => {
      clock.t += ms;
    },
    manifestBuild: async () => 1788044234,
    fetchHealth: async () => healths[Math.min(i++, healths.length - 1)],
    fetchOpencodeStatus: async () => (over.status === undefined ? {} : over.status),
    exec: async (cmd) => {
      calls.execs.push(cmd);
      return { exitCode: 0, stdout: '{"ok":true,"stage":"relaunched","agent_sha256":"a","entrypoint_sha256":"e"}\n', stderr: '' };
    },
    patchMetadata: async (p) => {
      calls.patches.push(p);
    },
    audit: async (e) => {
      calls.audits.push(e);
    },
    log: () => {},
    ...over,
  };
}

const input = (metadata: Record<string, unknown> | null = null, provider = 'platinum') => ({
  sandboxId: 'sb1',
  externalId: 'sbx_1',
  provider,
  metadata,
  reason: 'test',
});

describe('bootstrapLegacyRuntime', () => {
  test('legacy + idle platinum box: execs the script, waits for a current serving daemon, records converged', async () => {
    const calls: Calls = { patches: [], audits: [], execs: [] };
    const r = await bootstrapLegacyRuntime(input(), makeDeps({}, calls));
    expect(r.outcome).toBe('converged');
    expect(calls.execs).toHaveLength(1);
    expect(calls.execs[0][0]).toBe('bash');
    const states = calls.patches.map((p) => (p[LEGACY_BOOTSTRAP_METADATA_KEY] as { state?: string } | undefined)?.state).filter(Boolean);
    expect(states).toEqual(['running', 'converged']);
    const finalRecord = calls.patches.at(-1)![LEGACY_BOOTSTRAP_METADATA_KEY] as Record<string, unknown>;
    expect(finalRecord.attempts).toBe(1);
    expect(finalRecord.manifestBuild).toBe(1788044234);
    expect(finalRecord.to).toEqual({ agentSha256: 'a', entrypointSha256: 'e', runtimeBuild: 1788044234 });
    expect(calls.audits).toHaveLength(1);
    expect((calls.audits[0] as { outcome: string }).outcome).toBe('success');
  });

  test('an install during the boot pass (opencode=updated) triggers exactly one more relaunch', async () => {
    const calls: Calls = { patches: [], audits: [], execs: [] };
    const updated = { daemon: 'ok', opencode: 'ok', capabilities: [...REQUIRED_RUNTIME_CAPABILITIES], runtime: { build: 1788044234, components: { agent: 'current', opencode: 'updated' }, agentSwapPending: false, pinned: false, running: {} } };
    const r = await bootstrapLegacyRuntime(input(), makeDeps({ health: [LEGACY_HEALTH, updated, updated, updated] }, calls));
    expect(r.outcome).toBe('converged');
    expect(calls.execs).toHaveLength(2);
    expect(calls.audits).toHaveLength(2);
  });

  test('current box: stamps the check and does nothing else', async () => {
    const calls: Calls = { patches: [], audits: [], execs: [] };
    const r = await bootstrapLegacyRuntime(input(), makeDeps({ health: [CURRENT_HEALTH] }, calls));
    expect(r.outcome).toBe('not-legacy');
    expect(calls.execs).toHaveLength(0);
    expect(calls.patches).toHaveLength(1);
    expect((calls.patches[0][LEGACY_CHECK_METADATA_KEY] as { klass: string }).klass).toBe('current');
  });

  test('recently checked current box is not probed again inside the TTL', async () => {
    const calls: Calls = { patches: [], audits: [], execs: [] };
    const clock = { t: Date.parse('2026-09-01T12:00:00Z') };
    const meta = { [LEGACY_CHECK_METADATA_KEY]: { at: new Date(clock.t - LEGACY_CHECK_TTL_MS / 2).toISOString(), klass: 'current' } };
    let probed = false;
    const deps = makeDeps({ fetchHealth: async () => { probed = true; return CURRENT_HEALTH; } }, calls, clock);
    const r = await bootstrapLegacyRuntime(input(meta), deps);
    expect(r.outcome).toBe('skipped-recent-check');
    expect(probed).toBe(false);
    // force = an operator asking for the truth now: the box is probed, and a
    // current daemon is re-run (idempotent script) rather than skipped.
    const forced = await bootstrapLegacyRuntime({ ...input(meta), force: true }, deps);
    expect(forced.outcome).toBe('converged');
    expect(probed).toBe(true);
  });

  test('busy OpenCode is never touched', async () => {
    const calls: Calls = { patches: [], audits: [], execs: [] };
    const r = await bootstrapLegacyRuntime(input(), makeDeps({ status: { ses_1: { type: 'busy' } } }, calls));
    expect(r.outcome).toBe('skipped-busy');
    expect(calls.execs).toHaveLength(0);
    const unreachable = await bootstrapLegacyRuntime(input(), makeDeps({ status: null }, calls));
    expect(unreachable.outcome).toBe('skipped-busy');
  });

  test('a turn that starts during the repair defers the relaunch and spends no attempt', async () => {
    // dev 2026-09-29: the idle gate passed, the ~110 MB agent download ran,
    // the user's first prompt landed, and the relaunch killed it.
    const calls: Calls = { patches: [], audits: [], execs: [] };
    const prior = { state: 'converged', attempts: 1, manifestBuild: 1, lastAttemptAt: '2026-09-28T00:00:00.000Z', reason: 'reaper', to: { runtimeBuild: 1 } };
    const deps = makeDeps(
      {
        exec: async (cmd) => {
          calls.execs.push(cmd);
          return { exitCode: 0, stdout: '{"ok":true,"stage":"deferred_busy","token_rotated":false}\n', stderr: '' };
        },
      },
      calls,
    );
    const r = await bootstrapLegacyRuntime(input({ [LEGACY_BOOTSTRAP_METADATA_KEY]: prior }), deps);
    expect(r.outcome).toBe('skipped-busy');
    expect(calls.execs).toHaveLength(1);
    expect(calls.patches.at(-1)).toEqual({ [LEGACY_BOOTSTRAP_METADATA_KEY]: prior });
    expect(calls.audits).toHaveLength(0);

    const fresh: Calls = { patches: [], audits: [], execs: [] };
    await bootstrapLegacyRuntime(input(), makeDeps({ exec: deps.exec }, fresh));
    expect(fresh.patches.at(-1)).toEqual({ [LEGACY_BOOTSTRAP_METADATA_KEY]: null });
  });

  test('failed attempt: cooldown, then budget exhausted on the same build, fresh budget on a new build', async () => {
    const clock = { t: Date.parse('2026-09-01T12:00:00Z') };
    const failedRecord = (attempts: number, build: number, ageMs: number) => ({
      [LEGACY_BOOTSTRAP_METADATA_KEY]: {
        state: 'failed',
        attempts,
        manifestBuild: build,
        lastAttemptAt: new Date(clock.t - ageMs).toISOString(),
      },
    });
    const calls: Calls = { patches: [], audits: [], execs: [] };
    expect((await bootstrapLegacyRuntime(input(failedRecord(1, 1788044234, 60_000)), makeDeps({}, calls, clock))).outcome).toBe('skipped-cooldown');
    expect((await bootstrapLegacyRuntime({ ...input(failedRecord(1, 1788044234, 60_000)), force: true }, makeDeps({}, calls, clock))).outcome).toBe('converged');
    expect((await bootstrapLegacyRuntime(input(failedRecord(LEGACY_BOOTSTRAP_MAX_ATTEMPTS, 1788044234, LEGACY_BOOTSTRAP_COOLDOWN_MS * 2)), makeDeps({}, calls, clock))).outcome).toBe('skipped-exhausted');
    expect((await bootstrapLegacyRuntime({ ...input(failedRecord(LEGACY_BOOTSTRAP_MAX_ATTEMPTS, 1788044234, LEGACY_BOOTSTRAP_COOLDOWN_MS * 2)), force: true }, makeDeps({}, calls, clock))).outcome).toBe('converged');
    const retry = await bootstrapLegacyRuntime(input(failedRecord(1, 1788044234, LEGACY_BOOTSTRAP_COOLDOWN_MS * 2)), makeDeps({}, calls, clock));
    expect(retry.outcome).toBe('converged');
    expect((calls.patches.at(-1)![LEGACY_BOOTSTRAP_METADATA_KEY] as { attempts: number }).attempts).toBe(2);
    const newBuild = await bootstrapLegacyRuntime(input(failedRecord(LEGACY_BOOTSTRAP_MAX_ATTEMPTS, 1, 60_000)), makeDeps({}, calls, clock));
    expect(newBuild.outcome).toBe('converged');
    expect((calls.patches.at(-1)![LEGACY_BOOTSTRAP_METADATA_KEY] as { attempts: number }).attempts).toBe(1);
  });

  test('script failure is recorded with stage and error, audited as failure', async () => {
    const calls: Calls = { patches: [], audits: [], execs: [] };
    const deps = makeDeps({ exec: async () => ({ exitCode: 1, stdout: 'x\n{"ok":false,"stage":"agent","error":"agent download failed"}\n', stderr: '' }) }, calls);
    const r = await bootstrapLegacyRuntime(input(), deps);
    expect(r.outcome).toBe('failed');
    const rec = calls.patches.at(-1)![LEGACY_BOOTSTRAP_METADATA_KEY] as { state: string; error: string };
    expect(rec.state).toBe('failed');
    expect(rec.error).toBe('agent: agent download failed');
    expect((calls.audits[0] as { outcome: string }).outcome).toBe('failure');
  });

  test('relaunched but never converged inside the budget = failed with the last observation', async () => {
    const calls: Calls = { patches: [], audits: [], execs: [] };
    const r = await bootstrapLegacyRuntime(input(), makeDeps({ health: [LEGACY_HEALTH, LEGACY_HEALTH] }, calls));
    expect(r.outcome).toBe('failed');
    expect((calls.patches.at(-1)![LEGACY_BOOTSTRAP_METADATA_KEY] as { error: string }).error).toContain('not converged');
  });

  test('daemon relaunched but its OpenCode install failed = failed, not converged', async () => {
    const calls: Calls = { patches: [], audits: [], execs: [] };
    const failedOc = { daemon: 'ok', opencode: 'ok', capabilities: [...REQUIRED_RUNTIME_CAPABILITIES], runtime: { build: 1788044234, components: { agent: 'current', opencode: 'failed' }, agentSwapPending: false, pinned: false, running: {} } };
    const r = await bootstrapLegacyRuntime(input(), makeDeps({ health: [LEGACY_HEALTH, failedOc] }, calls));
    expect(r.outcome).toBe('failed');
    expect(r.detail).toBe('opencode convergence failed');
    expect((calls.patches.at(-1)![LEGACY_BOOTSTRAP_METADATA_KEY] as { error: string }).error).toContain('OpenCode install failed');
  });

  test('a daemon with a runtime block but no convergence pass yet is left alone', async () => {
    const calls: Calls = { patches: [], audits: [], execs: [] };
    const pending = { daemon: 'ok', opencode: 'ok', capabilities: [...REQUIRED_RUNTIME_CAPABILITIES], runtime: { build: null, components: {}, agentSwapPending: false, pinned: false, running: {} } };
    const r = await bootstrapLegacyRuntime(input(), makeDeps({ health: [pending] }, calls));
    expect(r.outcome).toBe('not-legacy');
    expect(calls.patches).toHaveLength(0);
  });

  test('daytona: stages and records staged; a staged record is not redone on the same build', async () => {
    const calls: Calls = { patches: [], audits: [], execs: [] };
    const deps = makeDeps({ health: [LEGACY_HEALTH, LEGACY_HEALTH], exec: async (cmd) => { calls.execs.push(cmd); return { exitCode: 0, stdout: '{"ok":true,"stage":"staged","agent_sha256":"a","entrypoint_sha256":"e"}\n', stderr: '' }; } }, calls);
    const r = await bootstrapLegacyRuntime(input(null, 'daytona'), deps);
    expect(r.outcome).toBe('staged');
    const script = Buffer.from(calls.execs[0][2].split("'")[3], 'base64').toString('utf8');
    expect(script).toContain("RELAUNCH='next-start'");
    const again = await bootstrapLegacyRuntime(input(calls.patches.at(-1)!, 'daytona'), deps);
    expect(again.outcome).toBe('staged');
    expect(calls.execs).toHaveLength(1);
  });

  test('a rotated session PAT is handed to the script; none when nothing to rotate', async () => {
    const calls: Calls = { patches: [], audits: [], execs: [] };
    const deps = makeDeps({ rotateKortixToken: async () => 'kortix_pat_xxxxxxxx' }, calls);
    expect((await bootstrapLegacyRuntime(input(), deps)).outcome).toBe('converged');
    const script = Buffer.from(calls.execs[0][2].split("'")[3], 'base64').toString('utf8');
    expect(script).toContain("NEW_KORTIX_TOKEN='kortix_pat_xxxxxxxx'");
    expect(script).toContain('KORTIX_TOKEN rotated');
    const none = makeDeps({ rotateKortixToken: async () => null }, calls);
    await bootstrapLegacyRuntime(input(), none);
    const script2 = Buffer.from(calls.execs[1][2].split("'")[3], 'base64').toString('utf8');
    expect(script2).toContain("NEW_KORTIX_TOKEN=''");
    expect(() => renderLegacyBootstrapScript({ relaunch: 'pt-app', kortixToken: "x'; rm -rf /" })).toThrow();
    // next-start providers never rotate: the provider owns the daemon's env.
    let minted = 0;
    const daytona = makeDeps({ health: [LEGACY_HEALTH, LEGACY_HEALTH], rotateKortixToken: async () => { minted++; return 'kortix_pat_x'; }, exec: async (cmd) => { calls.execs.push(cmd); return { exitCode: 0, stdout: '{"ok":true,"stage":"staged"}\n', stderr: '' }; } }, calls);
    await bootstrapLegacyRuntime(input(null, 'daytona'), daytona);
    expect(minted).toBe(0);
  });

  test('an in-progress attempt younger than the stale window is not duplicated', async () => {
    const calls: Calls = { patches: [], audits: [], execs: [] };
    const clock = { t: Date.parse('2026-09-01T12:00:00Z') };
    const meta = { [LEGACY_BOOTSTRAP_METADATA_KEY]: { state: 'running', attempts: 1, manifestBuild: 1788044234, lastAttemptAt: new Date(clock.t - 60_000).toISOString() } };
    expect((await bootstrapLegacyRuntime(input(meta), makeDeps({}, calls, clock))).outcome).toBe('skipped-in-progress');
    expect(calls.execs).toHaveLength(0);
  });

  test('unsupported provider is skipped before any probe', async () => {
    const calls: Calls = { patches: [], audits: [], execs: [] };
    expect((await bootstrapLegacyRuntime(input(null, 'local'), makeDeps({}, calls))).outcome).toBe('skipped-unsupported');
  });

  test('a pinned (blocked) daemon is NEVER repaired, never looped — surfaced and left alone, even with force', async () => {
    const calls: Calls = { patches: [], audits: [], execs: [] };
    const pinned = {
      daemon: 'ok',
      opencode: 'ok',
      uptime_s: 2745710,
      runtime: {
        build: 1790538288,
        components: { cli: 'failed', skills: 'current', agent: 'staged', opencode: 'current' },
        agentSwapPending: true,
        pinned: true,
      },
    };
    const deps = makeDeps({ health: [pinned] }, calls);
    const r = await bootstrapLegacyRuntime(input(), deps);
    expect(r.outcome).toBe('skipped-blocked');
    expect(r.classification?.klass).toBe('blocked');
    expect(calls.execs).toHaveLength(0); // no relaunch was attempted
    // Even an operator's --force must not loop a repair on a box the
    // supervisor itself already rolled back and latched off.
    const forced = await bootstrapLegacyRuntime({ ...input(), force: true }, makeDeps({ health: [pinned] }, calls));
    expect(forced.outcome).toBe('skipped-blocked');
    expect(calls.execs).toHaveLength(0);
  });
});

describe('bootstrapLegacyRuntime — dead daemon on a running box', () => {
  const LOOPBACK = 'http://127.0.0.1:8000/kortix/health';

  test('a daemon alive on the box loopback ends the pass before any record, token or script', async () => {
    const calls: Calls = { patches: [], audits: [], execs: [] };
    let minted = 0;
    const r = await bootstrapLegacyRuntime(
      input(),
      makeDeps(
        {
          health: [null, null],
          providerRunning: async () => true,
          rotateKortixToken: async () => {
            minted++;
            return 'kortix_pat_x';
          },
          exec: async (cmd) => {
            calls.execs.push(cmd);
            return { exitCode: 0, stdout: '', stderr: '' };
          },
        },
        calls,
      ),
    );
    expect(r.outcome).toBe('not-legacy');
    expect(calls.execs).toHaveLength(1);
    expect(calls.execs[0]!.join(' ')).toContain(LOOPBACK);
    expect(calls.patches).toHaveLength(0);
    expect(calls.audits).toHaveLength(0);
    expect(minted).toBe(0);
  });

  test('a daemon silent on the loopback too is relaunched', async () => {
    const calls: Calls = { patches: [], audits: [], execs: [] };
    await bootstrapLegacyRuntime(
      input(),
      makeDeps(
        {
          health: [null, null, CURRENT_HEALTH],
          providerRunning: async () => true,
          exec: async (cmd) => {
            calls.execs.push(cmd);
            return cmd.join(' ').includes(LOOPBACK)
              ? { exitCode: 7, stdout: '', stderr: 'connection refused' }
              : { exitCode: 0, stdout: '{"ok":true,"stage":"relaunched","agent_sha256":"a","entrypoint_sha256":"e"}\n', stderr: '' };
          },
        },
        calls,
      ),
    );
    expect(calls.execs).toHaveLength(2);
    expect(calls.execs[1]![0]).toBe('bash');
    expect(calls.execs[1]!.join(' ')).not.toContain(LOOPBACK);
  });
});
