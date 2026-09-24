/**
 * /tmp maintenance for sandboxes that already exist.
 *
 * THE PROBLEM. Platinum's pt-init mounts /tmp as a tmpfs at 50% of RAM. A
 * guest has no swap, and a memory snapshot keeps the tmpfs across stop/start,
 * so every byte written to /tmp is RAM the agent never gets back. Prod
 * 2026-09-24: 2 of 17 active 4 GiB sandboxes had /tmp full (1.96 GiB) — one
 * with abandoned legacy-transfer uploads from 8 days earlier, one with agent
 * virtualenvs — and the memory guard stopped their turns on every command.
 * Platinum PR #1255 gives new templates a size-capped disk /tmp with an hourly
 * sweeper. A running or resumed box never re-runs pt-init, so it never gets
 * that fix.
 *
 * THE MECHANISM. The reaper visits every running box; this module decides
 * whether a box is due and runs `tmp-maintenance.sh` as root through the
 * provider's exec channel, like the legacy runtime bootstrap. The script:
 *   1. deletes abandoned legacy-transfer uploads (`.transfer-*`, idle 1 h);
 *   2. deletes what nobody read, wrote or changed in 10 days;
 *   3. in `migrate` mode, on an idle Platinum runtime, moves a tmpfs /tmp onto
 *      the same size-capped disk image #1255 mounts at boot;
 *   4. trims the least recently read files when /tmp is crowded — against RAM
 *      for a tmpfs, against its own size on disk — never one used in 1 h.
 *
 * The mode is a per-environment switch (`SANDBOX_TMP_MAINTENANCE`):
 * off | report | clean | migrate. `report` changes nothing and records what
 * the other modes would do, so a rollout starts with numbers.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { SandboxExecResult } from '../../platform/providers';

export const TMP_MAINTENANCE_METADATA_KEY = 'tmpMaintenance';
/** A box that ran clean less than this long ago is left alone (the sweeper's cadence). */
export const TMP_MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000;
/** After a failed run, wait this long — also for a forced run. */
export const TMP_MAINTENANCE_FAILURE_COOLDOWN_MS = 30 * 60 * 1000;
/** A `running` stamp older than this is a crashed run, not a live one. */
export const TMP_MAINTENANCE_STALE_RUNNING_MS = 10 * 60 * 1000;
/** Budget for the in-box script: a migration copies up to ~70% of the image cap. */
export const TMP_MAINTENANCE_EXEC_TIMEOUT_MS = 3 * 60 * 1000;

export type TmpMaintenanceMode = 'off' | 'report' | 'clean' | 'migrate';

const MODES: readonly TmpMaintenanceMode[] = ['off', 'report', 'clean', 'migrate'];

/** The environment's mode. Unset or unknown = `report`: measure, change nothing. */
export function parseTmpMaintenanceMode(raw: string | undefined): TmpMaintenanceMode {
  const value = (raw ?? '').trim().toLowerCase();
  return (MODES as readonly string[]).includes(value) ? (value as TmpMaintenanceMode) : 'report';
}

/** Providers with a root exec channel into the box. */
export function providerSupportsTmpMaintenance(provider: string): boolean {
  return provider === 'platinum' || provider === 'daytona' || provider === 'e2b';
}

let scriptTemplate: string | null = null;
function loadScriptTemplate(): string {
  if (scriptTemplate === null) {
    scriptTemplate = readFileSync(fileURLToPath(new URL('./tmp-maintenance.sh', import.meta.url)), 'utf8');
  }
  return scriptTemplate;
}

export interface RenderTmpScriptOptions {
  mode: Exclude<TmpMaintenanceMode, 'off'>;
  /** Whether step 3 may run: Platinum, `migrate` mode, idle runtime. */
  allowMigrate: boolean;
  /** Tests point this at a scratch directory; production is always /tmp. */
  tmpDir?: string;
}

export function renderTmpMaintenanceScript(opts: RenderTmpScriptOptions): string {
  const tmpDir = opts.tmpDir ?? '/tmp';
  if (!/^\/[A-Za-z0-9_./-]+$/.test(tmpDir)) throw new Error('unsafe tmpDir');
  const template = loadScriptTemplate();
  for (const placeholder of ['__MODE__', '__TMP_DIR__', '__ALLOW_MIGRATE__']) {
    if (!template.includes(placeholder)) throw new Error(`tmp maintenance script lacks ${placeholder}`);
  }
  return template
    .replace('__MODE__', opts.mode)
    .replace('__TMP_DIR__', tmpDir)
    .replace('__ALLOW_MIGRATE__', opts.allowMigrate ? '1' : '0');
}

/**
 * The provider `exec` argv. The script travels base64 and runs from stdin: a
 * copy written under /tmp would be moved by the very migration it performs.
 */
export function tmpMaintenanceExecCommand(script: string): string[] {
  const b64 = Buffer.from(script, 'utf8').toString('base64');
  return ['bash', '-c', `printf '%s' '${b64}' | base64 -d | bash -s`];
}

export interface TmpMaintenanceReport {
  ok: boolean;
  mode: string;
  gnu: boolean;
  tmp_fs: string;
  tmp_fs_after: string;
  mem_total_kb: number;
  shmem_before_kb: number;
  shmem_after_kb: number;
  tmp_used_before_kb: number;
  tmp_used_after_kb: number;
  tmp_size_kb: number;
  partials_kb: number;
  partials: number;
  aged_kb: number;
  aged: number;
  evicted_kb: number;
  evicted: number;
  migrated: boolean;
  migrate_blocker: string;
  error: string;
}

/** The script's last JSON stdout line is its report. Anything else is a transport failure. */
export function parseTmpMaintenanceReport(result: SandboxExecResult): TmpMaintenanceReport | null {
  const lines = result.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (typeof parsed.ok === 'boolean' && typeof parsed.mode === 'string' && typeof parsed.tmp_fs === 'string') {
        return parsed as unknown as TmpMaintenanceReport;
      }
    } catch {
      /* not the report line */
    }
  }
  return null;
}

export type TmpMaintenanceState = 'running' | 'done' | 'failed';

/** What sandbox metadata keeps about the last run. */
export interface TmpMaintenanceRecord {
  state: TmpMaintenanceState;
  mode: TmpMaintenanceMode;
  lastRunAt: string;
  finishedAt?: string;
  reason?: string;
  /** Consecutive failures; a success resets it. */
  failures: number;
  tmpFs?: string;
  tmpFsAfter?: string;
  shmemBeforeKb?: number;
  shmemAfterKb?: number;
  tmpUsedBeforeKb?: number;
  tmpUsedAfterKb?: number;
  /** Deleted (clean/migrate) or deletable (report), by kind. */
  partialsKb?: number;
  agedKb?: number;
  evictedKb?: number;
  migrated?: boolean;
  migratedAt?: string;
  migrateBlocker?: string;
  error?: string;
}

export type TmpMaintenanceOutcome =
  | 'skipped-off'
  | 'skipped-unsupported'
  | 'skipped-legacy-bootstrap'
  | 'skipped-in-progress'
  | 'skipped-cooldown'
  | 'skipped-interval'
  | 'done'
  | 'failed';

export interface TmpMaintenanceInput {
  sandboxId: string;
  externalId: string;
  provider: string;
  metadata: Record<string, unknown> | null | undefined;
  mode: TmpMaintenanceMode;
  /** Who asked: 'reaper' | 'memory-guard' | ... — recorded, never acted on. */
  reason: string;
  /** Skip the interval (the memory guard just fired). The failure cooldown still applies. */
  force?: boolean;
}

export interface TmpMaintenanceDeps {
  now: () => number;
  exec: (command: string[], timeoutMs: number) => Promise<SandboxExecResult>;
  /** OpenCode /session/status JSON (empty object = idle), or null when unreachable. */
  fetchOpencodeStatus: () => Promise<Record<string, unknown> | null>;
  patchMetadata: (patch: Record<string, unknown>) => Promise<void>;
  audit: (event: {
    outcome: 'success' | 'failure';
    phase: string;
    summary: Record<string, unknown>;
    error?: string;
  }) => Promise<void>;
  log: (message: string, context?: Record<string, unknown>) => void;
}

export interface TmpMaintenanceResult {
  outcome: TmpMaintenanceOutcome;
  detail?: string;
  report?: TmpMaintenanceReport;
}

export function readTmpMaintenanceRecord(
  metadata: Record<string, unknown> | null | undefined,
): TmpMaintenanceRecord | null {
  const raw = metadata?.[TMP_MAINTENANCE_METADATA_KEY];
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.state !== 'string' || typeof r.lastRunAt !== 'string') return null;
  return { ...(r as unknown as TmpMaintenanceRecord), failures: typeof r.failures === 'number' ? r.failures : 0 };
}

/** The legacy runtime bootstrap relaunches the runtime; never run beside it. */
function legacyBootstrapRunning(metadata: Record<string, unknown> | null | undefined, nowMs: number): boolean {
  const raw = metadata?.legacyRuntimeBootstrap;
  if (!raw || typeof raw !== 'object') return false;
  const r = raw as Record<string, unknown>;
  if (r.state !== 'running' || typeof r.lastAttemptAt !== 'string') return false;
  const at = Date.parse(r.lastAttemptAt);
  return Number.isFinite(at) && nowMs - at < 20 * 60 * 1000;
}

function ageMs(iso: string | undefined, nowMs: number): number {
  const at = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(at) ? nowMs - at : Number.POSITIVE_INFINITY;
}

/**
 * Decide, and when due do, one maintenance run for one sandbox. Pure over
 * `deps`, so the policy is unit-testable and the wiring (DB, provider,
 * ingress, audit) lives in tmp-maintenance-wiring.ts.
 */
export async function runTmpMaintenance(
  input: TmpMaintenanceInput,
  deps: TmpMaintenanceDeps,
): Promise<TmpMaintenanceResult> {
  if (input.mode === 'off') return { outcome: 'skipped-off' };
  if (!providerSupportsTmpMaintenance(input.provider)) {
    return { outcome: 'skipped-unsupported', detail: `provider ${input.provider}` };
  }
  const nowMs = deps.now();
  if (legacyBootstrapRunning(input.metadata, nowMs)) return { outcome: 'skipped-legacy-bootstrap' };

  const record = readTmpMaintenanceRecord(input.metadata);
  if (record?.state === 'running' && ageMs(record.lastRunAt, nowMs) < TMP_MAINTENANCE_STALE_RUNNING_MS) {
    return { outcome: 'skipped-in-progress' };
  }
  if (record?.state === 'failed' && ageMs(record.lastRunAt, nowMs) < TMP_MAINTENANCE_FAILURE_COOLDOWN_MS) {
    return { outcome: 'skipped-cooldown' };
  }
  // A new mode is due at once: flipping report -> clean must not wait an hour.
  if (
    !input.force &&
    record?.state === 'done' &&
    record.mode === input.mode &&
    ageMs(record.lastRunAt, nowMs) < TMP_MAINTENANCE_INTERVAL_MS
  ) {
    return { outcome: 'skipped-interval' };
  }

  // Moving /tmp under a running turn could pull a file out from under a tool,
  // so a migration needs OpenCode's own idle verdict. Cleaning never does:
  // it only takes files idle for an hour or more.
  let allowMigrate = false;
  let migrateDeferred: string | null = null;
  if ((input.mode === 'migrate' || input.mode === 'report') && input.provider === 'platinum') {
    const status = await deps.fetchOpencodeStatus();
    allowMigrate = status !== null && Object.keys(status).length === 0;
    if (!allowMigrate) migrateDeferred = status ? 'opencode-busy' : 'opencode-unreachable';
  }

  const nowIso = new Date(nowMs).toISOString();
  const running: TmpMaintenanceRecord = {
    ...(record ?? { failures: 0 }),
    state: 'running',
    mode: input.mode,
    lastRunAt: nowIso,
    reason: input.reason,
    error: undefined,
  };
  await deps.patchMetadata({ [TMP_MAINTENANCE_METADATA_KEY]: running });

  const fail = async (error: string, detail: string): Promise<TmpMaintenanceResult> => {
    const failed: TmpMaintenanceRecord = {
      ...running,
      state: 'failed',
      finishedAt: new Date(deps.now()).toISOString(),
      failures: (record?.failures ?? 0) + 1,
      error: error.slice(0, 500),
    };
    await deps.patchMetadata({ [TMP_MAINTENANCE_METADATA_KEY]: failed });
    await deps.audit({
      outcome: 'failure',
      phase: 'failed',
      summary: { mode: input.mode, reason: input.reason, detail },
      error: failed.error,
    });
    deps.log('tmp maintenance failed', { sandboxId: input.sandboxId, detail, error: failed.error });
    return { outcome: 'failed', detail };
  };

  let execResult: SandboxExecResult;
  try {
    execResult = await deps.exec(
      tmpMaintenanceExecCommand(renderTmpMaintenanceScript({ mode: input.mode, allowMigrate })),
      TMP_MAINTENANCE_EXEC_TIMEOUT_MS,
    );
  } catch (error) {
    return fail(`exec: ${error instanceof Error ? error.message : String(error)}`, 'provider exec failed');
  }
  const report = parseTmpMaintenanceReport(execResult);
  if (!report) {
    const tail = (execResult.stderr || execResult.stdout).trim().slice(-400);
    return fail(`no report (exit ${execResult.exitCode}): ${tail}`, 'script produced no report');
  }
  if (!report.ok) return fail(report.error || 'script reported failure', 'script failed');

  const blocker = report.migrate_blocker || migrateDeferred || undefined;
  const done: TmpMaintenanceRecord = {
    ...running,
    state: 'done',
    finishedAt: new Date(deps.now()).toISOString(),
    failures: 0,
    tmpFs: report.tmp_fs,
    tmpFsAfter: report.tmp_fs_after,
    shmemBeforeKb: report.shmem_before_kb,
    shmemAfterKb: report.shmem_after_kb,
    tmpUsedBeforeKb: report.tmp_used_before_kb,
    tmpUsedAfterKb: report.tmp_used_after_kb,
    partialsKb: report.partials_kb,
    agedKb: report.aged_kb,
    evictedKb: report.evicted_kb,
    migrated: report.migrated,
    migratedAt: report.migrated ? nowIso : record?.migratedAt,
    migrateBlocker: report.tmp_fs_after === 'tmpfs' ? blocker : undefined,
  };
  await deps.patchMetadata({ [TMP_MAINTENANCE_METADATA_KEY]: done });

  // The audit ledger gets the runs that changed something — or, in report
  // mode, would have. An hourly no-op on every box is not an event.
  const freedKb = report.partials_kb + report.aged_kb + report.evicted_kb;
  if (freedKb > 0 || report.migrated) {
    await deps.audit({
      outcome: 'success',
      phase: input.mode === 'report' ? 'reported' : report.migrated ? 'migrated' : 'cleaned',
      summary: {
        mode: input.mode,
        reason: input.reason,
        tmpFs: report.tmp_fs,
        tmpFsAfter: report.tmp_fs_after,
        partialsKb: report.partials_kb,
        agedKb: report.aged_kb,
        evictedKb: report.evicted_kb,
        shmemBeforeKb: report.shmem_before_kb,
        shmemAfterKb: report.shmem_after_kb,
        migrated: report.migrated,
        migrateBlocker: done.migrateBlocker ?? null,
      },
    });
    deps.log(`tmp maintenance ${input.mode}`, {
      sandboxId: input.sandboxId,
      freedKb,
      migrated: report.migrated,
      shmemAfterKb: report.shmem_after_kb,
    });
  }
  return { outcome: 'done', report };
}
