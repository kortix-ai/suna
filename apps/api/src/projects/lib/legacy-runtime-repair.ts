/**
 * The repair state machine of the legacy runtime bootstrap: read the sandbox
 * metadata, classify the daemon (legacy-runtime-health.ts), and when the box
 * is legacy or stale, decide — under cooldown, attempt budget and OpenCode
 * idleness — whether to exec the script (legacy-runtime-script.ts) and poll
 * the relaunched daemon to convergence. Pure over injected deps; the DB,
 * provider and audit wiring lives in legacy-runtime-bootstrap-wiring.ts.
 */
import type { ProviderName, SandboxExecResult } from '../../platform/providers';
import {
  classifyDaemonHealth,
  type ExpectedRunningAssets,
  type RuntimeClassification,
  type RuntimeClass,
  type StaleReason,
} from './legacy-runtime-health';
import {
  bootstrapExecCommand,
  parseScriptReport,
  relaunchStrategyFor,
  renderLegacyBootstrapScript,
  type RelaunchStrategy,
} from './legacy-runtime-script';


export const LEGACY_BOOTSTRAP_METADATA_KEY = 'legacyRuntimeBootstrap';
export const LEGACY_CHECK_METADATA_KEY = 'legacyRuntimeCheck';

/** Re-check a box that last looked current after this long. */
export const LEGACY_CHECK_TTL_MS = 6 * 60 * 60 * 1000;
/** Wait this long after the FIRST failed attempt before the next one. */
export const LEGACY_BOOTSTRAP_COOLDOWN_MS = 30 * 60 * 1000;
/**
 * Ceiling for the escalating per-box backoff below. Chosen so a box that
 * keeps failing is retried less often each time it fails, without ever
 * waiting longer between attempts than the reaper's own `LEGACY_CHECK_TTL_MS`
 * re-check cadence for a healthy box — a repeatedly-failing box stays checked
 * at least as often as a converged one.
 */
export const LEGACY_BOOTSTRAP_MAX_COOLDOWN_MS = LEGACY_CHECK_TTL_MS;
/** Attempts per manifest build before the box is left for a human. */
export const LEGACY_BOOTSTRAP_MAX_ATTEMPTS = 3;

/**
 * Per-box backoff after a failed attempt: 30m, 60m, 120m, capped at
 * `LEGACY_BOOTSTRAP_MAX_COOLDOWN_MS`. Durable in the sandbox's own metadata
 * (`attempts` on `LegacyBootstrapRecord`) rather than in-process state, so it
 * holds across replicas and restarts — unlike the reaper's turn-probe
 * back-off (`probeBackoff` in box-reaper.ts), which is deliberately
 * per-replica because THAT signal resets the instant any replica gets a
 * readable answer. A repeatedly-failing box is not "one bad read away from
 * fine": widening the wait is the point.
 */
export function legacyBootstrapCooldownMs(attempts: number): number {
  const exponent = Math.max(0, attempts - 1);
  return Math.min(LEGACY_BOOTSTRAP_MAX_COOLDOWN_MS, LEGACY_BOOTSTRAP_COOLDOWN_MS * 2 ** exponent);
}
/** A `running` stamp older than this is a crashed attempt, not a live one. */
export const LEGACY_BOOTSTRAP_STALE_RUNNING_MS = 20 * 60 * 1000;
/** Budget for the in-box script (downloads ~100 MB + relaunch + health wait). */
const LEGACY_BOOTSTRAP_EXEC_TIMEOUT_MS = 5 * 60 * 1000;
/** After the relaunch, how long the new daemon may take to report a converged, serving OpenCode. */
export const LEGACY_BOOTSTRAP_CONVERGE_BUDGET_MS = 8 * 60 * 1000;
const LEGACY_BOOTSTRAP_POLL_MS = 5_000;


/** Gap between the two health reads that must BOTH be silent before a relaunch. */
const DEAD_DAEMON_CONFIRM_MS = 5_000;
/** The daemon as the box itself sees it — no provider ingress in the path. */
const LOOPBACK_HEALTH_URL = 'http://127.0.0.1:8000/kortix/health';
const LOOPBACK_PROBE_TIMEOUT_MS = 15_000;

/** Metadata stamp: when a session open asked for a dead-daemon relaunch. */
export const DEAD_DAEMON_REPAIR_REQUESTED_KEY = 'deadDaemonRepairRequestedAt';
/** One open-time relaunch: download + relaunch + the script's own health wait, then the open parks. */
export const DEAD_DAEMON_REPAIR_BUDGET_MS = 4 * 60_000;

type DeadDaemonOpenAction = 'request' | 'wait' | 'park';

/**
 * A provider-running box whose daemon stayed unreachable past the open budget.
 * Where the provider's init never relaunches the runtime (Platinum), parking it
 * only freezes the corpse: every later open resumes the same snapshot with
 * nothing on :8000, forever (prod 2026-09-28: 18 h, every `/start` parked it
 * again). So ask for the relaunch once per unreachable spell, and park only
 * after it had its chance. Daytona/E2B rerun the entrypoint on their next
 * start, so parking IS their repair.
 */
export function decideDeadDaemonOnOpen(input: {
  provider: string;
  metadata: Record<string, unknown> | null;
  unreachableSinceMs: number | null;
  nowMs: number;
}): DeadDaemonOpenAction {
  if (relaunchStrategyFor(input.provider) !== 'pt-app') return 'park';
  const requestedMs = Date.parse(String(input.metadata?.[DEAD_DAEMON_REPAIR_REQUESTED_KEY] ?? ''));
  if (!Number.isFinite(requestedMs)) return 'request';
  if (input.unreachableSinceMs !== null && requestedMs < input.unreachableSinceMs) return 'request';
  const record = readRecord(input.metadata);
  if (record?.state === 'failed' && Date.parse(record.finishedAt ?? record.lastAttemptAt) >= requestedMs) {
    return 'park';
  }
  return input.nowMs - requestedMs < DEAD_DAEMON_REPAIR_BUDGET_MS ? 'wait' : 'park';
}


type LegacyBootstrapState = 'running' | 'converged' | 'staged' | 'failed';

interface LegacyBootstrapRecord {
  state: LegacyBootstrapState;
  attempts: number;
  /** Manifest build the attempts were counted against; a new build resets the budget. */
  manifestBuild: number | null;
  lastAttemptAt: string;
  finishedAt?: string;
  reason?: string;
  from?: { opencode?: string | null };
  to?: { agentSha256?: string; entrypointSha256?: string; runtimeBuild?: number | null };
  error?: string;
  /** What this attempt was FOR — the classification that triggered it. Answers "why is this box stale" from metadata alone, without re-probing the box. */
  classification?: { klass: RuntimeClass; staleReasons: StaleReason[] };
}

interface LegacyCheckRecord {
  at: string;
  klass: RuntimeClass;
  /** `[]` for every klass but `stale`. */
  staleReasons: StaleReason[];
}

type LegacyBootstrapOutcome =
  | 'not-legacy'
  | 'unreachable'
  | 'skipped-recent-check'
  | 'skipped-cooldown'
  | 'skipped-exhausted'
  | 'skipped-in-progress'
  | 'skipped-busy'
  | 'skipped-unsupported'
  /** The daemon itself says it needs a human (pinned after a rollback). Never repaired, never looped — surfaced instead. */
  | 'skipped-blocked'
  | 'staged'
  | 'converged'
  | 'failed';

interface LegacyBootstrapInput {
  sandboxId: string;
  externalId: string;
  provider: ProviderName | string;
  metadata: Record<string, unknown> | null | undefined;
  /** Who asked: 'reaper' | 'sweep' | ... — recorded, never acted on. */
  reason: string;
  /** Skip the recent-check TTL (an operator sweep wants the truth now). */
  force?: boolean;
  /** Internal: this call is the relaunch pass after an OpenCode install. */
  postInstallPass?: boolean;
}

export interface LegacyBootstrapDeps {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Current manifest build of THIS control plane, for the attempt budget. */
  manifestBuild: () => Promise<number | null>;
  /** Daemon /kortix/health JSON, or null when unreachable. */
  fetchHealth: () => Promise<unknown>;
  /** OpenCode /session/status JSON (empty object = idle), or null when unreachable. */
  fetchOpencodeStatus: () => Promise<Record<string, unknown> | null>;
  /**
   * Does the PROVIDER say this box is running right now? Asked only when the
   * daemon answers nothing, which is the one case where the two can disagree
   * about whether anything is there to repair.
   */
  providerRunning?: () => Promise<boolean>;
  /** This deploy's manifest shas, for the `running_assets_stale` sha-to-sha compare. Omit (or resolve null) to skip that one check — `running_assets_unreported` still catches a daemon that reports no `running` block at all. */
  expectedRunningAssets?: () => Promise<ExpectedRunningAssets | null>;
  exec: (command: string[], timeoutMs: number) => Promise<SandboxExecResult>;
  /** Entrypoint text to embed for an API that predates the asset; null when unavailable. */
  entrypointSource?: () => string | null;
  /** Fleet pnpm version to install on a box whose pnpm predates `--allow-build`. */
  pnpmVersion?: () => string | null;
  /**
   * When the box still carries the pre-2026-08 `kortix_sb_` service key as its
   * KORTIX_TOKEN, mint a session PAT, store it as the sandbox service key, and
   * return the secret for the script to install. Null = nothing to rotate.
   */
  rotateKortixToken?: () => Promise<string | null>;
  /**
   * The box reported whether it installed the rotated token (`null` = the
   * script's report never arrived). The wiring stores the new service key
   * only once the box provably holds it, or verifies by probing.
   */
  commitKortixToken?: (secret: string, rotatedOnBox: boolean | null) => Promise<void>;
  /**
   * Mint the credential this repair runs on, and the call that revokes it.
   *
   * The script used to authenticate its manifest fetch and every asset
   * download with the box's OWN token — which a wrong `stopped` row has
   * already killed (repositories/account-tokens.ts refuses a session
   * credential whose sandbox row is not `provisioning`/`active`). So the cure
   * needed the very credential the disease destroys. Null = no credential
   * could be minted; the script falls back to the box's own token.
   */
  mintRepairToken?: () => Promise<{ secret: string; release: () => Promise<void> } | null>;
  patchMetadata: (patch: Record<string, unknown>) => Promise<void>;
  audit: (event: {
    outcome: 'success' | 'failure';
    phase: string;
    summary: Record<string, unknown>;
    error?: string;
  }) => Promise<void>;
  log: (message: string, context?: Record<string, unknown>) => void;
}

export interface LegacyBootstrapResult {
  outcome: LegacyBootstrapOutcome;
  detail?: string;
  classification?: RuntimeClassification;
}

function readClassificationSnapshot(
  raw: Record<string, unknown>,
): { klass: RuntimeClass; staleReasons: StaleReason[] } | undefined {
  const c = raw.classification;
  if (!c || typeof c !== 'object') return undefined;
  const cr = c as Record<string, unknown>;
  if (typeof cr.klass !== 'string') return undefined;
  return {
    klass: cr.klass as RuntimeClass,
    staleReasons: Array.isArray(cr.staleReasons) ? (cr.staleReasons as StaleReason[]) : [],
  };
}

function readRecord(metadata: Record<string, unknown> | null | undefined): LegacyBootstrapRecord | null {
  const raw = metadata?.[LEGACY_BOOTSTRAP_METADATA_KEY];
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.state !== 'string' || typeof r.lastAttemptAt !== 'string') return null;
  return {
    state: r.state as LegacyBootstrapState,
    attempts: typeof r.attempts === 'number' ? r.attempts : 0,
    manifestBuild: typeof r.manifestBuild === 'number' ? r.manifestBuild : null,
    lastAttemptAt: r.lastAttemptAt,
    finishedAt: typeof r.finishedAt === 'string' ? r.finishedAt : undefined,
    error: typeof r.error === 'string' ? r.error : undefined,
    classification: readClassificationSnapshot(r),
  };
}

function readCheck(metadata: Record<string, unknown> | null | undefined): LegacyCheckRecord | null {
  const raw = metadata?.[LEGACY_CHECK_METADATA_KEY];
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.at !== 'string' || typeof r.klass !== 'string') return null;
  return {
    at: r.at,
    klass: r.klass as RuntimeClass,
    // Absent on a check written before this deploy — never invented.
    staleReasons: Array.isArray(r.staleReasons) ? (r.staleReasons as StaleReason[]) : [],
  };
}

export function opencodeIdle(status: Record<string, unknown> | null): boolean {
  if (!status) return false;
  return Object.keys(status).length === 0;
}

/** Attempts a record counts against THIS manifest build; a new build resets the budget. */
function attemptsAgainstBuild(record: LegacyBootstrapRecord | null, build: number | null): number {
  return record && record.manifestBuild === build ? record.attempts : 0;
}

interface FailedAttemptBudget {
  attempts: number;
  exhausted: boolean;
  /** When the escalating cooldown ends; null when the stamp is unreadable (no cooldown is running). */
  cooldownEndsAtMs: number | null;
}

/**
 * The one reading of a `failed` record's retry arithmetic — attempts counted
 * against the current manifest build, exhausted at
 * `LEGACY_BOOTSTRAP_MAX_ATTEMPTS`, and the escalating cooldown window — that
 * both `describeLegacyBootstrapRetry` (the metadata summary) and the repair's
 * own budget gate apply. They used to be two hand-encodings of the same
 * running/staged/failed/exhausted/cooldown decisions.
 */
function failedAttemptBudget(record: LegacyBootstrapRecord, sameBuild: boolean): FailedAttemptBudget {
  const attempts = sameBuild ? record.attempts : 0;
  if (attempts >= LEGACY_BOOTSTRAP_MAX_ATTEMPTS) {
    return { attempts, exhausted: true, cooldownEndsAtMs: null };
  }
  const lastMs = Date.parse(record.lastAttemptAt);
  return {
    attempts,
    exhausted: false,
    cooldownEndsAtMs: Number.isFinite(lastMs) ? lastMs + legacyBootstrapCooldownMs(attempts) : null,
  };
}

type LegacyBootstrapRetryStatus = 'idle' | 'running' | 'staged' | 'cooldown' | 'exhausted';

export interface LegacyBootstrapRetrySummary {
  /** `idle`: nothing recorded, or the record is settled and free to retry now.
   *  `running`: an attempt is currently in flight (this replica or another).
   *  `staged`: converges at the provider's next start (Daytona/E2B); nothing to retry.
   *  `cooldown`: a failed attempt is backing off; see `nextRetryAt`.
   *  `exhausted`: the attempt budget for this manifest build is spent; only a
   *  new build or an operator `--force` moves this forward — `nextRetryAt` is
   *  null on purpose, because nothing here will retry it automatically. */
  status: LegacyBootstrapRetryStatus;
  /** The classification the last attempt (or check) was made against, when known. */
  classification: { klass: RuntimeClass; staleReasons: StaleReason[] } | null;
  attempts: number;
  lastAttemptAt: string | null;
  lastError: string | null;
  /** Null = no attempt is scheduled — `exhausted`, `running`, `staged`, or nothing to retry. */
  nextRetryAt: string | null;
}

/**
 * Answers "why is this box stale, and what happens next" purely from a
 * sandbox row's own metadata — no probe, no provider call. Used by the
 * operator sweep's dry run and by the session-open guarantee to decide
 * whether firing another repair attempt would be redundant.
 */
export function describeLegacyBootstrapRetry(
  metadata: Record<string, unknown> | null | undefined,
  currentManifestBuild: number | null,
  now: number,
): LegacyBootstrapRetrySummary {
  const record = readRecord(metadata);
  const check = readCheck(metadata);
  const fallbackClassification = check ? { klass: check.klass, staleReasons: check.staleReasons } : null;
  if (!record) {
    return { status: 'idle', classification: fallbackClassification, attempts: 0, lastAttemptAt: null, lastError: null, nextRetryAt: null };
  }
  const classification = record.classification ?? fallbackClassification;
  const sameBuild = record.manifestBuild === currentManifestBuild;
  if (record.state === 'running') {
    return { status: 'running', classification, attempts: record.attempts, lastAttemptAt: record.lastAttemptAt, lastError: null, nextRetryAt: null };
  }
  if (record.state === 'staged' && sameBuild) {
    return { status: 'staged', classification, attempts: record.attempts, lastAttemptAt: record.lastAttemptAt, lastError: null, nextRetryAt: null };
  }
  if (record.state === 'failed' && sameBuild) {
    const budget = failedAttemptBudget(record, true);
    if (budget.exhausted) {
      return { status: 'exhausted', classification, attempts: budget.attempts, lastAttemptAt: record.lastAttemptAt, lastError: record.error ?? null, nextRetryAt: null };
    }
    const status: LegacyBootstrapRetryStatus =
      budget.cooldownEndsAtMs !== null && budget.cooldownEndsAtMs > now ? 'cooldown' : 'idle';
    return {
      status,
      classification,
      attempts: budget.attempts,
      lastAttemptAt: record.lastAttemptAt,
      lastError: record.error ?? null,
      nextRetryAt: status === 'cooldown' && budget.cooldownEndsAtMs !== null
        ? new Date(budget.cooldownEndsAtMs).toISOString()
        : null,
    };
  }
  return { status: 'idle', classification, attempts: attemptsAgainstBuild(record, currentManifestBuild), lastAttemptAt: record.lastAttemptAt, lastError: record.error ?? null, nextRetryAt: null };
}

/**
 * Decide, and when warranted do, the bootstrap for one sandbox. Pure over
 * `deps`; every side effect is injected so the policy is unit-testable and the
 * wiring (DB, provider, ingress, audit) lives in one place.
/** One bootstrap pass in flight: what every phase reads, and the refined classification it acts on. */
interface RepairPass {
  readonly deps: LegacyBootstrapDeps;
  readonly input: LegacyBootstrapInput;
  readonly strategy: RelaunchStrategy;
  readonly classification: RuntimeClassification;
}

/**
 * A DEAD DAEMON ON A RUNNING BOX. Silence alone means nothing — a stopped box
 * answers exactly the same way, and there is nothing there to repair. The
 * provider's own state is what tells the two apart, and it is asked only
 * here, on the rare path.
 *
 * Measured on dev 2026-09-27: the row was parked, the daemon's dead-token
 * breaker tripped 69 s later and shut it down with exit 0, and Platinum's
 * pt-init — which launches the chain once and never again — left the VM up
 * with nothing serving on it. The provider reported `running`, our row
 * reported `active`, every ingress port answered 502, and the control plane
 * still accepted a prompt against it. This module's own relaunch fixed it in
 * 11 s by hand; it had refused to try because `unreachable` returned here.
 *
 * Only `unreachable` takes this branch. A daemon that ANSWERS is classified,
 * and a `blocked` (pinned) daemon is never relaunched by this path or any
 * other — it is handled immediately below.
 *
 * Uncertainty stays a skip: a provider that cannot answer is not evidence.
 */
async function resolveSilentDaemon(
  input: LegacyBootstrapInput,
  deps: LegacyBootstrapDeps,
  classification: RuntimeClassification,
  expectedRunningAssets: ExpectedRunningAssets | undefined,
): Promise<{ classification: RuntimeClassification; deadDaemonOnRunningBox: boolean; stop: LegacyBootstrapResult | null }> {
  if (classification.klass !== 'unreachable') {
    return { classification, deadDaemonOnRunningBox: false, stop: null };
  }
  const running = deps.providerRunning ? await deps.providerRunning().catch(() => false) : false;
  if (!running) return { classification, deadDaemonOnRunningBox: false, stop: { outcome: 'unreachable', classification } };
  // TWO SILENT READS, never one. An 8 s ingress timeout, a restarting proxy
  // or a GC pause reads exactly like a corpse, and a relaunch kills PTYs and
  // restages assets under whoever is using the box. This is
  // `decideStoppedObservation`'s asymmetry applied to the probe instead of
  // the provider's state field: uncertainty fails toward the LIVE box, so the
  // daemon gets a second chance to speak. If it takes it, this pass simply
  // continues with what it said.
  await deps.sleep(DEAD_DAEMON_CONFIRM_MS);
  const second = classifyDaemonHealth(await deps.fetchHealth(), expectedRunningAssets);
  if (second.klass !== 'unreachable') {
    return {
      classification: second,
      deadDaemonOnRunningBox: false,
      stop: second.klass === 'not-ok' ? { outcome: 'unreachable', classification: second } : null,
    };
  }
  // Both reads crossed the provider ingress, and an ingress that times out
  // reads exactly like a corpse (prod 2026-09-29: ~18 min of edge timeouts
  // to a healthy daemon). The box's own loopback is the authority, asked
  // before any record, token or script touches the box.
  const loopback = await deps
    .exec(['bash', '-c', `curl -fsS --max-time 3 -o /dev/null ${LOOPBACK_HEALTH_URL}`], LOOPBACK_PROBE_TIMEOUT_MS)
    .catch(() => null);
  if (loopback?.exitCode === 0) {
    deps.log('daemon answers on the box loopback; the ingress was silent, nothing to repair', {
      sandboxId: input.sandboxId,
      externalId: input.externalId,
    });
    return { classification, deadDaemonOnRunningBox: false, stop: { outcome: 'not-legacy', detail: 'daemon alive in the box; the ingress was unreachable', classification } };
  }
  deps.log('daemon gone on a running box; relaunching the runtime chain', {
    sandboxId: input.sandboxId,
    externalId: input.externalId,
    provider: input.provider,
  });
  return { classification, deadDaemonOnRunningBox: true, stop: null };
}

/** Legacy or stale. Budget and cooldown are per manifest build: a new deploy earns a fresh set of attempts, a box that keeps failing on the same build does not. */
function repairBudgetGate(
  record: LegacyBootstrapRecord | null,
  build: number | null,
  input: LegacyBootstrapInput,
  classification: RuntimeClassification,
  deadDaemonOnRunningBox: boolean,
  nowMs: number,
): LegacyBootstrapResult | null {
  const sameBuild = record?.manifestBuild === build;
  const attempts = attemptsAgainstBuild(record, build);
  if (record && sameBuild && record.state === 'failed' && !input.force) {
    const budget = failedAttemptBudget(record, true);
    if (budget.exhausted) {
      return { outcome: 'skipped-exhausted', detail: `${attempts} attempts on build ${build}`, classification };
    }
    // ESCALATING per-box backoff (30m, 60m, 120m, …, capped): a box that has
    // failed repeatedly is retried less often each time, not on a flat 30m
    // cadence forever — the repair-storm guard for a box that CANNOT be
    // repaired but has not yet spent its attempt budget.
    if (budget.cooldownEndsAtMs !== null && nowMs < budget.cooldownEndsAtMs) {
      return { outcome: 'skipped-cooldown', classification };
    }
  }
  if (record && sameBuild && record.state === 'staged' && !deadDaemonOnRunningBox) {
    // Daytona/E2B: staged and waiting for the provider's next start. Nothing
    // to redo until a current daemon proves it or the build moves on. A box
    // with no daemon is the exception: nothing will start it again, so
    // "converges at next start" is a promise that can never be kept.
    return { outcome: 'staged', detail: 'already staged; converges at next start', classification };
  }
  return null;
}

/** Stamp the running attempt and its check before anything touches the box. */
async function stampRunningAttempt(
  pass: RepairPass,
  attempts: number,
  build: number | null,
  nowIso: string,
): Promise<LegacyBootstrapRecord> {
  const { deps, input, classification, strategy } = pass;
  const running: LegacyBootstrapRecord = {
    state: 'running',
    attempts: attempts + 1,
    manifestBuild: build,
    lastAttemptAt: nowIso,
    reason: input.reason,
    from: { opencode: classification.opencode },
    classification: { klass: classification.klass, staleReasons: classification.staleReasons },
  };
  await deps.patchMetadata({
    [LEGACY_BOOTSTRAP_METADATA_KEY]: running,
    [LEGACY_CHECK_METADATA_KEY]: {
      at: nowIso,
      klass: classification.klass,
      staleReasons: classification.staleReasons,
    } satisfies LegacyCheckRecord,
  });
  deps.log('legacy runtime bootstrap starting', {
    sandboxId: input.sandboxId,
    externalId: input.externalId,
    provider: input.provider,
    attempt: running.attempts,
    strategy,
    reason: input.reason,
  });
  return running;
}

/** The one record/audit/log tail every attempt ending shares. */
async function finishRepair(
  pass: RepairPass,
  running: LegacyBootstrapRecord,
  state: LegacyBootstrapState,
  extra: Partial<LegacyBootstrapRecord>,
  outcome: LegacyBootstrapOutcome,
  detail?: string,
): Promise<LegacyBootstrapResult> {
  const finished: LegacyBootstrapRecord = {
    ...running,
    ...extra,
    state,
    finishedAt: new Date(pass.deps.now()).toISOString(),
  };
  await pass.deps.patchMetadata({ [LEGACY_BOOTSTRAP_METADATA_KEY]: finished });
  await pass.deps.audit({
    outcome: state === 'failed' ? 'failure' : 'success',
    phase: state,
    summary: {
      attempt: finished.attempts,
      strategy: pass.strategy,
      reason: pass.input.reason,
      from: finished.from ?? null,
      to: finished.to ?? null,
      detail: detail ?? null,
    },
    error: finished.error,
  });
  pass.deps.log(`legacy runtime bootstrap ${state}`, {
    sandboxId: pass.input.sandboxId,
    externalId: pass.input.externalId,
    outcome,
    detail,
    error: finished.error,
  });
  return { outcome, detail, classification: pass.classification };
}

/** Mint the repair credential, exec the script, and act on its report (deferred, staged, or relaunched). */
async function runRepairPass(
  pass: RepairPass,
  running: LegacyBootstrapRecord,
  expectedRunningAssets: ExpectedRunningAssets | undefined,
): Promise<LegacyBootstrapResult> {
  const { deps, input, strategy } = pass;
  // Never let the box's own credential decide whether its repair can run.
  const repair = await deps.mintRepairToken?.().catch((error) => {
    deps.log('repair credential mint failed; falling back to the box token', {
      sandboxId: input.sandboxId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  });
  let repairReleased = false;
  const releaseRepair = async () => {
    if (!repair || repairReleased) return;
    repairReleased = true;
    // A repair credential that outlives its repair is a credential nobody
    // revokes. Releasing never fails the pass.
    await repair.release().catch((error) =>
      deps.log('repair credential release failed', {
        sandboxId: input.sandboxId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  };
  // Token rotation only where the box's own environment is what the daemon
  // boots from (Platinum: /etc/environment via pt-init). Daytona and E2B hand
  // the daemon its env from the provider on every start, so a rotated secret
  // in the box would diverge from what the daemon actually runs with.
  const kortixToken = strategy === 'pt-app' ? ((await deps.rotateKortixToken?.()) ?? undefined) : undefined;
  const commitToken = async (rotatedOnBox: boolean | null) => {
    if (!kortixToken) return;
    await deps.commitKortixToken?.(kortixToken, rotatedOnBox);
  };
  let execResult: SandboxExecResult;
  try {
    execResult = await deps.exec(
      bootstrapExecCommand(
        renderLegacyBootstrapScript({
          relaunch: strategy,
          entrypointSource: deps.entrypointSource?.() ?? undefined,
          pnpmVersion: deps.pnpmVersion?.() ?? undefined,
          kortixToken,
          repairToken: repair?.secret,
        }),
      ),
      LEGACY_BOOTSTRAP_EXEC_TIMEOUT_MS,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await commitToken(null);
    await releaseRepair();
    return finishRepair(pass, running, 'failed', { error: `exec: ${message}`.slice(0, 500) }, 'failed', 'provider exec failed');
  }
  await releaseRepair();
  const report = parseScriptReport(execResult);
  await commitToken(report ? report.token_rotated === true : null);
  if (!report) {
    const tail = (execResult.stderr || execResult.stdout).trim().slice(-400);
    return finishRepair(
      pass,
      running,
      'failed',
      { error: `no report (exit ${execResult.exitCode}): ${tail}`.slice(0, 500) },
      'failed',
      'script produced no report',
    );
  }
  if (!report.ok) {
    return finishRepair(
      pass,
      running,
      'failed',
      { error: `${report.stage}: ${report.error ?? 'unknown'}`.slice(0, 500) },
      'failed',
      `script failed at ${report.stage}`,
    );
  }
  if (report.stage === 'deferred_busy') {
    // A turn started between the idle gate above and the relaunch. Nothing
    // ran, so this was not an attempt: put the prior record back and the next
    // idle pass retries with no cooldown and no budget spent.
    await deps.patchMetadata({ [LEGACY_BOOTSTRAP_METADATA_KEY]: input.metadata?.[LEGACY_BOOTSTRAP_METADATA_KEY] ?? null });
    deps.log('legacy runtime bootstrap deferred: a turn started during the repair', { sandboxId: input.sandboxId });
    return { outcome: 'skipped-busy', detail: 'a turn started during the repair; relaunch deferred', classification: pass.classification };
  }
  const to = { agentSha256: report.agent_sha256, entrypointSha256: report.entrypoint_sha256 };
  if (report.stage === 'staged') {
    return finishRepair(pass, running, 'staged', { to }, 'staged', 'staged; converges at the provider\'s next start');
  }
  return awaitConvergedRuntime(pass, running, to, expectedRunningAssets);
}

/**
 * Relaunched. The new daemon must now report a runtime block AND a serving
 * OpenCode — the convergence pass installs the pinned OpenCode at boot, and
 * "done" means a prompt would work, not that a process is listening.
 */
async function awaitConvergedRuntime(
  pass: RepairPass,
  running: LegacyBootstrapRecord,
  to: { agentSha256?: string; entrypointSha256?: string },
  expectedRunningAssets: ExpectedRunningAssets | undefined,
): Promise<LegacyBootstrapResult> {
  const { deps, input } = pass;
  const deadline = deps.now() + LEGACY_BOOTSTRAP_CONVERGE_BUDGET_MS;
  let last: RuntimeClassification | null = null;
  while (deps.now() < deadline) {
    const after = classifyDaemonHealth(await deps.fetchHealth(), expectedRunningAssets);
    last = after;
    // The daemon reports its own convergence pass. `failed` is final for this
    // boot — waiting would not change it — and the reason lives in
    // /kortix/diag. Checked INDEPENDENTLY of overall `klass`: opencode can be
    // the one failed component on an otherwise-`stale` box (another
    // component still catching up, or `running` not yet re-reported this
    // pass) and the failure is just as final either way.
    if (after.opencodeComponent === 'failed') {
      return finishRepair(
        pass,
        running,
        'failed',
        { to: { ...to, runtimeBuild: after.runtimeBuild }, error: 'daemon converged but its OpenCode install failed (see /kortix/diag runtime.reasons.opencode)' },
        'failed',
        'opencode convergence failed',
      );
    }
    if (
      after.klass === 'current' &&
      after.opencode === 'ok' &&
      after.runtimeBuild !== null &&
      (after.opencodeComponent === 'current' || after.opencodeComponent === 'updated')
    ) {
      await deps.patchMetadata({
        [LEGACY_CHECK_METADATA_KEY]: { at: new Date(deps.now()).toISOString(), klass: 'current', staleReasons: [] } satisfies LegacyCheckRecord,
      });
      const converged = await finishRepair(pass, running, 'converged', { to: { ...to, runtimeBuild: after.runtimeBuild } }, 'converged');
      // `updated` = this daemon installed OpenCode during its boot pass. Daemon
      // builds before the restart re-detection fix keep spawning the binary
      // they memoised at boot, so one more relaunch is what makes the installed
      // OpenCode the running one. Idempotent: agent, entrypoint and token are
      // already at the manifest, only the chain restarts.
      if (after.opencodeComponent === 'updated' && !input.postInstallPass) {
        deps.log('relaunching once more so the installed OpenCode is the running one', {
          sandboxId: input.sandboxId,
        });
        const finishedRecord: LegacyBootstrapRecord = {
          ...running,
          state: 'converged',
          to: { ...to, runtimeBuild: after.runtimeBuild },
          finishedAt: new Date(deps.now()).toISOString(),
        };
        return bootstrapLegacyRuntime(
          {
            ...input,
            force: true,
            postInstallPass: true,
            reason: `${input.reason}:post-install-relaunch`,
            metadata: { ...(input.metadata ?? {}), [LEGACY_BOOTSTRAP_METADATA_KEY]: finishedRecord },
          },
          deps,
        );
      }
      return converged;
    }
    await deps.sleep(LEGACY_BOOTSTRAP_POLL_MS);
  }
  return finishRepair(
    pass,
    running,
    'failed',
    {
      to,
      // Name EVERY condition the acceptance gate above tests, not two of them.
      // The old message printed `klass/opencode` only, so a box that timed out
      // on `runtimeBuild === null` reported `last: current/ok` — a reading that
      // says "converged" next to the word "not converged" and sent the next
      // reader looking in the wrong place (a dev session, 2026-09-28).
      error: `relaunched but not converged within budget (last: klass=${
        last?.klass ?? 'unreachable'
      } opencode=${last?.opencode ?? '-'} opencodeComponent=${
        last?.opencodeComponent ?? '-'
      } runtimeBuild=${last?.runtimeBuild == null ? 'null' : 'present'})`,
    },
    'failed',
    'converge timeout',
  );
}

/**
 * Decide, and when warranted do, the bootstrap for one sandbox. Pure over
 * `deps`; every side effect is injected so the policy is unit-testable and the
 * wiring (DB, provider, ingress, audit) lives in one place.
 */
export async function bootstrapLegacyRuntime(
  input: LegacyBootstrapInput,
  deps: LegacyBootstrapDeps,
): Promise<LegacyBootstrapResult> {
  const nowMs = deps.now();
  const nowIso = new Date(nowMs).toISOString();
  const strategy = relaunchStrategyFor(input.provider);
  if (!strategy) return { outcome: 'skipped-unsupported', detail: `provider ${input.provider}` };

  // Cheap gates first — none of these touch the box.
  const record = readRecord(input.metadata);
  const check = readCheck(input.metadata);
  if (record?.state === 'running') {
    const startedMs = Date.parse(record.lastAttemptAt);
    if (Number.isFinite(startedMs) && nowMs - startedMs < LEGACY_BOOTSTRAP_STALE_RUNNING_MS) {
      return { outcome: 'skipped-in-progress' };
    }
  }
  if (!input.force && check && check.klass === 'current') {
    const atMs = Date.parse(check.at);
    if (Number.isFinite(atMs) && nowMs - atMs < LEGACY_CHECK_TTL_MS) {
      return { outcome: 'skipped-recent-check' };
    }
  }

  const health = await deps.fetchHealth();
  const expectedRunningAssets = (await deps.expectedRunningAssets?.()) ?? undefined;
  // #7859 owns the classification (sha-to-sha against this deploy's manifest);
  // this module owns what to DO with each class.
  let classification = classifyDaemonHealth(health, expectedRunningAssets);
  if (classification.klass === 'not-ok') return { outcome: 'unreachable', classification };

  const silence = await resolveSilentDaemon(input, deps, classification, expectedRunningAssets);
  if (silence.stop) return silence.stop;
  classification = silence.classification;

  if (classification.klass === 'blocked') {
    // The daemon's own supervisor already tried, rolled back, and latched
    // updates off. Repairing again would relaunch into the same rollback —
    // never loop on it. Record the check so it stays visible, and stop.
    await deps.patchMetadata({
      [LEGACY_CHECK_METADATA_KEY]: {
        at: nowIso,
        klass: 'blocked',
        staleReasons: [],
      } satisfies LegacyCheckRecord,
    });
    deps.log('daemon is pinned after a rollback — blocked, not repaired', {
      sandboxId: input.sandboxId,
      detail: classification.detail,
    });
    return { outcome: 'skipped-blocked', detail: classification.detail.join('; '), classification };
  }
  if (classification.klass === 'current' && classification.runtimeBuild === null) {
    // A current daemon that has not finished (or has failed) its first
    // convergence pass: not legacy, nothing for this module to do yet.
    return { outcome: 'not-legacy', detail: 'daemon current, convergence pending', classification };
  }
  if (classification.klass === 'current' && input.force) {
    // Operator-forced re-run on a current daemon: its OpenCode install failed
    // (a 2026-07 image's pnpm 8, for one), or an operator wants the chain
    // relaunched so the daemon re-detects a freshly installed binary. The
    // script is idempotent — agent and entrypoint are skipped when already at
    // the manifest — so a re-run is "fix the floor, relaunch, converge again".
    deps.log('forced re-run on a current daemon', {
      sandboxId: input.sandboxId,
      opencodeComponent: classification.opencodeComponent,
    });
  } else if (classification.klass === 'current') {
    const patch: Record<string, unknown> = {
      [LEGACY_CHECK_METADATA_KEY]: { at: nowIso, klass: 'current', staleReasons: [] } satisfies LegacyCheckRecord,
    };
    // A bootstrap that was mid-flight is proven done by a current daemon.
    if (record && record.state !== 'converged') {
      patch[LEGACY_BOOTSTRAP_METADATA_KEY] = {
        ...record,
        state: 'converged',
        finishedAt: nowIso,
        to: { ...(record.to ?? {}), runtimeBuild: classification.runtimeBuild },
      } satisfies LegacyBootstrapRecord;
    }
    await deps.patchMetadata(patch);
    return { outcome: 'not-legacy', classification };
  }

  const build = await deps.manifestBuild();
  const budget = repairBudgetGate(record, build, input, classification, silence.deadDaemonOnRunningBox, nowMs);
  if (budget) return budget;

  // Never under a running turn. OpenCode's own busy state is the authority —
  // the ledger can hold a zombie turn on exactly the boxes this exists for.
  // OpenCode is proxied BY the daemon, so a dead daemon is also why OpenCode
  // says nothing. That is one fact, not two, and it cannot gate its own repair.
  const status = silence.deadDaemonOnRunningBox ? {} : await deps.fetchOpencodeStatus();
  if (!opencodeIdle(status)) {
    return { outcome: 'skipped-busy', detail: status ? 'opencode busy' : 'opencode unreachable', classification };
  }

  const pass: RepairPass = { deps, input, strategy, classification };
  const running = await stampRunningAttempt(pass, attemptsAgainstBuild(record, build), build, nowIso);
  return runRepairPass(pass, running, expectedRunningAssets);
}
