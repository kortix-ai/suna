/**
 * The daemon-health classifier of the legacy runtime bootstrap: one pure read
 * of a `/kortix/health` body into `legacy | current | stale | blocked | not-ok
 * | unreachable`, with the exact stale reasons. No I/O, no state — the repair
 * state machine (`legacy-runtime-repair.ts`) decides what to DO with each
 * class; this module owns what the box's own words mean.
 */
import { healthHarnessId, healthRuntimeState } from '@kortix/api-contract/runtime-relay';
import { CONFIG_RELEASE_CAPABILITY } from './session-config-release';

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
