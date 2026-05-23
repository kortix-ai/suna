import { spawn } from 'node:child_process'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { Config } from './config'
import { logger } from './logger'

type ExecResult = { code: number; stdout: string; stderr: string }

function execGit(args: string[], opts: { cwd?: string } = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: opts.cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
      },
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

/** Build the `-c http.<repo-origin>/.extraheader=...` auth args for git. */
export function buildGitAuthArgs(
  repoUrl: string | undefined,
  token: string | undefined,
): string[] {
  if (!token) return []

  let authOrigin = 'https://github.com'
  if (repoUrl) {
    try {
      const parsed = new URL(repoUrl)
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
        authOrigin = `${parsed.protocol}//${parsed.host}`
      }
    } catch {
      const scpLikeHost = repoUrl.match(/^[^@]+@([^:/]+)[:/]/)?.[1]
      if (scpLikeHost) authOrigin = `https://${scpLikeHost}`
    }
  }

  const headerValue = Buffer.from(`x-access-token:${token}`).toString('base64')
  return ['-c', `http.${authOrigin}/.extraheader=AUTHORIZATION: basic ${headerValue}`]
}

async function gitWithAuth(
  token: string | undefined,
  repoUrl: string | undefined,
  args: string[],
  opts: { cwd?: string } = {},
): Promise<ExecResult> {
  return execGit([...buildGitAuthArgs(repoUrl, token), ...args], opts)
}

async function resolveCloneToken(cfg: Config): Promise<string | undefined> {
  if (!cfg.apiUrl || !cfg.projectId || !cfg.kortixToken) return undefined

  const rawBase = cfg.apiUrl.replace(/\/+$/, '')
  const base = rawBase.endsWith('/v1/router')
    ? rawBase.replace(/\/router$/, '')
    : rawBase.endsWith('/v1')
      ? rawBase
      : `${rawBase}/v1`
  const url = `${base}/projects/${encodeURIComponent(cfg.projectId)}/git/clone-credential`
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${cfg.kortixToken}`,
      Accept: 'application/json',
    },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`failed to fetch git clone credential (${res.status}): ${text || res.statusText}`)
  }
  const body = await res.json().catch(() => null) as
    | { auth?: { token?: string | null } | null }
    | null
  const token = body?.auth?.token?.trim()
  return token || undefined
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

export async function isRepoMaterialized(target: string): Promise<boolean> {
  return pathExists(`${target}/.git`)
}

async function checkoutSessionBranch(
  cfg: Config,
  target: string,
  branch: string,
  token: string | undefined,
): Promise<void> {
  const refSpec = `+refs/heads/${branch}:refs/remotes/origin/${branch}`
  const delayMs = Math.max(1, Math.floor(cfg.branchFetchDelaySec * 1000))
  let lastErr: string | null = null

  for (let attempt = 1; attempt <= cfg.branchFetchAttempts; attempt++) {
    const fetched = await gitWithAuth(token, cfg.repoUrl, [
      '-C',
      target,
      'fetch',
      'origin',
      refSpec,
    ])
    if (fetched.code === 0) {
      const checkout = await gitWithAuth(token, cfg.repoUrl, [
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
  const cloneToken = await resolveCloneToken(cfg)
  await mkdir(dirname(target), { recursive: true })

  if (await pathExists(`${target}/.git`)) {
    logger.info('[git] refreshing existing repo', { target })
    const setUrl = await gitWithAuth(cloneToken, cfg.repoUrl, [
      '-C',
      target,
      'remote',
      'set-url',
      'origin',
      cfg.repoUrl,
    ])
    if (setUrl.code !== 0) throw new Error(`git remote set-url failed: ${setUrl.stderr}`)

    const fetched = await gitWithAuth(cloneToken, cfg.repoUrl, [
      '-C',
      target,
      'fetch',
      '--prune',
      'origin',
      `+refs/heads/${base}:refs/remotes/origin/${base}`,
    ])
    if (fetched.code !== 0) throw new Error(`git fetch (refresh) failed: ${fetched.stderr}`)
  } else {
    const tmpTarget = join(dirname(target), `.kortix-clone-${process.pid}-${Date.now()}`)
    await rm(tmpTarget, { recursive: true, force: true })
    logger.info('[git] cloning repo', { repoUrl: cfg.repoUrl, base, target })
    const cloned = await gitWithAuth(cloneToken, cfg.repoUrl, [
      'clone',
      '--branch',
      base,
      '--single-branch',
      cfg.repoUrl,
      tmpTarget,
    ])
    if (cloned.code !== 0) {
      await rm(tmpTarget, { recursive: true, force: true }).catch(() => {})
      throw new Error(`git clone failed: ${cloned.stderr}`)
    }
    await rm(target, { recursive: true, force: true })
    await rename(tmpTarget, target)
  }

  const fetchBase = await gitWithAuth(cloneToken, cfg.repoUrl, [
    '-C',
    target,
    'fetch',
    'origin',
    base,
  ])
  if (fetchBase.code !== 0) throw new Error(`git fetch base failed: ${fetchBase.stderr}`)

  const reset = await gitWithAuth(cloneToken, cfg.repoUrl, [
    '-C',
    target,
    'reset',
    '--hard',
    `origin/${base}`,
  ])
  if (reset.code !== 0) throw new Error(`git reset --hard failed: ${reset.stderr}`)

  if (cfg.branchName) {
    await checkoutSessionBranch(cfg, target, cfg.branchName, cloneToken)
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

  const cloneToken = await resolveCloneToken(cfg)
  if (cfg.repoUrl) {
    const setUrl = await gitWithAuth(cloneToken, cfg.repoUrl, [
      '-C',
      target,
      'remote',
      'set-url',
      'origin',
      cfg.repoUrl,
    ])
    if (setUrl.code !== 0) throw new Error(`git remote set-url failed: ${setUrl.stderr}`)
  }

  const authRepoUrl = cfg.repoUrl ?? before.remoteUrl ?? undefined
  const branch = cfg.branchName || before.branch || cfg.defaultBranch
  const fetched = await gitWithAuth(cloneToken, authRepoUrl, [
    '-C',
    target,
    'fetch',
    '--prune',
    'origin',
    `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
  ])
  if (fetched.code !== 0) throw new Error(`git fetch refresh failed: ${fetched.stderr}`)

  const pulled = await gitWithAuth(cloneToken, authRepoUrl, [
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
