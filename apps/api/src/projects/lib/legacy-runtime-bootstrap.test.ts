import { describe, expect, test } from 'bun:test';
import type { SandboxExecResult } from '../../platform/providers';
import {
  LEGACY_BOOTSTRAP_COOLDOWN_MS,
  LEGACY_BOOTSTRAP_MAX_ATTEMPTS,
  LEGACY_BOOTSTRAP_METADATA_KEY,
  LEGACY_CHECK_METADATA_KEY,
  LEGACY_CHECK_TTL_MS,
  bootstrapExecCommand,
  bootstrapLegacyRuntime,
  classifyDaemonHealth,
  parseScriptReport,
  relaunchStrategyFor,
  renderLegacyBootstrapScript,
  type LegacyBootstrapDeps,
} from './legacy-runtime-bootstrap';

const LEGACY_HEALTH = { daemon: 'ok', status: 'ok', opencode: 'ok', runtimeReady: true, uptime_s: 3514521 };
const CURRENT_HEALTH = {
  daemon: 'ok',
  opencode: 'ok',
  runtime: { build: 1788044234, components: { agent: 'current', opencode: 'current' } },
};

describe('classifyDaemonHealth', () => {
  test('no runtime block on an ok daemon = legacy', () => {
    expect(classifyDaemonHealth(LEGACY_HEALTH).klass).toBe('legacy');
  });
  test('runtime block = current, with build and opencode component', () => {
    const c = classifyDaemonHealth(CURRENT_HEALTH);
    expect(c).toEqual({ klass: 'current', runtimeBuild: 1788044234, opencode: 'ok', opencodeComponent: 'current' });
  });
  test('null / non-object = unreachable, daemon not ok = not-ok', () => {
    expect(classifyDaemonHealth(null).klass).toBe('unreachable');
    expect(classifyDaemonHealth('x').klass).toBe('unreachable');
    expect(classifyDaemonHealth({ daemon: 'starting' }).klass).toBe('not-ok');
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
    const updated = { daemon: 'ok', opencode: 'ok', runtime: { build: 1788044234, components: { agent: 'current', opencode: 'updated' } } };
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
    const failedOc = { daemon: 'ok', opencode: 'ok', runtime: { build: 1788044234, components: { agent: 'current', opencode: 'failed' } } };
    const r = await bootstrapLegacyRuntime(input(), makeDeps({ health: [LEGACY_HEALTH, failedOc] }, calls));
    expect(r.outcome).toBe('failed');
    expect(r.detail).toBe('opencode convergence failed');
    expect((calls.patches.at(-1)![LEGACY_BOOTSTRAP_METADATA_KEY] as { error: string }).error).toContain('OpenCode install failed');
  });

  test('a daemon with a runtime block but no convergence pass yet is left alone', async () => {
    const calls: Calls = { patches: [], audits: [], execs: [] };
    const pending = { daemon: 'ok', opencode: 'ok', runtime: { build: null, components: {} } };
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
});
