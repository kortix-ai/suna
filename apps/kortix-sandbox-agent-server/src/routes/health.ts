import { Hono } from 'hono'
import { readFileSync } from 'node:fs'

import type { Config } from '../config'
import { readRepoInfo } from '../git'
import type { Opencode } from '../opencode'
import { opencodeTurnInFlight } from '../opencode-turn-state'

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
  /** True when boot must create a first OpenCode conversation before the UI is usable. */
  initialOpenCodeSessionRequired?: boolean
  /** OpenCode session id created during boot, if one was requested. */
  initialOpenCodeSessionId?: string | null
  /** Boot-time OpenCode session creation failure. */
  initialOpenCodeSessionError?: string | null
}

/**
 * The single Kortix-owned route on the daemon.
 *
 * Shape:
 *   {
 *     daemon: 'ok',
 *     status: 'ok' | 'starting' | 'down' | 'error',
 *     runtimeReady: boolean,
 *     opencode: 'ok' | 'starting' | 'down',
 *     uptime_s: number,
 *     opencode_pid: number | null,
 *     static_web_port: number | null,  // bound static-web port, null if down
 *     repo: string | null,    // remote URL of the materialized repo, if any
 *     branch: string | null,
 *     commit_sha: string | null,
 *     agent_config_etag: string | null
 *   }
 *
 * Always returns 200 even when opencode is down — this is the daemon's own
 * liveness probe, not opencode's.
 */
export function createHealthRouter(
  cfg: Config,
  opencode: Opencode,
  bootTime: number,
  bootState: SandboxBootState,
  staticWebPort: number | null = null,
): Hono {
  const router = new Hono()

  router.get('/', async (c) => {
    const repoInfo = await readRepoInfo(cfg.projectTarget).catch(() => null)
    const opencodeState = opencode.getState()
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
    const initialSessionReady =
      !bootState.initialOpenCodeSessionRequired || !!bootState.initialOpenCodeSessionId
    const initialSessionError = bootState.initialOpenCodeSessionError ?? null
    const runtimeReady =
      repoReady &&
      !bootState.repoMaterializationError &&
      !initialSessionError &&
      opencodeState === 'ok' &&
      initialSessionReady
    const status = runtimeReady
      ? 'ok'
      : bootState.repoMaterializationError || initialSessionError
        ? 'error'
        : opencodeState

    return c.json({
      daemon: 'ok',
      status,
      runtimeReady,
      opencode: opencodeState,
      uptime_s: Math.floor((Date.now() - bootTime) / 1000),
      opencode_pid: opencode.getPid(),
      // The port opencode is listening on right now. It ALTERNATES: a verified
      // reload boots the replacement on the idle half of the port pair and
      // promotes it. The API's PTY proxy has to reach opencode directly (the
      // daemon cannot carry a WebSocket) and previously hardcoded 4096, which
      // becomes the dead half after one reload.
      opencode_port: opencode.getActivePort(),
      // Static web server (preview/static files). The bound port when up, else
      // null — surfaces "preview won't load because static-web never bound".
      static_web_port: staticWebPort,
      repo_required: repoRequired,
      repo_ready: repoReady,
      repo: repoInfo?.remoteUrl ?? null,
      branch: repoInfo?.branch ?? null,
      commit_sha: repoInfo?.commit ?? null,
      // The content hash of the compiled agent config THIS opencode spawned
      // with. Not derivable from commit_sha: a warm-workspace refresh advances
      // the commit while deliberately skipping the restart, so a box can report
      // the newest commit and still be running config compiled days ago. Read
      // from the live process env, so it tracks a hot push as well as a boot.
      agent_config_etag: process.env.KORTIX_COMPILED_AGENT_CONFIG_ETAG || null,
      // Opt-in (`?turn=1`) because it costs a call into opencode, and health is
      // polled as a liveness check every few seconds on every idle box. Only the
      // reload gate asks — it must not restart the runtime out from under a turn
      // that is still running.
      ...(c.req.query('turn') === '1'
        ? {
            turn_in_flight: await opencodeTurnInFlight(
              opencode.getInternalUrl(),
              process.env.KORTIX_WORKSPACE || '/workspace',
            ),
          }
        : {}),
      boot_error: bootState.repoMaterializationError ?? initialSessionError,
      opencode_session_id: bootState.initialOpenCodeSessionId ?? null,
      opencode_session_required: !!bootState.initialOpenCodeSessionRequired,
      // In-container boot timeline (ms since process start) so the dashboard can
      // attribute the post-create boot latency (clone vs opencode vs proxy).
      boot_timeline: bootState.timeline,
      // Visible auth posture so misconfiguration doesn't silently downgrade.
      auth: cfg.sandboxToken ? 'configured' : 'unconfigured',
    })
  })

  return router
}
