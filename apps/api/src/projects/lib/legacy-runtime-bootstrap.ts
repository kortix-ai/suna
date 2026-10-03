/**
 * Legacy runtime bootstrap — converge a sandbox whose daemon predates the
 * self-updating runtime (#6673/#6676, 2026-08-20).
 *
 * THE PROBLEM. Runtime convergence is pull-only: the daemon reads
 * `/v1/runtime-assets/manifest` at boot and stages its own replacement for the
 * supervising entrypoint to install. A daemon built before that code existed
 * never pulls, restart/resume keep the same VM, and warm-fork keeps the same
 * disk — so a box provisioned before 2026-08-20 keeps its 2026-07 daemon,
 * OpenCode and CLI forever. Live consequence (prod, 2026-09-01): every session
 * with history from before OpenCode's 48-bit message-id rollover
 * (2026-08-14 11:19 UTC) on OpenCode < 1.18.15 stores each prompt, exits its
 * loop at step 0 and never calls a model; the fix shipped upstream in 1.18.15,
 * and the pinned 1.18.23 never reached those boxes.
 *
 * THE MECHANISM. The control plane cannot ask the old daemon to replace
 * itself, so it goes through the PROVIDER's exec channel (Platinum `/exec`,
 * Daytona toolbox, E2B commands — `SandboxProvider.exec`), which is
 * independent of the in-box daemon, and runs one idempotent script that:
 *   1. reads the box's own API URL + sandbox token from /etc/environment (no
 *      secret crosses the control plane; the box converges on the API it
 *      already talks to, exactly like a current daemon);
 *   2. fetches THAT API's runtime-assets manifest, downloads the agent binary
 *      and the supervising entrypoint, and verifies both sha256s;
 *   3. stages the agent as `/opt/kortix/agent.next` (+ `.sha256`) — the exact
 *      slot the supervisor promotes on launch, with its crash-loop rollback to
 *      the baked binary intact — and installs the entrypoint atomically,
 *      keeping `kortix-entrypoint.legacy`;
 *   4. relaunches the runtime. On Platinum pt-init runs the image entrypoint
 *      once and never respawns it, so the script stops the legacy chain and
 *      starts `/sbin/pt-app` detached. Daytona and E2B re-run the entrypoint
 *      on every start, so staging alone converges them at the next wake.
 * The new daemon then converges OpenCode, CLI and skills by itself — this
 * module installs a supervisor and a current daemon, nothing else.
 *
 * SAFETY. Only an idle runtime is touched (OpenCode `/session/status` must be
 * empty). Every attempt is stamped in sandbox metadata with a cooldown and a
 * budget, so a box that cannot be converged is retried a bounded number of
 * times per API build and then left for a human — visible in the metadata
 * and in the audit ledger, never silent. The script restores the legacy
 * entrypoint and relaunches the old chain if the new daemon does not answer.
 */
import { healthHarnessId, healthRuntimeState } from '@kortix/api-contract/runtime-relay';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ProviderName, SandboxExecResult } from '../../platform/providers';
import { CONFIG_RELEASE_CAPABILITY } from './session-config-release';

/**
 * The in-box script ships as a sidecar file, not a template literal: bash is
 * full of `${…}` and backticks, and a JS string is the wrong place to review
 * shell. Read once per process; the API image copies src/ wholesale.
 */
let scriptTemplate: string | null = null;
function loadScriptTemplate(): string {
  if (scriptTemplate === null) {
    scriptTemplate = readFileSync(
      fileURLToPath(new URL('./legacy-runtime-bootstrap.sh', import.meta.url)),
      'utf8',
    );
  }
  return scriptTemplate;
}

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
export const LEGACY_BOOTSTRAP_EXEC_TIMEOUT_MS = 5 * 60 * 1000;
/** After the relaunch, how long the new daemon may take to report a converged, serving OpenCode. */
export const LEGACY_BOOTSTRAP_CONVERGE_BUDGET_MS = 8 * 60 * 1000;
export const LEGACY_BOOTSTRAP_POLL_MS = 5_000;

/** OpenCode home on the box: 'auto' = detect from the running OpenCode / on-disk data (image generations differ). */
export const LEGACY_OPENCODE_HOME = 'auto';

/**
 * STALE / BLOCKED — a daemon that reports a `runtime` block (so it is not
 * `legacy`) but is not provably running current bytes either. Before this,
 * `classifyDaemonHealth` called ANY box with a `runtime` object `current` and
 * stopped looking.
 *
 * THE GROUND TRUTH, per the daemon's own contract
 * (`apps/kortix-sandbox-agent-server/src/services/runtime-assets/runtime-assets.ts`,
 * `RuntimeConvergenceReport.running`): `build` and `components` describe a
 * PASS — an attempt — not what is running now; a daemon restart reports
 * `build: null` until its first pass completes, and `build` is written even
 * when a pass half-fails. The only field that answers "which bytes are on
 * this box right now" is `runtime.running` (`RunningRuntimeAssets`), and it
 * must be compared SHA-TO-SHA against the manifest, never version string to
 * version string — the same rule `runningAssetsVerdict`
 * (`runtime-assets/manifest.ts`) already applies on the turn-start lane. So:
 * `runtime.build` is informational only below, never an input to "is this
 * box current".
 *
 * A daemon that does not report `running` AT ALL predates that field — proof
 * by itself that the running bytes are old, independent of anything else it
 * says. A daemon that reports `agentSwapPending: true` has a verified update
 * staged and NOT running: on Platinum the supervisor only promotes it on a
 * relaunch the box cannot give itself (`pt-init` runs the image entrypoint
 * once, never again — see `relaunchStrategyFor`), so a RUNNING box observed
 * with the flag set has nothing that will ever land it without an external
 * relaunch — there is no "pending success" to wait out. `pinned: true` is a
 * different animal: the supervisor itself rolled an update back and latched
 * updates off. That box needs a human, not another attempt — see `blocked`
 * below, and never loop repair on it.
 */
export type StaleReason =
  /** `runtime.running` is not reported at all — the daemon predates running-asset truth. */
  | 'running_assets_unreported'
  /** `runtime.running` IS reported, and at least one sha differs from the manifest. */
  | 'running_assets_stale'
  | 'missing_capability'
  /** `agentSwapPending: true` — a verified update is staged and not running. */
  | 'agent_swap_pending'
  /** At least one `runtime.components[*]` reports `failed`. */
  | 'component_failed';

/**
 * Capabilities every CURRENT daemon must advertise in `capabilities`
 * (`GET /kortix/health`). Hardcoded here — never inferred from the box, and
 * never read as "whatever this build happens to support" — and extended only
 * when a capability a session must not run without ships. Today: config
 * releases (`session-config-release.ts`).
 */
export const REQUIRED_RUNTIME_CAPABILITIES: readonly string[] = [CONFIG_RELEASE_CAPABILITY];

export type RuntimeClass = 'legacy' | 'current' | 'stale' | 'blocked' | 'not-ok' | 'unreachable';

/** The three assets `runtime.running` reports that this module can compare sha-to-sha. Pass the desired values from the API's own manifest — never read off the box. */
export interface ExpectedRunningAssets {
  cli_sha256: string | null;
  managed_skills_hash: string | null;
  agent_sha256: string | null;
}

export interface RuntimeClassification {
  klass: RuntimeClass;
  /** `runtime.build` the box reports — INFORMATIONAL ONLY. Never an input to `klass`; see the module doc above for why. */
  runtimeBuild: number | null;
  /** `opencode` field of health: 'ok' | 'starting' | ... */
  opencode: string | null;
  /** `runtime.components.opencode` outcome when reported. */
  opencodeComponent: string | null;
  /** Every reason `klass === 'stale'`. Always `[]` for every other klass. */
  staleReasons: StaleReason[];
  /** Human-readable specifics for `stale` AND `blocked` — which component failed, how long a swap has been pending, why this box is blocked. Empty for `current`/`legacy`/`not-ok`/`unreachable`. */
  detail: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function shaField(running: Record<string, unknown>, key: string): string | null {
  const v = running[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * How long after boot a digest mismatch in `runtime.running` is not, by itself,
 * evidence that the box runs stale bytes.
 *
 * Until a daemon's first convergence pass writes the state file, `running` is
 * the record the IMAGE BUILD baked (`bakeRuntimeAssetsState` deliberately omits
 * `build`, so `running.build` is null), and the in-process pass has not run
 * either (`runtime.build` is null). The Platinum agent-swap fast path replaces
 * the agent binary after that bake and keeps the predecessor's record, and its
 * CLI is the predecessor's until the boot pass replaces it in place. Measured
 * on Dev 2026-10-02 (both regions, template kortix-default-6bacca9b52cc): the
 * record said agent efd19aa3… / cli 9ba28976… while the box ran agent
 * d2019d30… — exactly the manifest's — and the boot pass finished ~20 s after
 * start. Session open read the record, called the box stale, and relaunched a
 * correct daemon: +17 s on every session from a swapped template.
 *
 * Bounded so a daemon whose first pass never completes cannot hide a genuinely
 * stale agent forever: past the grace, the record counts as evidence again.
 */
export const FIRST_CONVERGENCE_GRACE_S = 300;

function awaitingFirstConvergence(
  health: Record<string, unknown>,
  runtime: Record<string, unknown>,
  running: Record<string, unknown>,
): boolean {
  if (runtime.build !== null && runtime.build !== undefined) return false;
  if (running.build !== null && running.build !== undefined) return false;
  const uptime = typeof health.uptime_s === 'number' ? health.uptime_s : null;
  return uptime !== null && uptime >= 0 && uptime < FIRST_CONVERGENCE_GRACE_S;
}

/**
 * A daemon that answers /kortix/health without a `runtime` block was built
 * before convergence existed. Health is unauthenticated and always 200 on a
 * daemon, so a null body means the box could not be reached, not "old".
 *
 * A `runtime` block alone no longer means CURRENT — see the module doc above.
 * `expectedRunningAssets` is optional: when the caller has the manifest in
 * hand (the wiring layer does), pass it for the sha-to-sha compare
 * (`running_assets_stale`); when omitted, that ONE check is skipped and every
 * other rule still applies — `running_assets_unreported` alone already
 * catches a daemon that cannot even report `running`.
 */
export function classifyDaemonHealth(
  body: unknown,
  expectedRunningAssets?: ExpectedRunningAssets,
): RuntimeClassification {
  const empty = { runtimeBuild: null, opencode: null, opencodeComponent: null, staleReasons: [], detail: [] };
  if (!body || typeof body !== 'object') {
    return { klass: 'unreachable', ...empty };
  }
  const h = body as Record<string, unknown>;
  const opencode = healthRuntimeState(h);
  if (h.daemon !== 'ok') {
    return { klass: 'not-ok', ...empty, opencode };
  }
  const runtime = h.runtime;
  if (!runtime || typeof runtime !== 'object') {
    return { klass: 'legacy', ...empty, opencode };
  }
  const r = runtime as Record<string, unknown>;
  const components = (r.components ?? {}) as Record<string, unknown>;
  const runtimeBuild = typeof r.build === 'number' ? r.build : null;
  const opencodeComponent =
    typeof components.opencode === 'string' ? (components.opencode as string) : null;

  // BLOCKED wins over everything else and is never repaired in a loop: the
  // supervisor itself already tried, rolled back, and latched updates off.
  if (r.pinned === true) {
    return {
      klass: 'blocked',
      runtimeBuild,
      opencode,
      opencodeComponent,
      staleReasons: [],
      detail: ['daemon has latched runtime updates off after a supervisor rollback (pinned=true) — needs a human, not another attempt'],
    };
  }

  const staleReasons: StaleReason[] = [];
  const detail: string[] = [];

  const runningRaw = r.running;
  const runningPresent = isRecord(runningRaw);
  if (!runningPresent) {
    staleReasons.push('running_assets_unreported');
    detail.push('runtime.running is not reported — the daemon predates running-asset truth and cannot prove which bytes it runs');
  } else if (expectedRunningAssets) {
    const running = runningRaw;
    const mismatches: string[] = [];
    (
      [
        ['cli_sha256', expectedRunningAssets.cli_sha256],
        ['managed_skills_hash', expectedRunningAssets.managed_skills_hash],
        ['agent_sha256', expectedRunningAssets.agent_sha256],
      ] as const
    ).forEach(([key, wanted]) => {
      if (!wanted) return; // this deploy states nothing to converge this field on
      const have = shaField(running, key);
      if (!have) return; // the box states nothing comparable for this field
      if (have !== wanted) mismatches.push(key);
    });
    if (mismatches.length > 0) {
      if (awaitingFirstConvergence(h, r, running)) {
        // Not evidence yet — see FIRST_CONVERGENCE_GRACE_S. The daemon's own
        // boot pass re-hashes these files and converges the CLI and skills in
        // place; if the agent really is behind, that pass stages it and the next
        // read reports `agentSwapPending`, which still repairs.
        detail.push(
          `runtime.running differs from the manifest (${mismatches.join(', ')}) but is still the image bake record; awaiting the first convergence pass`,
        );
      } else {
        staleReasons.push('running_assets_stale');
        detail.push(`runtime.running does not match the manifest: ${mismatches.join(', ')}`);
      }
    }
  }

  const capabilities = Array.isArray(h.capabilities)
    ? h.capabilities.filter((c): c is string => typeof c === 'string')
    : [];
  // pi daemons advertise `config.release.v1` since pi applies config releases
  // (harness/pi/config-release.ts). It is still not REQUIRED of a pi box: one
  // that runs an older daemon gets it through its runtime-assets update, and
  // requiring it relaunched every idle pi box on session open (W0).
  const required = healthHarnessId(h) === 'pi' ? [] : REQUIRED_RUNTIME_CAPABILITIES;
  const missingCapabilities = required.filter((cap) => !capabilities.includes(cap));
  if (missingCapabilities.length > 0) {
    staleReasons.push('missing_capability');
    detail.push(`missing required capabilit${missingCapabilities.length === 1 ? 'y' : 'ies'}: ${missingCapabilities.join(', ')}`);
  }

  if (r.agentSwapPending === true) {
    staleReasons.push('agent_swap_pending');
    const uptimeS = typeof h.uptime_s === 'number' ? h.uptime_s : null;
    detail.push(
      `agentSwapPending is true — a verified agent update is staged and not running${uptimeS !== null ? ` (box uptime ${Math.round(uptimeS / 3600)}h)` : ''}`,
    );
  }

  const failedComponents = Object.entries(components)
    .filter(([, state]) => state === 'failed')
    .map(([name]) => name);
  if (failedComponents.length > 0) {
    staleReasons.push('component_failed');
    detail.push(`component${failedComponents.length === 1 ? '' : 's'} failed: ${failedComponents.join(', ')}`);
  }

  return {
    klass: staleReasons.length > 0 ? 'stale' : 'current',
    runtimeBuild,
    opencode,
    opencodeComponent,
    staleReasons,
    detail,
  };
}

/** Gap between the two health reads that must BOTH be silent before a relaunch. */
export const DEAD_DAEMON_CONFIRM_MS = 5_000;
/** The daemon as the box itself sees it — no provider ingress in the path. */
const LOOPBACK_HEALTH_URL = 'http://127.0.0.1:8000/kortix/health';
const LOOPBACK_PROBE_TIMEOUT_MS = 15_000;

export type RelaunchStrategy = 'pt-app' | 'next-start';

/**
 * How a provider re-runs the image entrypoint. Platinum's pt-init launches it
 * once and never again (the VM survives its exit), so the script must relaunch
 * in place. Daytona and E2B run the entrypoint on every sandbox start.
 */
export function relaunchStrategyFor(provider: ProviderName | string): RelaunchStrategy | null {
  switch (provider) {
    case 'platinum':
      return 'pt-app';
    case 'daytona':
    case 'e2b':
      return 'next-start';
    default:
      return null;
  }
}

/** Metadata stamp: when a session open asked for a dead-daemon relaunch. */
export const DEAD_DAEMON_REPAIR_REQUESTED_KEY = 'deadDaemonRepairRequestedAt';
/** One open-time relaunch: download + relaunch + the script's own health wait, then the open parks. */
export const DEAD_DAEMON_REPAIR_BUDGET_MS = 4 * 60_000;

export type DeadDaemonOpenAction = 'request' | 'wait' | 'park';

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

export interface RenderScriptOptions {
  relaunch: RelaunchStrategy;
  opencodeHome?: string;
  /** Seconds the script waits for the relaunched daemon before it restores the legacy chain. */
  healthWaitS?: number;
  /**
   * The entrypoint text, for a box whose API does not serve the `entrypoint`
   * asset yet. The box's own manifest wins whenever it has one.
   */
  entrypointSource?: string;
  /** Fleet pnpm version (packages/shared runtime-versions.json); the script downgrades for an older Node. */
  pnpmVersion?: string;
  /** A freshly minted session PAT to install as the box's KORTIX_TOKEN; empty = keep. */
  kortixToken?: string;
  /**
   * The credential THIS repair authenticates with — minted by the control
   * plane for this run and revoked when it returns. Empty falls the script
   * back to the box's own token, which a wrong row can have already killed.
   */
  repairToken?: string;
}

/**
 * The in-box script. Bash, root, no jq assumed (python3 when present, sed
 * otherwise), no shell evaluation of anything read from the environment.
 * Prints exactly one JSON line on stdout as its last line; everything else
 * goes to stderr and /var/log/kortix-legacy-bootstrap.log.
 */
export function renderLegacyBootstrapScript(opts: RenderScriptOptions): string {
  const opencodeHome = opts.opencodeHome ?? LEGACY_OPENCODE_HOME;
  const healthWaitS = Math.max(30, Math.floor(opts.healthWaitS ?? 150));
  if (opencodeHome !== 'auto' && !/^\/[A-Za-z0-9_./-]+$/.test(opencodeHome)) throw new Error('unsafe opencodeHome');
  const template = loadScriptTemplate();
  const embedded = opts.entrypointSource ? Buffer.from(opts.entrypointSource, 'utf8').toString('base64') : '';
  const pnpmVersion = opts.pnpmVersion ?? '';
  if (!/^[0-9A-Za-z.-]*$/.test(pnpmVersion)) throw new Error('unsafe pnpmVersion');
  const kortixToken = opts.kortixToken ?? '';
  if (!/^(kortix_pat_[A-Za-z0-9_-]+)?$/.test(kortixToken)) throw new Error('unsafe kortixToken');
  const repairToken = opts.repairToken ?? '';
  if (!/^(kortix_pat_[A-Za-z0-9_-]+)?$/.test(repairToken)) throw new Error('unsafe repairToken');
  for (const placeholder of ['__OPENCODE_HOME__', '__RELAUNCH__', '__HEALTH_WAIT_S__', '__ENTRYPOINT_B64__', '__PNPM_VERSION__', '__KORTIX_TOKEN__', '__KORTIX_REPAIR_TOKEN__']) {
    if (!template.includes(placeholder)) throw new Error(`bootstrap script template lacks ${placeholder}`);
  }
  return template
    .replace('__OPENCODE_HOME__', opencodeHome)
    .replace('__RELAUNCH__', opts.relaunch)
    .replace('__HEALTH_WAIT_S__', String(healthWaitS))
    .replace('__ENTRYPOINT_B64__', embedded)
    .replace('__PNPM_VERSION__', pnpmVersion)
    .replace('__KORTIX_TOKEN__', kortixToken)
    .replace('__KORTIX_REPAIR_TOKEN__', repairToken);
}

/** The provider `exec` argv: the script travels base64 so no quoting layer can touch it. */
export function bootstrapExecCommand(script: string): string[] {
  const b64 = Buffer.from(script, 'utf8').toString('base64');
  return [
    'bash',
    '-c',
    // The script carries the repair PAT and any rotated session token in
    // plaintext, so it is removed whatever the exit status — leaving it behind
    // persists both secrets at a predictable path inside the box.
    `printf '%s' '${b64}' | base64 -d > /tmp/kx-legacy-bootstrap.sh && bash /tmp/kx-legacy-bootstrap.sh; rc=$?; rm -f /tmp/kx-legacy-bootstrap.sh; exit $rc`,
  ];
}

export interface ScriptReport {
  ok: boolean;
  stage: string;
  error?: string;
  agent_sha256?: string;
  entrypoint_sha256?: string;
  previous_opencode?: string;
  token_rotated?: boolean;
}

/** The script's last stdout line is its report. Anything else is a transport failure. */
export function parseScriptReport(result: SandboxExecResult): ScriptReport | null {
  const lines = result.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (typeof parsed.ok === 'boolean' && typeof parsed.stage === 'string') {
        return parsed as unknown as ScriptReport;
      }
    } catch {
      /* not the report line */
    }
  }
  return null;
}

export type LegacyBootstrapState = 'running' | 'converged' | 'staged' | 'failed';

export interface LegacyBootstrapRecord {
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

export interface LegacyCheckRecord {
  at: string;
  klass: RuntimeClass;
  /** `[]` for every klass but `stale`. */
  staleReasons: StaleReason[];
}

export type LegacyBootstrapOutcome =
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

export interface LegacyBootstrapInput {
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

export type LegacyBootstrapRetryStatus = 'idle' | 'running' | 'staged' | 'cooldown' | 'exhausted';

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
  const attempts = sameBuild ? record.attempts : 0;
  if (record.state === 'running') {
    return { status: 'running', classification, attempts: record.attempts, lastAttemptAt: record.lastAttemptAt, lastError: null, nextRetryAt: null };
  }
  if (record.state === 'staged' && sameBuild) {
    return { status: 'staged', classification, attempts: record.attempts, lastAttemptAt: record.lastAttemptAt, lastError: null, nextRetryAt: null };
  }
  if (record.state === 'failed' && sameBuild) {
    if (attempts >= LEGACY_BOOTSTRAP_MAX_ATTEMPTS) {
      return { status: 'exhausted', classification, attempts, lastAttemptAt: record.lastAttemptAt, lastError: record.error ?? null, nextRetryAt: null };
    }
    const lastMs = Date.parse(record.lastAttemptAt);
    const nextRetryAt = Number.isFinite(lastMs)
      ? new Date(lastMs + legacyBootstrapCooldownMs(attempts)).toISOString()
      : null;
    const status: LegacyBootstrapRetryStatus =
      nextRetryAt !== null && Date.parse(nextRetryAt) > now ? 'cooldown' : 'idle';
    return { status, classification, attempts, lastAttemptAt: record.lastAttemptAt, lastError: record.error ?? null, nextRetryAt: status === 'cooldown' ? nextRetryAt : null };
  }
  return { status: 'idle', classification, attempts, lastAttemptAt: record.lastAttemptAt, lastError: record.error ?? null, nextRetryAt: null };
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

  const record = readRecord(input.metadata);
  const check = readCheck(input.metadata);

  // Cheap gates first — none of these touch the box.
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
  // #7859 owns the classification (sha-to-sha against this deploy's manifest);
  // this module owns what to DO with each class.
  const expectedRunningAssets = await deps.expectedRunningAssets?.();
  let classification = classifyDaemonHealth(health, expectedRunningAssets ?? undefined);
  if (classification.klass === 'not-ok') return { outcome: 'unreachable', classification };
  // A DEAD DAEMON ON A RUNNING BOX. Silence alone means nothing — a stopped box
  // answers exactly the same way, and there is nothing there to repair. The
  // provider's own state is what tells the two apart, and it is asked only
  // here, on the rare path.
  //
  // Measured on dev 2026-09-27: the row was parked, the daemon's dead-token
  // breaker tripped 69 s later and shut it down with exit 0, and Platinum's
  // pt-init — which launches the chain once and never again — left the VM up
  // with nothing serving on it. The provider reported `running`, our row
  // reported `active`, every ingress port answered 502, and the control plane
  // still accepted a prompt against it. This module's own relaunch fixed it in
  // 11 s by hand; it had refused to try because `unreachable` returned here.
  //
  // Only `unreachable` takes this branch. A daemon that ANSWERS is classified,
  // and a `blocked` (pinned) daemon is never relaunched by this path or any
  // other — it is handled immediately below.
  //
  // Uncertainty stays a skip: a provider that cannot answer is not evidence.
  let deadDaemonOnRunningBox = false;
  if (classification.klass === 'unreachable') {
    const running = deps.providerRunning
      ? await deps.providerRunning().catch(() => false)
      : false;
    if (!running) return { outcome: 'unreachable', classification };
    // TWO SILENT READS, never one. An 8 s ingress timeout, a restarting proxy
    // or a GC pause reads exactly like a corpse, and a relaunch kills PTYs and
    // restages assets under whoever is using the box. This is
    // `decideStoppedObservation`'s asymmetry applied to the probe instead of
    // the provider's state field: uncertainty fails toward the LIVE box, so the
    // daemon gets a second chance to speak. If it takes it, this pass simply
    // continues with what it said.
    await deps.sleep(DEAD_DAEMON_CONFIRM_MS);
    const second = classifyDaemonHealth(await deps.fetchHealth(), expectedRunningAssets ?? undefined);
    if (second.klass === 'unreachable') {
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
        return { outcome: 'not-legacy', detail: 'daemon alive in the box; the ingress was unreachable', classification };
      }
      deadDaemonOnRunningBox = true;
      deps.log('daemon gone on a running box; relaunching the runtime chain', {
        sandboxId: input.sandboxId,
        externalId: input.externalId,
        provider: input.provider,
      });
    } else {
      classification = second;
      if (classification.klass === 'not-ok') return { outcome: 'unreachable', classification };
    }
  }
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

  // Legacy or stale. Budget and cooldown are per manifest build: a new deploy
  // earns a fresh set of attempts, a box that keeps failing on the same build
  // does not.
  const build = await deps.manifestBuild();
  const sameBuild = record?.manifestBuild === build;
  const attempts = sameBuild && record ? record.attempts : 0;
  if (record && sameBuild && record.state === 'failed') {
    if (attempts >= LEGACY_BOOTSTRAP_MAX_ATTEMPTS && !input.force) {
      return { outcome: 'skipped-exhausted', detail: `${attempts} attempts on build ${build}`, classification };
    }
    const lastMs = Date.parse(record.lastAttemptAt);
    // ESCALATING per-box backoff (30m, 60m, 120m, …, capped): a box that has
    // failed repeatedly is retried less often each time, not on a flat 30m
    // cadence forever — the repair-storm guard for a box that CANNOT be
    // repaired but has not yet spent its attempt budget.
    if (!input.force && Number.isFinite(lastMs) && nowMs - lastMs < legacyBootstrapCooldownMs(attempts)) {
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

  // Never under a running turn. OpenCode's own busy state is the authority —
  // the ledger can hold a zombie turn on exactly the boxes this exists for.
  // OpenCode is proxied BY the daemon, so a dead daemon is also why OpenCode
  // says nothing. That is one fact, not two, and it cannot gate its own repair.
  const status = deadDaemonOnRunningBox ? {} : await deps.fetchOpencodeStatus();
  if (!opencodeIdle(status)) {
    return { outcome: 'skipped-busy', detail: status ? 'opencode busy' : 'opencode unreachable', classification };
  }

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

  const finish = async (
    state: LegacyBootstrapState,
    extra: Partial<LegacyBootstrapRecord>,
    outcome: LegacyBootstrapOutcome,
    detail?: string,
  ): Promise<LegacyBootstrapResult> => {
    const finished: LegacyBootstrapRecord = {
      ...running,
      ...extra,
      state,
      finishedAt: new Date(deps.now()).toISOString(),
    };
    await deps.patchMetadata({ [LEGACY_BOOTSTRAP_METADATA_KEY]: finished });
    await deps.audit({
      outcome: state === 'failed' ? 'failure' : 'success',
      phase: state,
      summary: {
        attempt: finished.attempts,
        strategy,
        reason: input.reason,
        from: finished.from ?? null,
        to: finished.to ?? null,
        detail: detail ?? null,
      },
      error: finished.error,
    });
    deps.log(`legacy runtime bootstrap ${state}`, {
      sandboxId: input.sandboxId,
      externalId: input.externalId,
      outcome,
      detail,
      error: finished.error,
    });
    return { outcome, detail, classification };
  };

  let execResult: SandboxExecResult;
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
  const kortixToken =
    strategy === 'pt-app' ? ((await deps.rotateKortixToken?.()) ?? undefined) : undefined;
  const commitToken = async (rotatedOnBox: boolean | null) => {
    if (!kortixToken) return;
    await deps.commitKortixToken?.(kortixToken, rotatedOnBox);
  };
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
    return finish('failed', { error: `exec: ${message}`.slice(0, 500) }, 'failed', 'provider exec failed');
  }
  await releaseRepair();
  const report = parseScriptReport(execResult);
  await commitToken(report ? report.token_rotated === true : null);
  if (!report) {
    const tail = (execResult.stderr || execResult.stdout).trim().slice(-400);
    return finish(
      'failed',
      { error: `no report (exit ${execResult.exitCode}): ${tail}`.slice(0, 500) },
      'failed',
      'script produced no report',
    );
  }
  if (!report.ok) {
    return finish(
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
    return { outcome: 'skipped-busy', detail: 'a turn started during the repair; relaunch deferred', classification };
  }
  const to = { agentSha256: report.agent_sha256, entrypointSha256: report.entrypoint_sha256 };
  if (report.stage === 'staged') {
    return finish('staged', { to }, 'staged', 'staged; converges at the provider\'s next start');
  }

  // Relaunched. The new daemon must now report a runtime block AND a serving
  // OpenCode — the convergence pass installs the pinned OpenCode at boot, and
  // "done" means a prompt would work, not that a process is listening.
  const deadline = deps.now() + LEGACY_BOOTSTRAP_CONVERGE_BUDGET_MS;
  let last: RuntimeClassification | null = null;
  while (deps.now() < deadline) {
    const after = classifyDaemonHealth(await deps.fetchHealth(), expectedRunningAssets ?? undefined);
    last = after;
    // The daemon reports its own convergence pass. `failed` is final for this
    // boot — waiting would not change it — and the reason lives in
    // /kortix/diag. Checked INDEPENDENTLY of overall `klass`: opencode can be
    // the one failed component on an otherwise-`stale` box (another
    // component still catching up, or `running` not yet re-reported this
    // pass) and the failure is just as final either way.
    if (after.opencodeComponent === 'failed') {
      return finish(
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
      const converged = await finish('converged', { to: { ...to, runtimeBuild: after.runtimeBuild } }, 'converged');
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
  return finish(
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
