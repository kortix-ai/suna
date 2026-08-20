import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import type { Config } from './config'
import { logger } from './logger'

type ExecResult = { code: number; stdout: string; stderr: string }
type GitIdentityConfig = Pick<Config, 'gitUserName' | 'gitUserEmail'>

function execGit(
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: opts.cwd,
      env: {
        ...process.env,
        ...opts.env,
        GIT_TERMINAL_PROMPT: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    // Hard wall-clock ceiling per invocation. http.lowSpeed aborts a stalled
    // TRANSFER, but a hang during connect/TLS (before any bytes) wouldn't trip
    // it — without this a single `git clone` could block forever and wedge the
    // whole materialize. On timeout we SIGKILL and surface a transient-looking
    // error so the caller's retry loop picks it up.
    let timer: ReturnType<typeof setTimeout> | undefined
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        stderr += `\n[execGit] killed: exceeded ${opts.timeoutMs}ms (Connection timed out)`
        child.kill('SIGKILL')
      }, opts.timeoutMs)
    }
    child.stdout?.on('data', (d) => (stdout += d.toString()))
    child.stderr?.on('data', (d) => (stderr += d.toString()))
    child.on('error', (e) => { if (timer) clearTimeout(timer); reject(e) })
    child.on('close', (code) => { if (timer) clearTimeout(timer); resolve({ code: code ?? 0, stdout, stderr }) })
  })
}

/**
 * Run a git command for the file API (list `ignored`, status). Like execGit but
 * exported, with optional stdin (for `git check-ignore --stdin`) and a sane
 * default timeout. Never throws on non-zero exit — returns the result so callers
 * can treat "not a git repo" / no-match as empty rather than an error.
 */
export function runGit(
  args: string[],
  opts: { cwd?: string; input?: string; timeoutMs?: number } = {},
): Promise<ExecResult> {
  const timeoutMs = opts.timeoutMs ?? 10_000
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: opts.cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      stdio: [opts.input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timer: ReturnType<typeof setTimeout> | undefined
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        stderr += `\n[runGit] killed: exceeded ${timeoutMs}ms`
        child.kill('SIGKILL')
      }, timeoutMs)
    }
    child.stdout?.on('data', (d) => (stdout += d.toString()))
    child.stderr?.on('data', (d) => (stderr += d.toString()))
    child.on('error', (e) => { if (timer) clearTimeout(timer); reject(e) })
    child.on('close', (code) => { if (timer) clearTimeout(timer); resolve({ code: code ?? 0, stdout, stderr }) })
    if (opts.input !== undefined) {
      child.stdin?.end(opts.input)
    }
  })
}

export function buildGitIdentityEnv(cfg: GitIdentityConfig): NodeJS.ProcessEnv {
  return {
    GIT_AUTHOR_NAME: cfg.gitUserName,
    GIT_AUTHOR_EMAIL: cfg.gitUserEmail,
    GIT_COMMITTER_NAME: cfg.gitUserName,
    GIT_COMMITTER_EMAIL: cfg.gitUserEmail,
  }
}

async function configureGitValue(
  prefixArgs: string[],
  configArgs: string[],
  key: string,
  value: string,
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<void> {
  const current = await execGit([...prefixArgs, 'config', ...configArgs, '--get', key], opts)
  if (current.code === 0 && current.stdout.trim()) return

  const set = await execGit([...prefixArgs, 'config', ...configArgs, key, value], opts)
  if (set.code !== 0) {
    throw new Error(`git config ${key} failed: ${set.stderr || set.stdout}`)
  }
}

export async function configureGlobalGitIdentity(
  cfg: GitIdentityConfig,
  home: string,
): Promise<void> {
  await mkdir(home, { recursive: true })
  const env = { HOME: home }
  await configureGitValue([], ['--global'], 'user.name', cfg.gitUserName, { env })
  await configureGitValue([], ['--global'], 'user.email', cfg.gitUserEmail, { env })
  logger.info('[git] configured default global identity', { home, name: cfg.gitUserName, email: cfg.gitUserEmail })
}

/**
 * Per-(target,identity) memo so repeated boots (or test runs) skip the
 * redundant `git config` subprocess spawns. Keying on the resolved values
 * means a config change invalidates the memo automatically.
 */
const repoIdentityMemo = new Map<string, string>()

async function configureRepoGitIdentity(cfg: GitIdentityConfig, target: string): Promise<void> {
  const key = `${target}\0${cfg.gitUserName}\0${cfg.gitUserEmail}`
  if (repoIdentityMemo.get(target) === key) return
  // Git refuses concurrent writes to the same .git/config (lockfile), so the
  // two values run serially. The wins here are (a) the memo, which skips both
  // on a repeat boot, and (b) running them in `--local` not via the slower
  // `--global` path.
  await configureGitValue(['-C', target], ['--local'], 'user.name', cfg.gitUserName)
  await configureGitValue(['-C', target], ['--local'], 'user.email', cfg.gitUserEmail)
  repoIdentityMemo.set(target, key)
  logger.info('[git] configured default repo identity', { target, name: cfg.gitUserName, email: cfg.gitUserEmail })
}

/** Test-only: drop the memo so tests can verify the config calls fire. */
export function __clearRepoIdentityMemoForTests(): void {
  repoIdentityMemo.clear()
}

async function configureSafeDirectory(target: string): Promise<void> {
  const current = await execGit(['config', '--global', '--get-all', 'safe.directory'])
  if (current.code === 0) {
    const entries = current.stdout.split('\n').map((line) => line.trim()).filter(Boolean)
    if (entries.includes(target) || entries.includes('*')) return
  }

  const set = await execGit(['config', '--global', '--add', 'safe.directory', target])
  if (set.code !== 0) {
    throw new Error(`git config safe.directory failed: ${set.stderr || set.stdout}`)
  }
  logger.info('[git] configured safe git directory', { target })
}

/** Build the `-c http.<repo-origin>/.extraheader=...` auth args for git. */
export function buildGitAuthArgs(
  repoUrl: string | undefined,
  token: string | undefined,
  username = 'x-access-token',
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

  const headerValue = Buffer.from(`${username}:${token}`).toString('base64')
  const header = `AUTHORIZATION: basic ${headerValue}`
  const args = ['-c', `http.${authOrigin}/.extraheader=${header}`]

  // The Kortix git proxy is the sandbox's own control-plane URL. During the
  // initial clone we do not rely on HOME-scoped credential helper config, so
  // add a one-command fallback header that git applies to the proxy request.
  // This is intentionally limited to /v1/git URLs: direct upstream clones keep
  // the host-scoped header only.
  if (repoUrl && /\/v1\/git\//.test(repoUrl)) {
    args.push('-c', `http.extraheader=${header}`)
  }
  return args
}

interface CloneCredential {
  username: string
  token: string
}

async function gitWithAuth(
  credential: CloneCredential | undefined,
  repoUrl: string | undefined,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<ExecResult> {
  return execGit([
    ...buildGitAuthArgs(repoUrl, credential?.token, credential?.username),
    ...args,
  ], opts)
}

const CLONE_CRED_TIMEOUT_MS = 15_000
const CLONE_CRED_ATTEMPTS = 4

/**
 * Per-process cache for the clone-credential round-trip. `materializeRepo`
 * calls `resolveCloneCredential` twice (base clone + branch checkout) on the cold
 * path; the API token doesn't change within a single boot, so caching it
 * avoids a second control-plane round-trip over the public internet.
 * Memoize on the input shape (api+project+token) so re-keying invalidates.
 */
let cachedCloneToken: { key: string; value: CloneCredential | undefined } | null = null

/** Test-only: drop the cached clone token so a fresh fetch happens next call. */
export function __clearCloneTokenCacheForTests(): void {
  cachedCloneToken = null
}

async function resolveCloneCredential(cfg: Config): Promise<CloneCredential | undefined> {
  if (!cfg.apiUrl || !cfg.projectId || !cfg.sandboxToken) return undefined
  // Universal proxy origin: when the repo is served by the Kortix git proxy
  // (KORTIX_REPO_URL = `${KORTIX_URL}/v1/git/<projectId>.git`), the git
  // credential IS our own KORTIX_TOKEN — the proxy authenticates it and resolves
  // the real upstream + host credential server-side. No clone-credential round
  // trip, and a real GitHub token never enters the sandbox.
  if (cfg.repoUrl && /\/v1\/git\//.test(cfg.repoUrl)) {
    return { username: 'x-access-token', token: cfg.sandboxToken }
  }
  const cacheKey = `${cfg.apiUrl}\0${cfg.projectId}\0${cfg.sandboxToken}`
  if (cachedCloneToken?.key === cacheKey) return cachedCloneToken.value

  const rawBase = cfg.apiUrl.replace(/\/+$/, '')
  const base = rawBase.endsWith('/v1/router')
    ? rawBase.replace(/\/router$/, '')
    : rawBase.endsWith('/v1')
      ? rawBase
      : `${rawBase}/v1`
  const url = `${base}/projects/${encodeURIComponent(cfg.projectId)}/git/clone-credential`

  // The control plane is reached over the public internet (KORTIX_API_URL).
  // A bare fetch with no timeout/retry turns one transient blip — or a
  // misconfigured (e.g. loopback) callback URL — into a permanent boot failure
  // surfaced as the opaque Bun error "Unable to connect. Is the computer able to
  // access the url?". Retry transient failures, time-box each attempt, and on
  // exhaustion throw an error that names the URL so /kortix/health explains the
  // real problem instead of leaking that string verbatim.
  let lastErr: unknown
  for (let attempt = 1; attempt <= CLONE_CRED_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${cfg.sandboxToken}`,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(CLONE_CRED_TIMEOUT_MS),
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        // 4xx (bad token / not found) won't fix itself — fail immediately.
        if (res.status >= 400 && res.status < 500) {
          throw new Error(`failed to fetch git clone credential (${res.status}): ${text || res.statusText}`)
        }
        // 5xx is potentially transient — retry.
        throw new Error(`clone-credential ${res.status}: ${text || res.statusText}`)
      }
      const body = await res.json().catch(() => null) as
        | { auth?: { username?: string | null; token?: string | null } | null }
        | null
      const token = body?.auth?.token?.trim()
      const username = body?.auth?.username?.trim() || 'x-access-token'
      const value = token ? { username, token } : undefined
      cachedCloneToken = { key: cacheKey, value }
      return value
    } catch (err) {
      lastErr = err
      const is4xx = err instanceof Error && /\((4\d\d)\)/.test(err.message)
      if (is4xx || attempt === CLONE_CRED_ATTEMPTS) break
      logger.warn('[git] clone-credential fetch failed; retrying', {
        attempt,
        of: CLONE_CRED_ATTEMPTS,
        url: base,
        err: err instanceof Error ? err.message : String(err),
      })
      await new Promise((r) => setTimeout(r, 500 * attempt))
    }
  }

  const detail = lastErr instanceof Error ? lastErr.message : String(lastErr)
  if (lastErr instanceof Error && /\((4\d\d)\)/.test(lastErr.message)) {
    throw lastErr
  }
  throw new Error(
    `could not reach the Kortix control plane at ${base} to fetch the git clone ` +
    `credential after ${CLONE_CRED_ATTEMPTS} attempts — is KORTIX_API_URL publicly ` +
    `reachable from this sandbox? (${detail})`,
  )
}

/**
 * Configure git so that *any* push/fetch the agent runs against the project's
 * managed remote authenticates with zero setup — the same credential the
 * daemon mints for itself at clone time.
 *
 * Mechanism: a git credential helper pointed back at this very binary
 * (`kortix-agent git-credential`). When git needs a credential for the repo
 * host it execs the helper, which fetches a fresh push-capable token from the
 * control plane (`/git/clone-credential`) and hands git
 * `username=x-access-token` + `password=<token>`. Fetching on demand (rather
 * than baking a token into `.git/config`) means a long-running session never
 * pushes with a stale token — the exact failure mode that left an agent unable
 * to `git push origin HEAD`.
 *
 * Scoped to the repo's origin host so it never fires for unrelated hosts.
 */
function deriveAuthHost(repoUrl: string): string | null {
  try {
    const parsed = new URL(repoUrl)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
    return `${parsed.protocol}//${parsed.host}`
  } catch {
    return null
  }
}

// The compiled daemon binary is its own credential helper. In dev (`bun run
// src/main.ts`) execPath is `bun`, which can't re-dispatch the subcommand — but
// credential help is only needed in the real sandbox, where execPath is the
// baked /usr/local/bin/kortix-agent.
function credentialHelperSpec(): string {
  return `!'${process.execPath}' git-credential`
}

export async function configureGitCredentialHelper(
  cfg: Config,
  home: string,
): Promise<void> {
  if (!cfg.repoUrl || !cfg.projectId || !cfg.sandboxToken) return
  const host = deriveAuthHost(cfg.repoUrl)
  if (!host) return
  const username = (await resolveCloneCredential(cfg).catch(() => undefined))?.username
    ?? 'x-access-token'

  const env = { HOME: home }
  // `--replace-all` keeps re-boots idempotent instead of appending duplicate
  // helper lines (which git would chain, slowing every credential lookup).
  const setHelper = await execGit(
    ['config', '--global', '--replace-all', `credential.${host}.helper`, credentialHelperSpec()],
    { env },
  )
  if (setHelper.code !== 0) {
    logger.warn('[git] failed to configure credential helper', {
      host,
      stderr: setHelper.stderr.slice(0, 200),
    })
    return
  }
  // Pin the username so git doesn't prompt for it when the remote URL carries
  // no userinfo (GitHub expects the literal `x-access-token`).
  await execGit(
    ['config', '--global', '--replace-all', `credential.${host}.username`, username],
    { env },
  )
  logger.info('[git] configured managed credential helper (global)', { host })
}

/**
 * Configure the SAME credential helper at the repo level (`--local`). The
 * global config only fires when git runs with HOME=<opencode home>; a shell
 * with a different HOME (e.g. a root `bash` tool call defaulting to /root) would
 * miss it and `git push` would fall back to a username prompt and fail.
 * Repo-local config lives in `<repo>/.git/config` and is HOME-independent, so
 * `git -C <repo> push` authenticates no matter who/where invokes it. Must run
 * after the repo is materialized.
 */
export async function configureRepoCredentialHelper(cfg: Config, target: string): Promise<void> {
  if (!cfg.repoUrl || !cfg.projectId || !cfg.sandboxToken) return
  if (!(await pathExists(`${target}/.git`))) return
  const host = deriveAuthHost(cfg.repoUrl)
  if (!host) return
  const username = (await resolveCloneCredential(cfg).catch(() => undefined))?.username
    ?? 'x-access-token'

  const setHelper = await execGit(
    ['-C', target, 'config', '--local', '--replace-all', `credential.${host}.helper`, credentialHelperSpec()],
  )
  if (setHelper.code !== 0) {
    logger.warn('[git] failed to configure repo-local credential helper', {
      host,
      stderr: setHelper.stderr.slice(0, 200),
    })
    return
  }
  await execGit(
    ['-C', target, 'config', '--local', '--replace-all', `credential.${host}.username`, username],
  )
  logger.info('[git] configured managed credential helper (repo-local)', { host, target })
}

/**
 * Git credential-helper entrypoint (`kortix-agent git-credential <action>`).
 * Implements the read side of git's credential protocol: on `get` it resolves
 * a fresh push/clone token and writes `username`/`password` to stdout. Every
 * other action (`store`, `erase`) is a no-op — the control plane owns the
 * credential, there's nothing local to persist or forget.
 */
export async function runGitCredentialHelper(
  cfg: Config,
  action: string | undefined,
): Promise<number> {
  if (action !== 'get') return 0
  // Drain stdin (git feeds protocol=…\nhost=…\n). We don't need the contents —
  // the token is project-scoped, not host-derived — but we must consume it so
  // git's write side doesn't block on a full pipe.
  await readAllStdin().catch(() => '')

  const output = await resolveGitCredentialOutput(cfg)
  if (output) process.stdout.write(output)
  return 0
}

/**
 * Core of the credential helper, split out so it's testable without touching
 * process stdin/stdout: resolve a push/clone token and format git's expected
 * `username`/`password` reply. Returns null when no credential is available
 * (git then falls back to its other helpers / prompts).
 */
export async function resolveGitCredentialOutput(cfg: Config): Promise<string | null> {
  let credential: CloneCredential | undefined
  try {
    credential = await resolveCloneCredential(cfg)
  } catch (err) {
    logger.warn('[git] credential helper could not resolve token', {
      err: err instanceof Error ? err.message : String(err),
    })
    return null
  }
  if (!credential) return null
  return `username=${credential.username}\npassword=${credential.token}\n`
}

function readAllStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = ''
    const stdin = process.stdin
    if (stdin.isTTY) {
      resolve('')
      return
    }
    stdin.setEncoding('utf8')
    stdin.on('data', (chunk) => (data += chunk))
    stdin.on('end', () => resolve(data))
    stdin.on('error', () => resolve(data))
    // Guard against a helper invoked with no stdin attached.
    stdin.on('close', () => resolve(data))
  })
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

async function checkoutSessionBranch(
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
  // this fetch with no reset. On failure/timeout we fall through to a local
  // branch from the base checkout (below), so the session still boots.
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
    logger.warn('[git] remote session branch checkout failed; creating local branch', {
      branch,
      stderr: checkout.stderr.slice(0, 300),
    })
  } else {
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

async function checkoutLocalSessionBranch(target: string, branch: string): Promise<void> {
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

/**
 * Boot-local fallback for an empty/branchless upstream (a managed repo that was
 * provisioned but never seeded). Instead of failing the whole session on
 * "Remote branch <base> not found in upstream origin", lay down a fresh local
 * repo at `base` with one empty commit, so the session branch has a base to
 * fork from and OpenCode boots normally. The agent then populates the tree, and
 * the background remote-branch publish (createRemoteSessionBranch) / first push
 * seeds the upstream for real. A cold sandbox now boots exactly like a warm/
 * baked one — entirely from local git, never blocked on the remote.
 *
 * `dir` is the tmp clone target; the caller renames it into place afterwards.
 */
async function initLocalRepoAtBase(cfg: Config, dir: string, base: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => {})
  await mkdir(dir, { recursive: true })
  const init = await execGit(['-C', dir, 'init'])
  if (init.code !== 0) throw new Error(`git init (empty upstream) failed: ${init.stderr}`)
  // Rename the unborn branch to `base` — version-robust vs `git init -b`, which
  // needs git ≥ 2.28.
  const branch = await execGit(['-C', dir, 'checkout', '-b', base])
  if (branch.code !== 0) throw new Error(`git checkout -b ${base} (empty upstream) failed: ${branch.stderr}`)
  if (cfg.repoUrl) {
    const addRemote = await execGit(['-C', dir, 'remote', 'add', 'origin', cfg.repoUrl])
    if (addRemote.code !== 0) throw new Error(`git remote add origin (empty upstream) failed: ${addRemote.stderr}`)
  }
  const commit = await execGit(
    ['-C', dir, 'commit', '--allow-empty', '-m', 'chore: initialize Kortix project'],
    { env: buildGitIdentityEnv(cfg) },
  )
  if (commit.code !== 0) throw new Error(`git initial commit (empty upstream) failed: ${commit.stderr}`)
  logger.info('[git] initialized fresh local repo at base (empty upstream)', { base, dir })
}

/**
 * The workspace's PARENT directory is not writable by the daemon: /workspace
 * sits directly under the root-owned `/` and the daemon runs as the
 * unprivileged runtime user. Materialization therefore must never create a
 * sibling of `target` or replace the `target` directory node itself (both
 * `rename(tmp, target)` and `rm(target)` mutate dirents in the parent). All
 * staging happens INSIDE `target`, and a finished stage is swapped in by
 * replacing target's CONTENTS — same-filesystem renames that only need write
 * access to `target`, which the runtime user owns.
 */
async function createStagePath(target: string, kind: string): Promise<string> {
  await mkdir(target, { recursive: true })
  return join(target, `.kortix-${kind}-${process.pid}-${Date.now()}`)
}

async function clearDirContents(dir: string, keep?: string): Promise<void> {
  for (const entry of await readdir(dir)) {
    if (entry === keep) continue
    await rm(join(dir, entry), { recursive: true, force: true })
  }
}

/** Crash-safe enough for boot: a failure mid-swap leaves a `.kortix-*` stage
 *  dir that the next attempt's clearDirContents/createStagePath cycle wipes. */
async function swapStageIntoTarget(stage: string, target: string): Promise<void> {
  await clearDirContents(target, basename(stage))
  for (const entry of await readdir(stage)) {
    await rename(join(stage, entry), join(target, entry))
  }
  await rm(stage, { recursive: true, force: true })
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
  await mkdir(target, { recursive: true })

  if (await pathExists(`${target}/.git`)) {
    await configureSafeDirectory(target)
    // The warm seed bakes the canonical SCAFFOLD at /workspace so opencode is
    // already project-initialized in the snapshot. A fork may reuse it ONLY when
    // the baked content IS this session's base — i.e. a fresh scaffold-rooted
    // project (baked HEAD == the server-resolved KORTIX_BASE_SHA). When it isn't
    // (an imported repo / diverged project), the baked scaffold is the WRONG
    // content: discard it and re-materialize the real repo below. Restart/resume
    // (no baseSha) keep the old "reuse whatever's baked" behaviour unchanged.
    const bakedHead = (await execGit(['-C', target, 'rev-parse', 'HEAD'])).stdout.trim()
    const mismatched = cfg.sessionFresh && !!cfg.baseSha && bakedHead !== cfg.baseSha
    if (!mismatched) {
      logger.info('[git] using baked repo checkout (warm)', { target, head: bakedHead })
      const setUrl = await execGit(['-C', target, 'remote', 'set-url', 'origin', cfg.repoUrl])
      if (setUrl.code !== 0) throw new Error(`git remote set-url failed: ${setUrl.stderr}`)
      if (cfg.branchName) await checkoutLocalSessionBranch(target, cfg.branchName)
      await configureRepoGitIdentity(cfg, target)
      return
    }
    logger.info('[git] baked checkout != session base; re-materializing real repo', { bakedHead, baseSha: cfg.baseSha })
    await clearDirContents(target)
  }
  {
    // Scaffold fast path: the image bakes the canonical starter repo at
    // /opt/kortix/scaffold.git whose root commit is SHARED with every project
    // seeded from the starter (deterministic root — comp git-backends/seed.ts).
    // A local clone is ~50ms and the follow-up fetch transfers only the
    // project's delta beyond that shared root (a fresh project = ~one tiny
    // commit) instead of the whole repo over the slow git path (9s through the
    // dev tunnel, 2026-06-13). Imported repos / other starters share no
    // ancestor → the fetch degrades to a full pack (same as a clone); ANY
    // failure falls through to the battle-tested clone path below.
    if (await tryScaffoldDeltaFetch(cfg, target, base)) {
      if (cfg.branchName) {
        // Fresh session → branch == base, create it LOCALLY (zero network).
        // Restart/resume → the remote branch may carry the agent's commits.
        if (cfg.sessionFresh) await checkoutLocalSessionBranch(target, cfg.branchName)
        else {
          await checkoutSessionBranch(
            cfg,
            target,
            cfg.branchName,
            await resolveCloneCredential(cfg),
          )
        }
      }
      await configureRepoGitIdentity(cfg, target)
      return
    }
    const cloneCredential = await resolveCloneCredential(cfg)
    const tmpTarget = await createStagePath(target, 'clone')
    await rm(tmpTarget, { recursive: true, force: true })
    logger.info('[git] cloning repo', {
      repoUrl: cfg.repoUrl,
      base,
      target,
      depth: cfg.cloneDepth || 'full',
      filter: cfg.cloneFilter || 'none',
    })
    // Two failure modes on a restored microVM whose virtio-net RX intermittently
    // stalls during a large sustained transfer (worse when many sandboxes clone
    // at once):
    //   (a) the pack stream is RESET mid-flight → git exits non-zero with
    //       "early EOF" / "RPC failed" / "Connection reset" / "fetch-pack:
    //       unexpected disconnect" / "index-pack".
    //   (b) the stream STALLS with no reset → git has NO transfer timeout by
    //       default, so `git clone` blocks FOREVER (repo_ready never flips →
    //       the API's 75s runtime-ready timeout). This is the nastier one.
    // Fix BOTH: http.lowSpeedLimit/Time aborts a stalled transfer (<1 KB/s for
    // 12 s) so a hang becomes a fast failure, then we retry with jittered
    // backoff (jitter de-clusters concurrent retries so they don't re-stampede).
    // 4 attempts × (≤12 s stall-abort + backoff) stays well under the 75 s ceiling
    // while a transient blip clears in 1–2 retries. resolveCloneCredential already
    // retries the credential fetch; the clone itself needs it just as much.
    // `--depth` is the single biggest boot-latency lever: history is ~95% of the
    // transfer and 0% of what a fresh session's working tree needs. See
    // KORTIX_CLONE_DEPTH in config.ts for the measurements. A remote that can't
    // serve shallow degrades to a full clone on its own (the retry loop below
    // treats that like any other clone failure and retries unfiltered).
    const depthArgs = cfg.cloneDepth > 0 ? ['--depth', String(cfg.cloneDepth)] : []
    const baseCloneArgs = [
      '-c', 'http.lowSpeedLimit=1000', '-c', 'http.lowSpeedTime=12',
      'clone', '--branch', base, '--single-branch', ...depthArgs,
    ]
    const isTransientGit = (s: string) =>
      /early EOF|RPC failed|Connection reset|Recv failure|fetch-pack|unexpected disconnect|index-pack|Could not resolve host|Connection timed out|timed out|GnuTLS recv|SSL_read|TLS packet|Failed to connect|Empty reply|Operation too slow|transfer closed|server hung up|remote end hung up|Stream closed|HTTP 5/i.test(s)
    // The upstream has no base branch yet — a freshly provisioned managed repo
    // that was never seeded, or any empty repo. This is NOT a retryable failure:
    // cloning it 4× more just fails 4× identically. We boot from a fresh local
    // repo instead (see initLocalRepoAtBase below), so a cold sandbox starts
    // exactly like a warm/baked one — 100% from local git, never blocked on the
    // remote having `main`.
    const isEmptyUpstream = (s: string) =>
      /Remote branch .+ not found in upstream|Could not find remote branch|You appear to have cloned an empty repository|remote HEAD refers to nonexistent ref/i.test(s)
    const MAX_CLONE_ATTEMPTS = 4
    let cloned = { code: -1, stdout: '', stderr: '' } as Awaited<ReturnType<typeof gitWithAuth>>
    for (let attempt = 1; attempt <= MAX_CLONE_ATTEMPTS; attempt++) {
      await rm(tmpTarget, { recursive: true, force: true }).catch(() => {})
      // Blobless partial clone keeps full history but defers file blobs, cutting
      // the boot-time transfer from a full-history pack to roughly the working
      // tree. This is the dominant per-session boot cost on large repos.
      cloned = await gitWithAuth(cloneCredential, cfg.repoUrl, [
        ...baseCloneArgs,
        ...(cfg.cloneFilter ? [`--filter=${cfg.cloneFilter}`] : []),
        cfg.repoUrl,
        tmpTarget,
      ], { timeoutMs: 35_000 })
      if (cloned.code !== 0 && cfg.cloneFilter && !isTransientGit(cloned.stderr) && !isEmptyUpstream(cloned.stderr)) {
        // Remote may not advertise uploadpack.allowFilter — fall back to a full
        // clone so a non-supporting host still boots (just slower). Skip this for
        // an empty upstream: a full clone would fail identically (no base branch).
        logger.warn('[git] partial clone failed; retrying as a full clone', {
          stderr: cloned.stderr.slice(0, 200),
        })
        await rm(tmpTarget, { recursive: true, force: true }).catch(() => {})
        cloned = await gitWithAuth(cloneCredential, cfg.repoUrl, [...baseCloneArgs, cfg.repoUrl, tmpTarget], { timeoutMs: 35_000 })
      }
      if (cloned.code === 0) break
      // Empty upstream is terminal-but-fine: stop retrying and init locally below.
      if (isEmptyUpstream(cloned.stderr)) break
      const transient = isTransientGit(cloned.stderr)
      logger.warn('[git] clone attempt failed', { attempt, maxAttempts: MAX_CLONE_ATTEMPTS, transient, stderr: cloned.stderr.slice(0, 200) })
      if (!transient || attempt === MAX_CLONE_ATTEMPTS) break
      // Jittered backoff: base grows per attempt, jitter spreads concurrent retries.
      await new Promise((r) => setTimeout(r, 500 * attempt + Math.floor(Math.random() * 700)))
    }
    if (cloned.code !== 0) {
      if (isEmptyUpstream(cloned.stderr)) {
        // No base branch upstream → boot from a fresh local repo instead of
        // hard-failing the whole session. The agent's work + the background
        // remote-branch publish seed the upstream for real later.
        logger.warn('[git] base branch missing upstream (empty repo) — booting from a fresh local repo', {
          base,
          stderr: cloned.stderr.slice(0, 200),
        })
        await initLocalRepoAtBase(cfg, tmpTarget, base)
      } else {
        await rm(tmpTarget, { recursive: true, force: true }).catch(() => {})
        throw new Error(`git clone failed after ${MAX_CLONE_ATTEMPTS} attempt(s): ${cloned.stderr}`)
      }
    }
    await swapStageIntoTarget(tmpTarget, target)
    // Fresh clone already left the working tree on `base` at tip — the old
    // extra `git fetch origin base` + `git reset --hard` here was a redundant
    // network round-trip on the per-session boot hot path. Removed.
  }

  if (cfg.branchName) {
    if (cfg.sessionFresh) {
      // Fresh session → branch == freshly-cloned base; local, no extra fetch.
      await checkoutLocalSessionBranch(target, cfg.branchName)
    } else {
      // resolveCloneCredential is memoized — this second call is now ~free.
      const cloneCredential = await resolveCloneCredential(cfg)
      await checkoutSessionBranch(cfg, target, cfg.branchName, cloneCredential)
    }
  }

  await configureRepoGitIdentity(cfg, target)
}

/**
 * Restore full history AFTER boot, off the critical path.
 *
 * The boot clone is shallow (`--depth 1`) because history is ~95% of the
 * transfer and none of what a fresh working tree needs — but an agent that runs
 * `git log`, `git blame`, or `git diff <base>` later does need it. This fetches
 * the rest in the background once the session is already usable, so the shallow
 * clone is invisible to everything downstream.
 *
 * Deliberately fire-and-forget and fully best-effort: a session whose backfill
 * fails is still a working session (shallow), and blocking boot on it would
 * reintroduce the cost we just removed. Idempotent — a repo that is already
 * complete is skipped.
 */
export function scheduleHistoryBackfill(cfg: Config, target: string): void {
  void (async () => {
    try {
      if (!(await isShallowRepo(target))) return
      const started = Date.now()
      const credential = await resolveCloneCredential(cfg)
      const res = await gitWithAuth(credential, cfg.repoUrl, [
        '-c', 'http.lowSpeedLimit=1000', '-c', 'http.lowSpeedTime=12',
        '-C', target, 'fetch', '--unshallow', '--tags', 'origin',
      ], { timeoutMs: 300_000 })
      if (res.code !== 0) {
        logger.warn('[git] history backfill failed; repo stays shallow', {
          stderr: res.stderr.slice(0, 200),
        })
        return
      }
      logger.info('[git] history backfill complete', { ms: Date.now() - started })
    } catch (err) {
      logger.warn('[git] history backfill errored; repo stays shallow', {
        err: err instanceof Error ? err.message : String(err),
      })
    }
  })()
}

const DEFAULT_SCAFFOLD_REPO_PATH = '/opt/kortix/scaffold.git'
let scaffoldRepoPath = DEFAULT_SCAFFOLD_REPO_PATH

export function __setScaffoldRepoPathForTests(path?: string): void {
  scaffoldRepoPath = path ?? DEFAULT_SCAFFOLD_REPO_PATH
}

/**
 * Seed-only: materialize the image-baked scaffold at `target` with ZERO network,
 * for the warm-snapshot builder. The seed has no project repo — it clones the
 * canonical scaffold so opencode can pay its per-directory project init (git
 * scan / file index / LSP / sqlite) ONCE, frozen into the snapshot. Every fresh
 * session shares the scaffold root, so a fork resumes with opencode already
 * 'ok' for /workspace (kills the runtime-ready wall). Returns true on success;
 * false (no scaffold baked) → caller leaves /workspace empty (degrades to the
 * old behaviour, never breaks). `base` is checked out as a local branch so the
 * working tree matches what a fresh session expects.
 */
export async function materializeScaffoldSeed(target: string, base: string): Promise<boolean> {
  if (!existsSync(scaffoldRepoPath)) return false
  const tmp = await createStagePath(target, 'seed')
  const t0 = Date.now()
  try {
    await rm(tmp, { recursive: true, force: true })
    const cloned = await execGit(['clone', '-q', scaffoldRepoPath, tmp])
    if (cloned.code !== 0) throw new Error(`seed scaffold clone: ${cloned.stderr}`)
    const co = await execGit(['-C', tmp, 'checkout', '-q', '-B', base, 'HEAD'])
    if (co.code !== 0) throw new Error(`seed checkout base: ${co.stderr}`)
    await swapStageIntoTarget(tmp, target)
    logger.info('[git] seed scaffold materialized (zero-network)', { ms: Date.now() - t0, base })
    return true
  } catch (err) {
    logger.warn('[git] seed scaffold materialize failed; warm seed will boot repo-less', {
      err: err instanceof Error ? err.message.slice(0, 200) : String(err),
    })
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
    return false
  }
}

/**
 * Clone the PROJECT repo at base tip for a per-project warm seed (Platinum
 * stateful capture). Unlike materializeScaffoldSeed (the
 * repo-LESS generic scaffold), this clones the real project at base into
 * /workspace so the captured snapshot already has the repo — a fork then hits
 * materializeRepo's "using baked repo checkout (warm)" fast path (no in-box
 * clone). Leaves /workspace on `base` tip with NO session branch (none exists
 * during seed capture). Wipes any image-baked /workspace first so a scaffold is never mistaken
 * for the seed. Returns false (→ caller degrades to the scaffold seed) on any
 * failure, so a flaky clone never bricks the seed. Reuses materializeRepo's
 * battle-tested clone (retries, stall-abort, proxy auth) verbatim.
 */
export async function materializeProjectSeed(cfg: Config): Promise<boolean> {
  if (!cfg.repoUrl) return false
  const t0 = Date.now()
  try {
    await clearDirContents(cfg.projectTarget)
    // No branchName during seed capture (no session yet); baseSha=tip so a baked /workspace
    // (if any) is treated as mismatched and re-materialized to the real repo.
    await materializeRepo({ ...cfg, branchName: undefined, sessionFresh: true })
    logger.info('[git] project seed materialized at base', {
      ms: Date.now() - t0,
      base: cfg.defaultBranch,
    })
    return true
  } catch (err) {
    logger.warn('[git] project seed materialize failed; warm seed will fall back to scaffold', {
      err: err instanceof Error ? err.message.slice(0, 200) : String(err),
    })
    return false
  }
}

// Materialize `target` from the image-baked scaffold + a delta fetch from the
// project origin. Returns true when target is ready on `base` tip; false →
// caller runs the normal network clone (never leaves a partial target behind).
async function tryScaffoldDeltaFetch(
  cfg: Config,
  target: string,
  base: string,
): Promise<boolean> {
  if (!existsSync(scaffoldRepoPath) || !cfg.repoUrl) return false
  const tmp = await createStagePath(target, 'scaffold')
  const t0 = Date.now()
  try {
    await rm(tmp, { recursive: true, force: true })
    const local = await execGit(['clone', '-q', scaffoldRepoPath, tmp])
    if (local.code !== 0) throw new Error(`local scaffold clone: ${local.stderr}`)
    const su = await execGit(['-C', tmp, 'remote', 'set-url', 'origin', cfg.repoUrl])
    if (su.code !== 0) throw new Error(`set-url: ${su.stderr}`)
    // ZERO-NETWORK fast path: the image-baked scaffold's root commit is shared,
    // byte-for-byte, with every project seeded from the starter. When the
    // project's base tip (resolved server-side, passed as KORTIX_BASE_SHA) IS
    // that root — a fresh project with no per-project commit — the local clone
    // already holds the exact base tree, so `git fetch` would transfer ZERO
    // objects: a pure negotiation round-trip that still hung ~34s through the
    // flaky dev tunnel (2026-06-13). Skip it: just branch off the local HEAD.
    const localHead = (await execGit(['-C', tmp, 'rev-parse', 'HEAD'])).stdout.trim()
    if (cfg.sessionFresh && cfg.baseSha && localHead === cfg.baseSha) {
      const co = await execGit(['-C', tmp, 'checkout', '-q', '-B', base, 'HEAD'])
      if (co.code !== 0) throw new Error(`checkout base (local): ${co.stderr}`)
      await swapStageIntoTarget(tmp, target)
      logger.info('[git] repo materialized via scaffold (zero-network: baked scaffold == base tip)', { ms: Date.now() - t0, base, head: localHead })
      return true
    }
    const cloneCredential = await resolveCloneCredential(cfg)
    const fetched = await gitWithAuth(cloneCredential, cfg.repoUrl, [
      '-C', tmp,
      '-c', 'http.lowSpeedLimit=1000', '-c', 'http.lowSpeedTime=12',
      'fetch', '-q', 'origin', base,
    ], { timeoutMs: 35_000 })
    if (fetched.code !== 0) throw new Error(`fetch: ${fetched.stderr}`)
    const co = await execGit(['-C', tmp, 'checkout', '-q', '-B', base, 'FETCH_HEAD'])
    if (co.code !== 0) throw new Error(`checkout base: ${co.stderr}`)
    await swapStageIntoTarget(tmp, target)
    logger.info('[git] repo materialized via scaffold delta-fetch', { ms: Date.now() - t0, base })
    return true
  } catch (err) {
    logger.info('[git] scaffold fast path unavailable; falling back to clone', {
      err: err instanceof Error ? err.message.slice(0, 200) : String(err),
    })
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
    return false
  }
}

export type RepoInfo = {
  path: string
  branch: string | null
  commit: string | null
  remoteUrl: string | null
}

/**
 * Read branch/commit/remote for a materialized repo.
 *
 * The three git calls run CONCURRENTLY, not in sequence. This is on a hotter path
 * than it looks: `/kortix/health` calls it on EVERY request (to compute
 * `repo_ready`), and both the frontend and the API poll health throughout boot —
 * so three serial process spawns per poll land squarely in the window where the
 * guest is CPU-saturated by the clone's index-pack, on a 2-vCPU box. All three
 * are read-only plumbing commands that take no index lock, so concurrency here is
 * safe; only the `.git` existence check has to happen first.
 */
export async function readRepoInfo(target: string): Promise<RepoInfo | null> {
  if (!(await pathExists(`${target}/.git`))) return null
  const [branch, commit, remote] = await Promise.all([
    execGit(['-C', target, 'rev-parse', '--abbrev-ref', 'HEAD']),
    execGit(['-C', target, 'rev-parse', 'HEAD']),
    execGit(['-C', target, 'remote', 'get-url', 'origin']),
  ])
  return {
    path: target,
    branch: branch.code === 0 ? branch.stdout.trim() : null,
    commit: commit.code === 0 ? commit.stdout.trim() : null,
    remoteUrl: remote.code === 0 ? remote.stdout.trim() : null,
  }
}

type CommitPushResult = {
  /** A new commit was created from dirty working-tree changes. */
  committed: boolean
  /** New commits were pushed to origin (false when the remote was already up to date). */
  pushed: boolean
  /** Nothing changed: clean tree and the branch was already pushed. */
  nothingToDo: boolean
  branch: string | null
  headSha: string | null
}

/**
 * Commit the workspace's pending changes and push the session branch to
 * origin — the host-driven equivalent of what an agent does before opening a
 * change request, so the dashboard could open one without routing through the
 * LLM.
 *
 * NOTE (2026-05-29): currently UNUSED — the shipped flow lets the agent do this
 * from a chat prompt. Kept as the host-driven primitive for a possible
 * fully-UI change-request flow (see routes/git.ts). Idempotent:
 *   - dirty tree            → stage all, commit (with `message`), push
 *   - committed-but-unpushed → push only
 *   - clean + up to date     → no-op (`nothingToDo: true`)
 *
 * Auth + identity reuse the same machinery as clone/refresh: the per-boot
 * clone token for push credentials and the configured git identity for the
 * commit author/committer.
 */
export async function commitAndPushWorkingTree(
  cfg: Config,
  opts: { message?: string } = {},
): Promise<CommitPushResult> {
  const target = cfg.projectTarget
  const before = await readRepoInfo(target)
  if (!before) throw new Error('project repo is not materialized')

  const branch = cfg.branchName || before.branch
  if (!branch) throw new Error('no branch checked out to push')

  // 1. Stage + commit anything in the working tree.
  const status = await execGit(['-C', target, 'status', '--porcelain'])
  if (status.code !== 0) {
    throw new Error(`git status failed: ${status.stderr || status.stdout}`)
  }
  let committed = false
  if (status.stdout.trim().length > 0) {
    const added = await execGit(['-C', target, 'add', '-A'])
    if (added.code !== 0) throw new Error(`git add failed: ${added.stderr || added.stdout}`)

    const message = (opts.message?.trim() || 'Update from session').slice(0, 500)
    const commit = await execGit(['-C', target, 'commit', '-m', message], {
      env: buildGitIdentityEnv(cfg),
    })
    if (commit.code === 0) {
      committed = true
    } else if (!/nothing to commit|no changes added/i.test(`${commit.stdout} ${commit.stderr}`)) {
      throw new Error(`git commit failed: ${commit.stderr || commit.stdout}`)
    }
  }

  // 2. Push HEAD to the session branch on origin.
  const cloneCredential = await resolveCloneCredential(cfg)
  const authRepoUrl = cfg.repoUrl ?? before.remoteUrl ?? undefined
  const push = await gitWithAuth(cloneCredential, authRepoUrl, [
    '-C',
    target,
    'push',
    'origin',
    `HEAD:refs/heads/${branch}`,
  ])
  if (push.code !== 0) {
    throw new Error(`git push failed: ${push.stderr || push.stdout}`)
  }
  const remoteUpToDate = /Everything up-to-date/i.test(`${push.stdout} ${push.stderr}`)

  const after = await readRepoInfo(target)
  return {
    committed,
    pushed: !remoteUpToDate,
    nothingToDo: !committed && remoteUpToDate,
    branch,
    headSha: after?.commit ?? before.commit,
  }
}

export async function refreshRepo(cfg: Config): Promise<{ before: RepoInfo; after: RepoInfo }> {
  const target = cfg.projectTarget
  const before = await readRepoInfo(target)
  if (!before) {
    throw new Error('project repo is not materialized')
  }

  const cloneCredential = await resolveCloneCredential(cfg)
  if (cfg.repoUrl) {
    const setUrl = await gitWithAuth(cloneCredential, cfg.repoUrl, [
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
  const fetched = await gitWithAuth(cloneCredential, authRepoUrl, [
    '-C',
    target,
    'fetch',
    '--prune',
    'origin',
    `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
  ])
  // A session branch that was never pushed has NO remote ref, and that is the
  // ordinary state of a session which has not proposed its changes yet — the
  // branch is created locally at boot and only reaches origin when the user
  // proposes. Treating it as a failure made `POST /kortix/refresh` answer 500
  // for exactly those sessions, which is the common case: reload is offered by
  // the stale-config notice, and a brand-new session is the one most likely to
  // be told its config moved.
  //
  // Verified live on dev against a freshly provisioned session:
  //   git fetch refresh failed: fatal: couldn't find remote ref refs/heads/<session-id>
  //
  // There is nothing upstream to fast-forward from, so skip the pull and let
  // the rest of the refresh — notably the config-dir sync, which reads the BASE
  // ref, not this branch — carry on. Any other fetch failure is still fatal.
  const missingRemoteBranch =
    fetched.code !== 0 && /couldn't find remote ref/i.test(fetched.stderr)
  if (fetched.code !== 0 && !missingRemoteBranch) {
    throw new Error(`git fetch refresh failed: ${fetched.stderr}`)
  }

  if (missingRemoteBranch) {
    logger.info('[git] session branch is not on the remote yet; nothing to pull', { branch })
  } else {
    const pulled = await gitWithAuth(cloneCredential, authRepoUrl, [
      '-C',
      target,
      'pull',
      '--ff-only',
      'origin',
      branch,
    ])
    if (pulled.code !== 0) throw new Error(`git pull refresh failed: ${pulled.stderr}`)
  }

  const after = await readRepoInfo(target)
  if (!after) throw new Error('project repo disappeared after refresh')

  return { before, after }
}

/**
 * Sync the workspace to the LATEST base-branch tip. Used after restoring a
 * per-project warm snapshot: it cloned base during seed capture, so base may
 * have advanced since. Resets the current session branch to origin/<base> —
 * safe because a fresh session has no local work yet. No opencode restart
 * needed; opencode's file watcher picks up the changed files.
 */
export async function syncWorkspaceToBase(
  cfg: Config,
  baseSha?: string,
): Promise<{ before: RepoInfo; after: RepoInfo }> {
  const target = cfg.projectTarget
  const before = await readRepoInfo(target)
  if (!before) throw new Error('project repo is not materialized')
  if (baseSha && before.commit === baseSha) {
    logger.info('[git] workspace already matches base', {
      base: cfg.defaultBranch,
      branch: before.branch,
      commit: before.commit,
    })
    return { before, after: before }
  }

  const cloneCredential = await resolveCloneCredential(cfg)
  const base = cfg.defaultBranch
  const fetched = await gitWithAuth(cloneCredential, cfg.repoUrl, [
    '-C', target, 'fetch', '--prune', 'origin', `+refs/heads/${base}:refs/remotes/origin/${base}`,
  ])
  if (fetched.code !== 0) throw new Error(`git fetch base failed: ${fetched.stderr}`)

  const branch = cfg.branchName || before.branch || base
  const targetRef = baseSha ?? `refs/remotes/origin/${base}`
  const reset = await gitWithAuth(cloneCredential, cfg.repoUrl, [
    '-C', target, 'checkout', '-B', branch, targetRef,
  ])
  if (reset.code !== 0) throw new Error(`git reset to base failed: ${reset.stderr}`)

  const after = await readRepoInfo(target)
  if (!after) throw new Error('project repo disappeared after base sync')
  logger.info('[git] synced workspace to latest base', { base, branch, before: before.commit, after: after.commit })
  return { before, after }
}

/**
 * Every git call in the config-dir sync runs with pathspec magic OFF.
 *
 * `opencode.config_dir` is repo-controlled, it becomes a pathspec, and git
 * honours magic like `:(top)*` even after `--`. Without this, a manifest could
 * turn "sync the agent config directory" into `git checkout <base> -- ':(top)*'`
 * — a rewrite of the whole working tree. Verified against the real primitives:
 * the magic form rewrites files outside the directory, the literalized form
 * does not.
 *
 * `resolveOpencodeConfigDirRelative` also rejects non-literal values, so this is
 * the second of two independent guards. It is the one that holds even if a
 * future caller passes a path from somewhere else.
 */
const LITERAL = { env: { GIT_LITERAL_PATHSPECS: '1' } } as const

export interface ConfigDirSyncResult {
  /** True only when files were actually replaced from the base ref. */
  synced: boolean
  /** Why nothing was replaced. Absent on success. */
  skipped?:
    | 'no tracked config dir'
    | 'already matches base'
    | 'local changes'
    | 'local commits'
    | 'not in base'
    | 'fetch failed'
    | 'checkout failed'
}

/**
 * Bring ONLY the opencode config directory up to the base ref.
 *
 * This is the operation `reload` actually needs, and the reason it exists is a
 * measured one: opencode is spawned with `OPENCODE_CONFIG_DIR` pointing INTO the
 * working tree, and the agent `.md` files there beat the compiled config we push
 * as JSON. So pushing the compiled config alone moves the etag and changes
 * nothing the agent reads — verified on dev, where the marker was present in
 * `~/.config/kortix-opencode.json` and absent from `/config` and `/agent`.
 *
 * Distinct from `syncWorkspaceToBase` in the one way that matters: that resets
 * the BRANCH (`git checkout -B <branch> <sha>`), which discards any commit the
 * session has made. This touches a single pathspec and never moves a ref, so
 * commits, other files, and the branch itself are untouched.
 *
 * It refuses rather than overwrites. If the session has edited its own agent
 * config — uncommitted, or committed on top of base — that is work, and a button
 * labelled "reload config" has no business discarding it. The caller reports the
 * skip so the user is told the agent did NOT change.
 *
 * Leaves the update UNSTAGED: `git checkout <sha> -- <path>` writes the index
 * too, so the index is reset afterwards. The result is a plain working-tree
 * modification, and its diff against base is empty by construction — so a change
 * request opened from this session carries nothing extra.
 */
export async function syncOpencodeConfigDirToBase(
  cfg: Config,
  relConfigDir: string | null,
  baseSha?: string,
): Promise<ConfigDirSyncResult> {
  if (!relConfigDir) return { synced: false, skipped: 'no tracked config dir' }
  const target = cfg.projectTarget
  const base = cfg.defaultBranch
  const cloneCredential = await resolveCloneCredential(cfg)

  const fetched = await gitWithAuth(cloneCredential, cfg.repoUrl, [
    '-C', target, 'fetch', '--prune', 'origin', `+refs/heads/${base}:refs/remotes/origin/${base}`,
  ])
  if (fetched.code !== 0) {
    logger.warn('[git] config-dir sync: fetch failed', { stderr: fetched.stderr })
    return { synced: false, skipped: 'fetch failed' }
  }
  const ref = baseSha ?? `refs/remotes/origin/${base}`

  // "Already base" is checked FIRST, and the order is load-bearing rather than
  // cosmetic. A successful sync leaves the working tree matching base while HEAD
  // still carries the old content, so the directory is legitimately dirty
  // afterwards. Checking dirtiness first made every reload after the first one
  // refuse with 'local changes' — the guard could not tell the user's edit from
  // our own previous one. Comparing against base instead answers the question
  // that actually matters, and it cannot mask a real edit: content that differs
  // from base falls through to the guards below.
  const diff = await execGit(['-C', target, 'diff', '--quiet', ref, '--', relConfigDir], LITERAL)
  if (diff.code === 0) return { synced: false, skipped: 'already matches base' }

  // Uncommitted edits under the config dir — including untracked files, which
  // `git checkout` would silently leave behind in a half-updated directory.
  const dirty = await execGit(['-C', target, 'status', '--porcelain', '--', relConfigDir], LITERAL)
  if (dirty.code === 0 && dirty.stdout.trim().length > 0) {
    return { synced: false, skipped: 'local changes' }
  }

  // Commits this session made on top of base that touch the config dir. Without
  // this a session that edited and COMMITTED its agent would have that silently
  // reverted by a reload.
  const ahead = await execGit(
    ['-C', target, 'log', '--oneline', `${ref}..HEAD`, '--', relConfigDir],
    LITERAL,
  )
  if (ahead.code === 0 && ahead.stdout.trim().length > 0) {
    return { synced: false, skipped: 'local commits' }
  }

  const checkout = await execGit(['-C', target, 'checkout', ref, '--', relConfigDir], LITERAL)
  if (checkout.code !== 0) {
    // The most likely cause is that base has no such directory at all.
    const missing = /did not match any file|pathspec/i.test(checkout.stderr)
    logger.warn('[git] config-dir sync: checkout failed', { stderr: checkout.stderr })
    return { synced: false, skipped: missing ? 'not in base' : 'checkout failed' }
  }
  // Un-stage: leave a plain working-tree change, not a staged one.
  await execGit(['-C', target, 'reset', '-q', '--', relConfigDir], LITERAL)

  logger.info('[git] synced opencode config dir to base', { dir: relConfigDir, ref })
  return { synced: true }
}
