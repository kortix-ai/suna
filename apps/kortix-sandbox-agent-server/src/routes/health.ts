import { Hono } from 'hono'
import { readFileSync } from 'node:fs'

import type { Config } from '../config'
import { readRepoInfo } from '../git'
import type { AcpRuntime } from '../acp/runtime'

/**
 * The branch this VM's session is supposed to be on, read from the host-
 * written env file rather than process.env: warm-seed forks resume a process
 * whose env predates the session (adoption reloads it ~250ms later), but
 * /etc/pt-env carries the session's KORTIX_BRANCH_NAME from the instant the
 * VM exists — so the readiness gate below is correct even pre-adoption.
 * Empty when this VM is a seed builder (no session) → gate inert.
 */
function wantedSessionBranch(): string {
  try {
    const m = readFileSync('/etc/pt-env', 'utf8').match(/^KORTIX_BRANCH_NAME=(\S+)/m)
    if (m?.[1]) return m[1]
  } catch { /* no env file (local dev) */ }
  return (process.env.KORTIX_BRANCH_NAME ?? '').trim()
}

/**
 * Whether THIS sandbox's session expects a repo — from the host-written env
 * file, NOT the frozen process env. A warm-snapshot fork resumes a daemon
 * whose process booted as a repo-less warm seed (autoClone unset), so
 * cfg.autoClone said "no repo required" and health reported ready ~100ms
 * after fork while adoption was still fetching the repo — the frontend then
 * stormed a mid-adoption runtime and stuck (caught live 2026-06-12, second
 * variant of the same class as wantedSessionBranch).
 */
function sessionWantsRepo(cfgAutoClone: boolean): boolean {
  if (cfgAutoClone) return true
  try {
    return /^KORTIX_PROJECT_AUTO_CLONE=1/m.test(readFileSync('/etc/pt-env', 'utf8'))
  } catch {
    return false
  }
}

export type BootMark = { label: string; atMs: number }

export type SandboxBootState = {
  repoMaterializationError: string | null
  /** In-container boot timeline (ms since process start) for latency benchmarking. */
  timeline: BootMark[]
  /** Selected v3 ACP harness and process identity. */
  acpHarness?: 'claude' | 'codex' | 'opencode' | 'pi' | null
  acpServerId?: string | null
  acpRuntimeReady?: boolean
  acpRuntimeError?: string | null
}

/**
 * The single Kortix-owned route on the daemon.
 *
 * Shape:
 *   {
 *     daemon: 'ok',
 *     status: 'ok' | 'starting' | 'down' | 'error',
 *     runtimeReady: boolean,
 *     uptime_s: number,
 *     static_web_port: number | null,  // bound static-web port, null if down
 *     repo: string | null,    // remote URL of the materialized repo, if any
 *     branch: string | null,
 *     commit_sha: string | null
 *   }
 *
 * Always returns 200 because this is the daemon's own liveness probe.
 */
export function createHealthRouter(
  cfg: Config,
  bootTime: number,
  bootState: SandboxBootState,
  staticWebPort: number | null = null,
  acpRuntime?: AcpRuntime,
): Hono {
  const router = new Hono()

  router.get('/', async (c) => {
    const repoInfo = await readRepoInfo(cfg.projectTarget).catch(() => null)
    const repoRequired = sessionWantsRepo(cfg.autoClone)
    // A repo on disk isn't ready until it's on the SESSION branch: the clone
    // path renames the repo into place BEFORE the branch checkout (which can
    // wait seconds on a remote-branch fetch), and warm-seed forks resume on
    // the seed's default branch until adoption re-checks-out. Without the
    // branch gate, runtimeReady=true had a window where a prompt would land
    // on the default branch (observed live: `main` at ready, session branch
    // +3s). Seed builders have no session branch → gate inert for capture.
    const wantBranch = repoRequired ? wantedSessionBranch() : ''
    const repoReady =
      !repoRequired || (repoInfo !== null && (!wantBranch || repoInfo.branch === wantBranch))
    // `bootState.acpRuntimeReady` is a ONE-TIME flag set the instant `main.ts`'s
    // single boot-time `getOrCreate` call resolved without throwing — it is
    // NEVER updated again for the rest of this daemon's life. A harness that
    // spawned fine at boot but has since died (crashed, was OOM-killed, or was
    // recycled after a credential rotation — see `AcpRuntime.recycleIdle`) left
    // this flag stuck at `true` forever, so `/kortix/health` kept reporting
    // `acp_ready: true` / `runtimeReady: true` long after the actual process
    // was gone (`acpRuntime.list()` empty). `/start`'s polling loop
    // (routes/shared.ts) trusts this field verbatim to decide `stage: 'ready'`
    // — a lying "ready" here means the session page's ACP handshake gate opens
    // for a harness that isn't running, the client's own `initialize` POSTs
    // fail against a dead/respawning process, and — because `session.phase`
    // is ALREADY `'ready'` from this stale signal — the web app's 90s
    // wall-clock boot backstop (`hasSessionBootTimedOut`) never even arms
    // (it explicitly no-ops once `ready` is true, deferring to the ACP layer's
    // own error handling). Net effect: "Connecting" spins forever with no
    // terminal signal anywhere in the stack. Cross-check the boot flag against
    // the RUNTIME'S OWN CURRENT registry (`acpRuntime.get`, already used below
    // for `acp_busy`) so a harness that has since died is reported honestly on
    // every poll — the next `/acp` request still transparently respawns it
    // (this is just a status report, not a control action).
    const acpProcessLive = !!(bootState.acpServerId && acpRuntime?.get(bootState.acpServerId))
    const runtimeError =
      bootState.acpRuntimeError ??
      (bootState.acpRuntimeReady && !acpProcessLive
        ? 'ACP harness process is not currently running (it will respawn on the next request)'
        : null)
    const runtimeReady =
      repoReady &&
      !bootState.repoMaterializationError &&
      !runtimeError &&
      !!bootState.acpRuntimeReady &&
      acpProcessLive
    const status = runtimeReady
      ? 'ok'
      : bootState.repoMaterializationError || runtimeError
        ? 'error'
        : 'starting'

    return c.json({
      daemon: 'ok',
      status,
      runtimeReady,
      runtime: 'acp',
      acp_harness: bootState.acpHarness ?? null,
      acp_server_id: bootState.acpServerId ?? null,
      acp_ready: runtimeReady,
      acp_busy: acpRuntime?.get(bootState.acpServerId ?? '')?.busy ?? false,
      uptime_s: Math.floor((Date.now() - bootTime) / 1000),
      // Static web server (preview/static files). The bound port when up, else
      // null — surfaces "preview won't load because static-web never bound".
      static_web_port: staticWebPort,
      repo_required: repoRequired,
      repo_ready: repoReady,
      repo: repoInfo?.remoteUrl ?? null,
      branch: repoInfo?.branch ?? null,
      commit_sha: repoInfo?.commit ?? null,
      boot_error: bootState.repoMaterializationError ?? runtimeError,
      // In-container boot timeline (ms since process start) so the dashboard can
      // attribute the post-create boot latency (clone vs opencode vs proxy).
      boot_timeline: bootState.timeline,
      // Visible auth posture so misconfiguration doesn't silently downgrade.
      auth: cfg.sandboxToken ? 'configured' : 'unconfigured',
    })
  })

  return router
}
