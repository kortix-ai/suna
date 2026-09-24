import { describe, expect, test } from 'bun:test';
import type { SandboxExecResult } from '../../platform/providers';
import {
  TMP_MAINTENANCE_FAILURE_COOLDOWN_MS,
  TMP_MAINTENANCE_INTERVAL_MS,
  TMP_MAINTENANCE_METADATA_KEY,
  parseTmpMaintenanceMode,
  parseTmpMaintenanceReport,
  renderTmpMaintenanceScript,
  runTmpMaintenance,
  tmpMaintenanceExecCommand,
  type TmpMaintenanceDeps,
  type TmpMaintenanceInput,
  type TmpMaintenanceReport,
} from './tmp-maintenance';

const NOW = Date.parse('2026-09-24T16:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function report(overrides: Partial<TmpMaintenanceReport> = {}): TmpMaintenanceReport {
  return {
    ok: true,
    mode: 'clean',
    gnu: true,
    tmp_fs: 'tmpfs',
    tmp_fs_after: 'tmpfs',
    mem_total_kb: 4009024,
    shmem_before_kb: 1999320,
    shmem_after_kb: 3000,
    tmp_used_before_kb: 1994000,
    tmp_used_after_kb: 1000,
    tmp_size_kb: 2004512,
    partials_kb: 1993000,
    partials: 6,
    aged_kb: 0,
    aged: 0,
    evicted_kb: 0,
    evicted: 0,
    migrated: false,
    migrate_blocker: '',
    error: '',
    ...overrides,
  };
}

function harness(opts: {
  report?: TmpMaintenanceReport | null;
  execThrows?: string;
  opencode?: Record<string, unknown> | null;
} = {}) {
  const patches: Array<Record<string, unknown>> = [];
  const audits: Array<{ outcome: string; phase: string; summary: Record<string, unknown> }> = [];
  const execs: Array<{ command: string[]; timeoutMs: number }> = [];
  let statusProbes = 0;
  const deps: TmpMaintenanceDeps = {
    now: () => NOW,
    exec: async (command, timeoutMs) => {
      execs.push({ command, timeoutMs });
      if (opts.execThrows) throw new Error(opts.execThrows);
      const r = opts.report === undefined ? report() : opts.report;
      return { exitCode: 0, stdout: r ? `noise\n${JSON.stringify(r)}\n` : 'garbage', stderr: '' } as SandboxExecResult;
    },
    fetchOpencodeStatus: async () => {
      statusProbes += 1;
      return opts.opencode === undefined ? {} : opts.opencode;
    },
    patchMetadata: async (patch) => {
      patches.push(patch);
    },
    audit: async (event) => {
      audits.push(event);
    },
    log: () => {},
  };
  const last = () => patches.at(-1)?.[TMP_MAINTENANCE_METADATA_KEY] as Record<string, unknown> | undefined;
  return { deps, patches, audits, execs, last, probes: () => statusProbes };
}

const input = (over: Partial<TmpMaintenanceInput> = {}): TmpMaintenanceInput => ({
  sandboxId: 'sbx-1',
  externalId: 'sbx_ext',
  provider: 'platinum',
  metadata: null,
  mode: 'clean',
  reason: 'reaper',
  ...over,
});

/** The script the exec carried, decoded from its base64 argv. */
function scriptOf(command: string[]): string {
  const b64 = /printf '%s' '([A-Za-z0-9+/=]+)'/.exec(command[2] ?? '')?.[1] ?? '';
  return Buffer.from(b64, 'base64').toString('utf8');
}

describe('parseTmpMaintenanceMode', () => {
  test('unset or unknown means report: measure, change nothing', () => {
    expect(parseTmpMaintenanceMode(undefined)).toBe('report');
    expect(parseTmpMaintenanceMode('')).toBe('report');
    expect(parseTmpMaintenanceMode('yolo')).toBe('report');
  });
  test('the four modes parse, case-insensitively', () => {
    expect(parseTmpMaintenanceMode('off')).toBe('off');
    expect(parseTmpMaintenanceMode(' Clean ')).toBe('clean');
    expect(parseTmpMaintenanceMode('MIGRATE')).toBe('migrate');
  });
});

describe('renderTmpMaintenanceScript / exec command', () => {
  test('fills every placeholder and never writes itself under /tmp', () => {
    const s = renderTmpMaintenanceScript({ mode: 'migrate', allowMigrate: true });
    expect(s).not.toContain('__');
    expect(s).toContain("MODE='migrate'");
    expect(s).toContain("TMP='/tmp'");
    expect(s).toContain("ALLOW_MIGRATE='1'");
    const argv = tmpMaintenanceExecCommand(s);
    expect(argv[2]).toContain('| base64 -d | bash -s');
    expect(argv[2]).not.toContain('> /tmp');
    expect(scriptOf(argv)).toBe(s);
  });
  test('refuses a tmpDir that could inject shell', () => {
    expect(() => renderTmpMaintenanceScript({ mode: 'clean', allowMigrate: false, tmpDir: "/tmp'; rm -rf /" })).toThrow('unsafe tmpDir');
  });
});

describe('parseTmpMaintenanceReport', () => {
  test('takes the last JSON line; anything else is no report', () => {
    const r = report();
    expect(parseTmpMaintenanceReport({ exitCode: 0, stdout: `x\n${JSON.stringify(r)}\n`, stderr: '' } as SandboxExecResult)).toEqual(r);
    expect(parseTmpMaintenanceReport({ exitCode: 1, stdout: 'boom', stderr: '' } as SandboxExecResult)).toBeNull();
  });
});

describe('runTmpMaintenance gates', () => {
  test('off and unsupported providers never touch the box', async () => {
    const h = harness();
    expect((await runTmpMaintenance(input({ mode: 'off' }), h.deps)).outcome).toBe('skipped-off');
    expect((await runTmpMaintenance(input({ provider: 'local' }), h.deps)).outcome).toBe('skipped-unsupported');
    expect(h.execs).toHaveLength(0);
  });

  test('never runs beside a legacy runtime bootstrap in flight', async () => {
    const h = harness();
    const metadata = { legacyRuntimeBootstrap: { state: 'running', lastAttemptAt: ago(60_000) } };
    expect((await runTmpMaintenance(input({ metadata }), h.deps)).outcome).toBe('skipped-legacy-bootstrap');
    expect(h.execs).toHaveLength(0);
  });

  test('a run in flight is left alone until its stamp goes stale', async () => {
    const h = harness();
    const running = { [TMP_MAINTENANCE_METADATA_KEY]: { state: 'running', mode: 'clean', lastRunAt: ago(60_000), failures: 0 } };
    expect((await runTmpMaintenance(input({ metadata: running }), h.deps)).outcome).toBe('skipped-in-progress');
    const stale = { [TMP_MAINTENANCE_METADATA_KEY]: { state: 'running', mode: 'clean', lastRunAt: ago(11 * 60_000), failures: 0 } };
    expect((await runTmpMaintenance(input({ metadata: stale }), h.deps)).outcome).toBe('done');
  });

  test('hourly: a box cleaned in the last hour is not due; force (the memory guard) skips the wait', async () => {
    const h = harness();
    const recent = { [TMP_MAINTENANCE_METADATA_KEY]: { state: 'done', mode: 'clean', lastRunAt: ago(10 * 60_000), failures: 0 } };
    expect((await runTmpMaintenance(input({ metadata: recent }), h.deps)).outcome).toBe('skipped-interval');
    expect((await runTmpMaintenance(input({ metadata: recent, force: true }), h.deps)).outcome).toBe('done');
    const due = { [TMP_MAINTENANCE_METADATA_KEY]: { state: 'done', mode: 'clean', lastRunAt: ago(TMP_MAINTENANCE_INTERVAL_MS + 1), failures: 0 } };
    expect((await runTmpMaintenance(input({ metadata: due }), h.deps)).outcome).toBe('done');
  });

  test('a mode change is due at once: flipping report to clean does not wait an hour', async () => {
    const h = harness();
    const reported = { [TMP_MAINTENANCE_METADATA_KEY]: { state: 'done', mode: 'report', lastRunAt: ago(60_000), failures: 0 } };
    expect((await runTmpMaintenance(input({ metadata: reported, mode: 'clean' }), h.deps)).outcome).toBe('done');
  });

  test('after a failure it waits out the cooldown, even when forced', async () => {
    const h = harness();
    const failed = { [TMP_MAINTENANCE_METADATA_KEY]: { state: 'failed', mode: 'clean', lastRunAt: ago(60_000), failures: 1 } };
    expect((await runTmpMaintenance(input({ metadata: failed, force: true }), h.deps)).outcome).toBe('skipped-cooldown');
    const old = { [TMP_MAINTENANCE_METADATA_KEY]: { state: 'failed', mode: 'clean', lastRunAt: ago(TMP_MAINTENANCE_FAILURE_COOLDOWN_MS + 1), failures: 1 } };
    expect((await runTmpMaintenance(input({ metadata: old }), h.deps)).outcome).toBe('done');
  });
});

describe('runTmpMaintenance migration decision', () => {
  test('migrate on an idle Platinum runtime allows the move', async () => {
    const h = harness({ opencode: {} });
    await runTmpMaintenance(input({ mode: 'migrate' }), h.deps);
    expect(scriptOf(h.execs[0]!.command)).toContain("ALLOW_MIGRATE='1'");
  });

  test('a busy or unreachable OpenCode defers the move but still cleans', async () => {
    for (const [opencode, blocker] of [[{ ses_1: { type: 'busy' } }, 'opencode-busy'], [null, 'opencode-unreachable']] as const) {
      const h = harness({ opencode });
      const r = await runTmpMaintenance(input({ mode: 'migrate' }), h.deps);
      expect(r.outcome).toBe('done');
      expect(scriptOf(h.execs[0]!.command)).toContain("ALLOW_MIGRATE='0'");
      expect(h.last()?.migrateBlocker).toBe(blocker);
    }
  });

  test('clean never probes OpenCode and never migrates; Daytona never migrates', async () => {
    const clean = harness();
    await runTmpMaintenance(input({ mode: 'clean' }), clean.deps);
    expect(clean.probes()).toBe(0);
    expect(scriptOf(clean.execs[0]!.command)).toContain("ALLOW_MIGRATE='0'");
    const daytona = harness();
    await runTmpMaintenance(input({ mode: 'migrate', provider: 'daytona' }), daytona.deps);
    expect(daytona.probes()).toBe(0);
    expect(scriptOf(daytona.execs[0]!.command)).toContain("ALLOW_MIGRATE='0'");
  });
});

describe('runTmpMaintenance records and audit', () => {
  test('a run stamps running first, then records what it freed', async () => {
    const h = harness();
    const r = await runTmpMaintenance(input(), h.deps);
    expect(r.outcome).toBe('done');
    expect((h.patches[0]![TMP_MAINTENANCE_METADATA_KEY] as Record<string, unknown>).state).toBe('running');
    expect(h.last()).toMatchObject({
      state: 'done',
      mode: 'clean',
      failures: 0,
      partialsKb: 1993000,
      shmemBeforeKb: 1999320,
      shmemAfterKb: 3000,
      migrated: false,
    });
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]).toMatchObject({ outcome: 'success', phase: 'cleaned' });
  });

  test('a migration is recorded with its time and no blocker', async () => {
    const h = harness({ report: report({ migrated: true, tmp_fs_after: 'ext4' }) });
    await runTmpMaintenance(input({ mode: 'migrate' }), h.deps);
    expect(h.last()).toMatchObject({ migrated: true, migratedAt: new Date(NOW).toISOString(), tmpFsAfter: 'ext4' });
    expect(h.last()?.migrateBlocker).toBeUndefined();
    expect(h.audits[0]).toMatchObject({ phase: 'migrated' });
  });

  test('report mode audits what it would free, as `reported`', async () => {
    const h = harness({ report: report({ mode: 'report' }) });
    await runTmpMaintenance(input({ mode: 'report' }), h.deps);
    expect(h.audits[0]).toMatchObject({ outcome: 'success', phase: 'reported' });
  });

  test('an hourly run that freed nothing is recorded but not audited', async () => {
    const h = harness({ report: report({ partials_kb: 0, partials: 0 }) });
    await runTmpMaintenance(input(), h.deps);
    expect(h.last()?.state).toBe('done');
    expect(h.audits).toHaveLength(0);
  });

  test('exec failure, a missing report, and a script error each fail, count, and audit', async () => {
    for (const h of [
      harness({ execThrows: 'socket hang up' }),
      harness({ report: null }),
      harness({ report: report({ ok: false, error: 'migrate failed' }) }),
    ]) {
      const metadata = { [TMP_MAINTENANCE_METADATA_KEY]: { state: 'done', mode: 'clean', lastRunAt: ago(2 * TMP_MAINTENANCE_INTERVAL_MS), failures: 2 } };
      const r = await runTmpMaintenance(input({ metadata }), h.deps);
      expect(r.outcome).toBe('failed');
      expect(h.last()).toMatchObject({ state: 'failed', failures: 3 });
      expect(h.audits[0]).toMatchObject({ outcome: 'failure', phase: 'failed' });
    }
  });
});
