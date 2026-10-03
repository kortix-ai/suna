import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CatalogSnapshot, HarnessDiagnosticsContext } from '../contract/diagnostics'
import { readRepoInfo } from '@/lib/git/git'
import { runtimeConvergenceReport } from '@/services/runtime-assets/runtime-assets'
import { runtimeTruthReport } from '@/services/runtime-assets/runtime-truth'

/**
 * The branch this VM's session is supposed to be on, read from the host-
 * written env file rather than process.env: warm-seed forks resume a process
 * whose env predates the session (adoption reloads it ~250ms later), but
 * /etc/pt-env carries the session's KORTIX_BRANCH_NAME from the instant the
 * VM exists — so the readiness gate below is correct even pre-adoption.
 * Empty when this VM is a seed builder (no session) → gate inert.
 */
// Read per call, not at module load: a test masks the host env file inside its
// own body, after this module's imports have already evaluated.
function ptEnvPath(): string {
  return (process.env.KORTIX_PT_ENV_PATH ?? '').trim() || '/etc/pt-env'
}

function wantedSessionBranch(): string {
  try {
    const m = readFileSync(ptEnvPath(), 'utf8').match(/^KORTIX_BRANCH_NAME=(\S+)/m)
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
    return /^KORTIX_PROJECT_AUTO_CLONE=1/m.test(readFileSync(ptEnvPath(), 'utf8'))
  } catch {
    return false
  }
}

/**
 * The `/kortix/health` fields the host owns. Every harness reports them with
 * the same meaning; `routes/kortix/health.ts` adds the harness block and
 * computes `runtimeReady` from `repo_ready` plus the harness's own readiness.
 */
export async function readHostHealth(context: HarnessDiagnosticsContext, catalogSnapshot?: CatalogSnapshot) {
  const { cfg, bootState } = context
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
  const repoReady = !repoRequired || (repoInfo !== null && (!wantBranch || repoInfo.branch === wantBranch))
  return {
    // Which boot path this daemon took. An agent binary that predates
    // monitor mode omits the field entirely, which is exactly what the
    // monitor-box reconciler uses to detect a stale-agent box and recreate
    // it (a box whose env says KORTIX_WORKLOAD=monitor but whose daemon
    // booted the session path can never run monitors).
    workload: process.env.KORTIX_WORKLOAD === 'monitor' ? 'monitor' : 'session',
    uptime_s: Math.floor((Date.now() - context.bootTime) / 1000),
    // Static web server (preview/static files). The bound port when up, else
    // null — surfaces "preview won't load because static-web never bound".
    static_web_port: context.staticWebPort,
    repo_required: repoRequired,
    repo_ready: repoReady,
    repo: repoInfo?.remoteUrl ?? null,
    branch: repoInfo?.branch ?? null,
    commit_sha: repoInfo?.commit ?? null,
    compiled_boot_mode: cfg.compiledBootMode,
    compiled_checkout: existsSync(join(cfg.projectTarget, '.git', 'kortix-compiled-checkout.json')),
    // The content hash of the compiled agent config the runtime spawned
    // with. Not derivable from commit_sha: a warm-workspace refresh advances
    // the commit while deliberately skipping the restart, so a box can report
    // the newest commit and still be running config compiled days ago. Read
    // from the live process env, so it tracks a hot push as well as a boot.
    agent_config_etag: process.env.KORTIX_COMPILED_AGENT_CONFIG_ETAG || null,
    // What this box last converged its own runtime to. Auto-update without
    // reporting only moves the uncertainty — this makes "is the fleet
    // current?" a query instead of a hope, and it is the signal that tells us
    // a fleet-drain gate has actually cleared. `pinned: true` means an update
    // crash-looped and the supervisor latched it off: that box will not
    // self-heal and needs a human.
    runtime: await runtimeConvergenceReport(undefined, undefined, catalogSnapshot),
    // The runtime-convergence contract (PR #7785), Rule 1: the ONE actual-runtime
    // document (release, catalog, daemon, cli, managed skills), each with its
    // own convergence state. The API computes the desired document and diffs
    // the two; this is only the box's own answer. A pure read — never
    // triggers a reconcile attempt, so polling health cannot itself cause work.
    runtime_truth: await runtimeTruthReport(),
    // Which config provider delivered the project this boot (git | s3), the
    // expected vs actual SHA, and — when S3 was attempted and Git delivered
    // instead — the classified reason. A successful fallback keeps the S3
    // failure visible here; the same facts go to the boot timeline relay.
    config_provider: bootState.configProvider ?? null,
    // In-container boot timeline (ms since process start) so the dashboard can
    // attribute the post-create boot latency (clone vs runtime vs proxy).
    boot_timeline: bootState.timeline,
    // Visible auth posture so misconfiguration doesn't silently downgrade.
    auth: cfg.sandboxToken ? 'configured' : 'unconfigured',
  }
}
