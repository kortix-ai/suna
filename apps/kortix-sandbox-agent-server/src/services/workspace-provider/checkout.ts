/**
 * The session checkout every route ends with: the warm adoption of a baked
 * checkout, the stage → swap into the target, the session branch, `origin`,
 * the repo identity and the adoption marker. The git route (git.ts) and the
 * S3 route (acquire.ts) both finish here, so `/workspace` looks the same
 * whichever route delivered it.
 */
import { mkdir, readdir, rename, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'

import type { Config } from '@/lib/config/config'
import { configureRepoGitIdentity, configureSafeDirectory, execGit, gitWithAuth, pathExists, type CloneCredential, type ExecResult } from '@/lib/git/git'
import { logger } from '@/lib/log/logger'

export async function isRepoMaterialized(target: string): Promise<boolean> {
  return pathExists(`${target}/.git`)
}

const SESSION_ADOPTION_CONFIG_KEY = 'kortix.adopted-session'

/**
 * A fresh-image hint describes only the first materialization attempt. Provider
 * env persists across daemon restarts, so the hint cannot by itself identify a
 * pristine image checkout. This local marker is written only after the checkout
 * becomes this session's workspace. It lives in .git/config and never enters a
 * commit or a newly built project image.
 */
async function sessionCheckoutAdoptionState(
  target: string,
  branchName: string | undefined,
): Promise<{ adopted: boolean; markerMatches: boolean }> {
  if (!branchName) return { adopted: false, markerMatches: false }
  const marker = await execGit([
    '-C', target, 'config', '--local', '--get', SESSION_ADOPTION_CONFIG_KEY,
  ])
  if (marker.code === 0 && marker.stdout.trim() === branchName) {
    return { adopted: true, markerMatches: true }
  }

  // Rollout compatibility: sessions created before the marker shipped already
  // have their local session branch. A pristine image cannot contain a branch
  // named after a not-yet-created session, so this ref is also proof of adoption.
  const sessionRef = await execGit([
    '-C', target, 'rev-parse', '--verify', '--quiet', `refs/heads/${branchName}`,
  ])
  return { adopted: sessionRef.code === 0, markerMatches: false }
}

export async function markSessionCheckoutAdopted(target: string, branchName: string | undefined): Promise<void> {
  if (!branchName) return
  const marked = await execGit([
    '-C', target, 'config', '--local', SESSION_ADOPTION_CONFIG_KEY, branchName,
  ])
  if (marked.code !== 0) {
    throw new Error(`git config ${SESSION_ADOPTION_CONFIG_KEY} failed: ${marked.stderr || marked.stdout}`)
  }
}

async function establishBaseRefsFromBakedHead(
  target: string,
  base: string,
  bakedHead: string,
): Promise<void> {
  const localBaseRef = `refs/heads/${base}`
  const remoteBaseRef = `refs/remotes/origin/${base}`
  const remoteHeadRef = 'refs/remotes/origin/HEAD'
  const commands: Array<{ args: string[]; action: string }> = [
    { args: ['update-ref', localBaseRef, bakedHead], action: `set ${localBaseRef}` },
    { args: ['update-ref', remoteBaseRef, bakedHead], action: `set ${remoteBaseRef}` },
    { args: ['symbolic-ref', remoteHeadRef, remoteBaseRef], action: `set ${remoteHeadRef}` },
    {
      args: ['branch', `--set-upstream-to=origin/${base}`, '--', base],
      action: `track origin/${base} from ${base}`,
    },
  ]
  for (const command of commands) {
    const result = await execGit(['-C', target, ...command.args])
    if (result.code !== 0) {
      throw new Error(`failed to ${command.action}: ${result.stderr || result.stdout}`)
    }
  }
  logger.info('[git] established base refs from baked checkout', {
    target,
    base,
    head: bakedHead,
  })
}

/**
 * Remove a STALE git lock before a checkout. A `.git/index.lock` left behind by
 * a git process that crashed or was killed mid-op (e.g. the daemon was OOM-killed
 * or restarted during materialization) makes every later `git checkout` fail with
 * "Unable to create '.../index.lock': File exists" — which surfaced to users as
 * "failed to create local session branch … Another git process seems to be
 * running". Safe here: the session-branch checkout is the sole sequential git op
 * on a freshly-materialized workspace, so any lock present is necessarily stale.
 */
async function clearStaleGitLock(target: string): Promise<void> {
  for (const lock of ['index.lock', 'HEAD.lock']) {
    await rm(join(target, '.git', lock), { force: true }).catch(() => {})
  }
}

/** True when `target` is a shallow (depth-limited) clone. */
export async function isShallowRepo(target: string): Promise<boolean> {
  const res = await execGit(['-C', target, 'rev-parse', '--is-shallow-repository'])
  return res.code === 0 && res.stdout.trim() === 'true'
}

function isMissingRemoteBranch(result: ExecResult): boolean {
  const output = `${result.stderr}\n${result.stdout}`
  return /couldn't find remote ref|remote ref .* not found|remote branch .* not found/i.test(output)
}

export async function checkoutSessionBranch(
  cfg: Config,
  target: string,
  branch: string,
  credential: CloneCredential | undefined,
): Promise<void> {
  const refSpec = `+refs/heads/${branch}:refs/remotes/origin/${branch}`
  // Keep a shallow repo shallow while fetching the session branch — without
  // this, git deepens to full history and hands the resume path the exact cost
  // the shallow clone just avoided. Gated on the repo ACTUALLY being shallow:
  // once the background backfill has unshallowed it, passing --depth would
  // re-truncate a complete repo.
  const depthArgs = (await isShallowRepo(target)) ? ['--depth', '1'] : []
  // Same stall-abort + hard timeout as the clone: a restored VM's RX can hang
  // this fetch with no reset. A replacement boot must fail closed on transport
  // errors. Otherwise it can create a local branch from the base, mark the
  // checkout adopted, and permanently hide existing remote session commits.
  const fetched = await gitWithAuth(credential, cfg.repoUrl, [
    '-c', 'http.lowSpeedLimit=1000', '-c', 'http.lowSpeedTime=12',
    '-C',
    target,
    'fetch',
    ...depthArgs,
    'origin',
    refSpec,
  ], { timeoutMs: 30_000 })

  if (fetched.code === 0) {
    await clearStaleGitLock(target)
    const checkout = await gitWithAuth(credential, cfg.repoUrl, [
      '-C',
      target,
      'checkout',
      '-B',
      branch,
      `refs/remotes/origin/${branch}`,
    ])
    if (checkout.code === 0) {
      logger.info('[git] checked out remote session branch', { branch })
      return
    }
    if (cfg.sessionBranchRestore) {
      throw new Error(
        `failed to restore remote session branch ${branch}: ${checkout.stderr || checkout.stdout}`,
      )
    }
    logger.warn('[git] remote session branch checkout failed; creating local branch', {
      branch,
      stderr: checkout.stderr.slice(0, 300),
    })
  } else {
    if (cfg.sessionBranchRestore && !isMissingRemoteBranch(fetched)) {
      throw new Error(
        `failed to restore remote session branch ${branch}: ${fetched.stderr || fetched.stdout}`,
      )
    }
    logger.info('[git] remote session branch not ready; creating local branch from base checkout', {
      branch,
      stderr: fetched.stderr.slice(0, 300),
    })
  }

  await clearStaleGitLock(target)
  const local = await gitWithAuth(credential, cfg.repoUrl, [
    '-C',
    target,
    'checkout',
    '-B',
    branch,
  ])
  if (local.code !== 0) {
    throw new Error(`failed to create local session branch ${branch}: ${local.stderr}`)
  }
  logger.info('[git] created local session branch', { branch })
}

export async function checkoutLocalSessionBranch(target: string, branch: string): Promise<void> {
  await clearStaleGitLock(target)

  // `-B` with no start point RESETS the branch to whatever HEAD is. That is
  // right exactly once — creating the session branch on a fresh baked checkout —
  // and destructive every other time, because this runs on EVERY daemon boot
  // where /workspace/.git already exists.
  //
  // The damage needs no attacker and no unusual behaviour: the agent moves HEAD
  // off the session branch (a `git checkout main` to diff against base is
  // ordinary), then the box reboots in place — the idle reaper and the proxy's
  // auto-resume both do that with no user action at all — and every commit the
  // session made is force-reset away. `git checkout -B` exits 0 and prints only
  // "Switched to and reset branch", so nothing surfaces; the commits survive
  // solely in a reflog the user is never told about.
  // So: only CREATE. If the ref already exists, a plain checkout moves HEAD to
  // it and cannot move the ref.
  const exists = await execGit([
    '-C', target, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`,
  ])
  if (exists.code === 0) {
    const switched = await execGit(['-C', target, 'checkout', branch])
    if (switched.code !== 0) {
      // Deliberately NOT falling back to `-B`: that fallback is the data loss.
      // A session left on another branch still boots and still has its files;
      // a reset one has lost commits. Loud, and non-fatal.
      logger.error('[git] could not switch to the existing session branch; leaving HEAD as-is', {
        branch,
        stderr: switched.stderr,
      })
      return
    }
    logger.info('[git] switched to existing session branch', { branch })
    return
  }

  const local = await execGit(['-C', target, 'checkout', '-B', branch])
  if (local.code !== 0) {
    throw new Error(`failed to create local session branch ${branch}: ${local.stderr}`)
  }
  logger.info('[git] created local session branch from baked checkout', { branch })
}

export async function clearDirContents(dir: string, keep?: string): Promise<void> {
  for (const entry of await readdir(dir)) {
    if (entry === keep) continue
    await rm(join(dir, entry), { recursive: true, force: true })
  }
}

/** Crash-safe enough for boot: a failure mid-swap leaves a `.kortix-*` stage
 *  dir that the next attempt's clearDirContents/createStagePath cycle wipes. */
export async function swapStageIntoTarget(stage: string, target: string): Promise<void> {
  await clearDirContents(target, basename(stage))
  for (const entry of await readdir(stage)) {
    await rename(join(stage, entry), join(target, entry))
  }
  await rm(stage, { recursive: true, force: true })
}

/** `origin` → the session's proxied repo URL, whether or not the checkout shipped with a remote. */
async function ensureOriginRemote(target: string, repoUrl: string): Promise<void> {
  const existing = await execGit(['-C', target, 'remote', 'get-url', 'origin'])
  const result =
    existing.code === 0
      ? await execGit(['-C', target, 'remote', 'set-url', 'origin', repoUrl])
      : await execGit(['-C', target, 'remote', 'add', 'origin', repoUrl])
  if (result.code !== 0) throw new Error(`git remote origin setup failed: ${result.stderr || result.stdout}`)
}

/**
 * Shared checkout finalization for a VERIFIED stage produced by a non-Git
 * transport (the S3 transport in acquire.ts): swap it into the target, reconnect the
 * session remote (the archive ships no remote — never a credential-bearing
 * one), create the local session branch, pin the repo identity, and mark the
 * checkout adopted, so every later Git operation — credential helper,
 * refresh, config-dir sync, push — finds the workspace a clone leaves.
 */
export async function finalizeSnapshotStage(cfg: Config, stage: string): Promise<void> {
  const repoUrl = requireRepoUrl(cfg)
  const target = cfg.projectTarget
  await swapStageIntoTarget(stage, target)
  await ensureOriginRemote(target, repoUrl)
  await configurePartialClone(target)
  if (cfg.branchName) await pointHeadAtSessionBranch(target, cfg.branchName)
  await configureRepoGitIdentity(cfg, target)
  await markSessionCheckoutAdopted(target, cfg.branchName)
}

/**
 * The snapshot's `.git` ships without blobs (its one pack is marked promisor).
 * Declare `origin` the promisor remote with a blob-less filter so git treats
 * every missing blob as fetchable-on-demand through the proxy — the safety net
 * until the blob pack is imported — and so the later history backfill stays
 * blob-less too. Config only; nothing here reads the working tree.
 */
async function configurePartialClone(target: string): Promise<void> {
  const settings: Array<[string, string]> = [
    ['core.repositoryformatversion', '1'],
    ['extensions.partialclone', 'origin'],
    ['remote.origin.promisor', 'true'],
    ['remote.origin.partialclonefilter', 'blob:none'],
  ]
  for (const [key, value] of settings) {
    const res = await execGit(['-C', target, 'config', '--local', key, value])
    if (res.code !== 0) throw new Error(`git config ${key} failed: ${res.stderr || res.stdout}`)
  }
}

/**
 * Create the session branch at HEAD and point HEAD at it WITHOUT a checkout.
 * `git checkout -B` would refresh the index — stat and hash every file — and
 * a snapshot ships an index with no stat data, so that would put a full-tree
 * hash on the boot path (and, blob-less, it has nothing to read the old
 * content from). `branch` + `symbolic-ref` touch refs only; the tree is
 * already exactly HEAD. An existing ref is reused, never reset (see
 * checkoutLocalSessionBranch for why).
 */
async function pointHeadAtSessionBranch(target: string, branch: string): Promise<void> {
  const exists = await execGit(['-C', target, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
  if (exists.code !== 0) {
    const created = await execGit(['-C', target, 'branch', branch, 'HEAD'])
    if (created.code !== 0) throw new Error(`failed to create local session branch ${branch}: ${created.stderr}`)
  }
  const pointed = await execGit(['-C', target, 'symbolic-ref', 'HEAD', `refs/heads/${branch}`])
  if (pointed.code !== 0) throw new Error(`failed to point HEAD at ${branch}: ${pointed.stderr}`)
  logger.info('[git] session branch created without checkout (snapshot)', { branch })
}

export function requireRepoUrl(cfg: Config): string {
  if (!cfg.repoUrl) {
    throw new Error('KORTIX_PROJECT_AUTO_CLONE is enabled but KORTIX_REPO_URL is unset')
  }
  return cfg.repoUrl
}

/**
 * The warm half of materialization, split out so the workspace provider
 * coordinator can run it BEFORE choosing a transport: a baked checkout that IS
 * this session's base is adopted in place (returns true — nothing to acquire),
 * anything else is cleared so a fresh acquisition (S3 or Git) lands in an empty
 * target (returns false). Behaviour is unchanged from the original in-line
 * block of materializeRepo.
 */
export async function adoptOrClearBakedCheckout(cfg: Config): Promise<boolean> {
  const repoUrl = requireRepoUrl(cfg)
  const target = cfg.projectTarget
  const base = cfg.defaultBranch
  await mkdir(target, { recursive: true })

  if (!(await pathExists(`${target}/.git`))) return false
  {
    await configureSafeDirectory(target)
    // The warm seed bakes the canonical SCAFFOLD at /workspace so opencode is
    // already project-initialized in the snapshot. A fork may reuse it ONLY when
    // the baked content IS this session's base — i.e. a fresh scaffold-rooted
    // project (baked HEAD == the server-resolved KORTIX_BASE_SHA). When it isn't
    // (an imported repo / diverged project), the baked scaffold is the WRONG
    // content: discard it and re-materialize the real repo below. A fresh
    // session with no baseSha is also unverified and must fall back. The
    // one-time adoption marker distinguishes that pristine image checkout from
    // this session's existing workspace on later daemon restarts. Provider env
    // persists, so KORTIX_SESSION_FRESH alone cannot make that distinction.
    const bakedHead = (await execGit(['-C', target, 'rev-parse', 'HEAD'])).stdout.trim()
    const adoption = cfg.sessionFresh || cfg.sessionBranchRestore
      ? await sessionCheckoutAdoptionState(target, cfg.branchName)
      : { adopted: false, markerMatches: false }
    const restoreNeeded = !!cfg.sessionBranchRestore && !adoption.markerMatches
    const mismatched =
      restoreNeeded ||
      (cfg.sessionFresh && !adoption.adopted && (!cfg.baseSha || bakedHead !== cfg.baseSha))
    if (!mismatched) {
      logger.info('[git] using baked repo checkout (warm)', { target, head: bakedHead })
      const setUrl = await execGit(['-C', target, 'remote', 'set-url', 'origin', repoUrl])
      if (setUrl.code !== 0) throw new Error(`git remote set-url failed: ${setUrl.stderr}`)
      if (cfg.branchName && cfg.sessionFresh && !adoption.adopted && cfg.baseSha === bakedHead) {
        await establishBaseRefsFromBakedHead(target, base, bakedHead)
      }
      if (cfg.branchName) await checkoutLocalSessionBranch(target, cfg.branchName)
      await configureRepoGitIdentity(cfg, target)
      if (!adoption.markerMatches) await markSessionCheckoutAdopted(target, cfg.branchName)
      return true
    }
    logger.info('[git] baked checkout requires authoritative materialization', {
      bakedHead,
      baseSha: cfg.baseSha,
      reason: restoreNeeded ? 'restore-session-branch' : 'base-mismatch',
    })
    await clearDirContents(target)
    return false
  }
}
