/**
 * The health `runtime` block, as the API reads it.
 *
 * WHY THIS EXISTS AT ALL. The daemon has served this block since convergent
 * runtime shipped, and until now nothing in `apps/api` read it — `git grep -n
 * runtimeConvergenceReport -- apps/api` returned nothing, and
 * `readSandboxConfigState` destructured only the config fields. Two facts were
 * therefore produced and thrown away on every health call:
 *
 *  - `pinned: true` — a previous daemon update crash-looped, the supervisor
 *    rolled it back and latched updates OFF. That box will NOT self-heal. The
 *    daemon re-reads the latch from disk on every health call specifically so
 *    this is visible, and nobody was looking.
 *  - `running` — which bytes are actually on the box. Without it the control
 *    plane cannot tell a current box from a behind one, so its only options were
 *    to send a refresh on every turn or to never send one.
 *
 * Pure parsing. Every read is total: a field that is missing, null or the wrong
 * type answers "not stated" rather than throwing, for the same reason the daemon
 * reads the manifest that way — a control plane that crashes on a daemon shape
 * it does not recognise is a control plane that cannot be rolled forward.
 *
 * A LEAF: it imports nothing, so `projects/lib/session-reload.ts` can read the
 * block without pulling the runtime-assets graph (and its 200 MB of binary
 * hashing) into the reload path.
 */

/** The digests a box says it has on disk. Null for a daemon that predates it. */
export interface DaemonRunningAssets {
  cli_sha256: string | null;
  managed_skills_hash: string | null;
  agent_sha256: string | null;
  /** Verified and waiting for the supervisor; the box is NOT running it yet. */
  staged_agent_sha256: string | null;
  opencode_version: string | null;
}

export interface DaemonRuntimeReport {
  /** The manifest epoch the last PASS converged to; null before the first one. */
  build: number | null;
  at: string | null;
  /** A verified daemon binary is staged; the box is not running it yet. */
  agentSwapPending: boolean;
  /**
   * Updates are latched off after a rollback. This box needs a human — see
   * `runtimeRollbackAlarm`.
   */
  pinned: boolean;
  running: DaemonRunningAssets | null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Parse the health `runtime` block. Null when absent or not an object. */
export function parseDaemonRuntimeReport(value: unknown): DaemonRuntimeReport | null {
  if (!isRecord(value)) return null;
  const running = isRecord(value.running)
    ? {
        cli_sha256: str(value.running.cli_sha256),
        managed_skills_hash: str(value.running.managed_skills_hash),
        agent_sha256: str(value.running.agent_sha256),
        staged_agent_sha256: str(value.running.staged_agent_sha256),
        opencode_version: str(value.running.opencode_version),
      }
    : null;
  return {
    build: num(value.build),
    at: str(value.at),
    // Only a literal `true` counts, for both flags. A truthy-but-wrong value
    // must not page someone, and must not read as "fine" either.
    agentSwapPending: value.agentSwapPending === true,
    pinned: value.pinned === true,
    running,
  };
}
