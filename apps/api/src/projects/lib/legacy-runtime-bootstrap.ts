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

/**
 * The one import surface (facade). The implementation lives in three modules
 * along its real seams — the health classifier (`legacy-runtime-health.ts`),
 * the in-box bash script (`legacy-runtime-script.ts`), and the repair state
 * machine (`legacy-runtime-repair.ts`) — and every historical import of this
 * path keeps resolving the same names.
 */
export {
  classifyDaemonHealth,
  FIRST_CONVERGENCE_GRACE_S,
  REQUIRED_RUNTIME_CAPABILITIES,
  type ExpectedRunningAssets,
  type RuntimeClassification,
  type StaleReason,
} from './legacy-runtime-health';
export {
  bootstrapExecCommand,
  parseScriptReport,
  relaunchStrategyFor,
  renderLegacyBootstrapScript,
} from './legacy-runtime-script';
export {
  bootstrapLegacyRuntime,
  decideDeadDaemonOnOpen,
  describeLegacyBootstrapRetry,
  legacyBootstrapCooldownMs,
  opencodeIdle,
  DEAD_DAEMON_REPAIR_BUDGET_MS,
  DEAD_DAEMON_REPAIR_REQUESTED_KEY,
  LEGACY_BOOTSTRAP_CONVERGE_BUDGET_MS,
  LEGACY_BOOTSTRAP_COOLDOWN_MS,
  LEGACY_BOOTSTRAP_MAX_ATTEMPTS,
  LEGACY_BOOTSTRAP_MAX_COOLDOWN_MS,
  LEGACY_BOOTSTRAP_METADATA_KEY,
  LEGACY_BOOTSTRAP_STALE_RUNNING_MS,
  LEGACY_CHECK_METADATA_KEY,
  LEGACY_CHECK_TTL_MS,
  type LegacyBootstrapDeps,
  type LegacyBootstrapResult,
  type LegacyBootstrapRetrySummary,
} from './legacy-runtime-repair';
