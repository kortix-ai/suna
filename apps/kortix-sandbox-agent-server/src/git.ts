import { spawn } from 'node:child_process'
import { mkdir, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { Config } from './config'
import { logger } from './logger'

type ExecResult = { code: number; stdout: string; stderr: string }

function execGit(args: string[], opts: { cwd?: string } = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: opts.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (d) => (stdout += d.toString()))
    child.stderr?.on('data', (d) => (stderr += d.toString()))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr }))
  })
}

/** Build the `-c http.https://github.com/.extraheader=...` auth args for git. */
function authArgs(token: string | undefined): string[] {
  if (!token) return []
  const headerValue = Buffer.from(`x-access-token:${token}`).toString('base64')
  return ['-c', `http.https://github.com/.extraheader=AUTHORIZATION: basic ${headerValue}`]
}

async function gitWithAuth(
  token: string | undefined,
  args: string[],
  opts: { cwd?: string } = {},
): Promise<ExecResult> {
  return execGit([...authArgs(token), ...args], opts)
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function checkoutSessionBranch(cfg: Config, target: string, branch: string): Promise<void> {
  const refSpec = `+refs/heads/${branch}:refs/remotes/origin/${branch}`
  const delayMs = Math.max(1, Math.floor(cfg.branchFetchDelaySec * 1000))
  let lastErr: string | null = null

  for (let attempt = 1; attempt <= cfg.branchFetchAttempts; attempt++) {
    const fetched = await gitWithAuth(cfg.githubToken, ['-C', target, 'fetch', 'origin', refSpec])
    if (fetched.code === 0) {
      const checkout = await gitWithAuth(cfg.githubToken, [
        '-C',
        target,
        'checkout',
        '-B',
        branch,
        `refs/remotes/origin/${branch}`,
      ])
      if (checkout.code === 0) {
        logger.info('[git] checked out session branch', { branch })
        return
      }
      lastErr = checkout.stderr
    } else {
      lastErr = fetched.stderr
    }
    await new Promise((r) => setTimeout(r, delayMs))
  }

  throw new Error(
    `failed to fetch session branch ${branch} after ${cfg.branchFetchAttempts} attempts: ${lastErr}`,
  )
}

/**
 * Materialize the project repository into `cfg.projectTarget` at the configured
 * branch. Ported from core/scripts/kortix-daemon clone_project_if_requested.
 */
export async function materializeRepo(cfg: Config): Promise<void> {
  if (!cfg.repoUrl) {
    throw new Error('KORTIX_PROJECT_AUTO_CLONE is enabled but KORTIX_REPO_URL is unset')
  }

  const target = cfg.projectTarget
  const base = cfg.defaultBranch
  await mkdir(dirname(target), { recursive: true })

  if (await pathExists(`${target}/.git`)) {
    logger.info('[git] refreshing existing repo', { target })
    const setUrl = await gitWithAuth(cfg.githubToken, [
      '-C',
      target,
      'remote',
      'set-url',
      'origin',
      cfg.repoUrl,
    ])
    if (setUrl.code !== 0) throw new Error(`git remote set-url failed: ${setUrl.stderr}`)

    const fetched = await gitWithAuth(cfg.githubToken, [
      '-C',
      target,
      'fetch',
      '--prune',
      'origin',
      `+refs/heads/${base}:refs/remotes/origin/${base}`,
    ])
    if (fetched.code !== 0) throw new Error(`git fetch (refresh) failed: ${fetched.stderr}`)
  } else {
    if (await pathExists(target)) await rm(target, { recursive: true, force: true })
    logger.info('[git] cloning repo', { repoUrl: cfg.repoUrl, base, target })
    const cloned = await gitWithAuth(cfg.githubToken, [
      'clone',
      '--branch',
      base,
      '--single-branch',
      cfg.repoUrl,
      target,
    ])
    if (cloned.code !== 0) throw new Error(`git clone failed: ${cloned.stderr}`)
  }

  const fetchBase = await gitWithAuth(cfg.githubToken, ['-C', target, 'fetch', 'origin', base])
  if (fetchBase.code !== 0) throw new Error(`git fetch base failed: ${fetchBase.stderr}`)

  const reset = await gitWithAuth(cfg.githubToken, [
    '-C',
    target,
    'reset',
    '--hard',
    `origin/${base}`,
  ])
  if (reset.code !== 0) throw new Error(`git reset --hard failed: ${reset.stderr}`)

  if (cfg.branchName) {
    await checkoutSessionBranch(cfg, target, cfg.branchName)
  }
}

export type RepoInfo = {
  path: string
  branch: string | null
  commit: string | null
  remoteUrl: string | null
}

export async function readRepoInfo(target: string): Promise<RepoInfo | null> {
  if (!(await pathExists(`${target}/.git`))) return null
  const branch = await execGit(['-C', target, 'rev-parse', '--abbrev-ref', 'HEAD'])
  const commit = await execGit(['-C', target, 'rev-parse', 'HEAD'])
  const remote = await execGit(['-C', target, 'remote', 'get-url', 'origin'])
  return {
    path: target,
    branch: branch.code === 0 ? branch.stdout.trim() : null,
    commit: commit.code === 0 ? commit.stdout.trim() : null,
    remoteUrl: remote.code === 0 ? remote.stdout.trim() : null,
  }
}

export async function refreshRepo(cfg: Config): Promise<{ before: RepoInfo; after: RepoInfo }> {
  const target = cfg.projectTarget
  const before = await readRepoInfo(target)
  if (!before) {
    throw new Error('project repo is not materialized')
  }

  if (cfg.repoUrl) {
    const setUrl = await gitWithAuth(cfg.githubToken, [
      '-C',
      target,
      'remote',
      'set-url',
      'origin',
      cfg.repoUrl,
    ])
    if (setUrl.code !== 0) throw new Error(`git remote set-url failed: ${setUrl.stderr}`)
  }

  const branch = cfg.branchName || before.branch || cfg.defaultBranch
  const fetched = await gitWithAuth(cfg.githubToken, [
    '-C',
    target,
    'fetch',
    '--prune',
    'origin',
    `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
  ])
  if (fetched.code !== 0) throw new Error(`git fetch refresh failed: ${fetched.stderr}`)

  const pulled = await gitWithAuth(cfg.githubToken, [
    '-C',
    target,
    'pull',
    '--ff-only',
    'origin',
    branch,
  ])
  if (pulled.code !== 0) throw new Error(`git pull refresh failed: ${pulled.stderr}`)

  const after = await readRepoInfo(target)
  if (!after) throw new Error('project repo disappeared after refresh')

  return { before, after }
}
