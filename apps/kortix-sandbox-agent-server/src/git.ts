import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

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
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<ExecResult> {
  return execGit([...buildGitAuthArgs(repoUrl, token), ...args], opts)
}

const CLONE_CRED_TIMEOUT_MS = 15_000
const CLONE_CRED_ATTEMPTS = 4

/**
 * Per-process cache for the clone-credential round-trip. `materializeRepo`
 * calls `resolveCloneToken` twice (base clone + branch checkout) on the cold
 * path; the API token doesn't change within a single boot, so caching it
 * avoids a second control-plane round-trip over the public internet.
 * Memoize on the input shape (api+project+token) so re-keying invalidates.
 */
let cachedCloneToken: { key: string; value: string | undefined } | null = null

/** Test-only: drop the cached clone token so a fresh fetch happens next call. */
export function __clearCloneTokenCacheForTests(): void {
  cachedCloneToken = null
}

async function resolveCloneToken(cfg: Config): Promise<string | undefined> {
  if (!cfg.apiUrl || !cfg.projectId || !cfg.kortixToken) return undefined
  // Universal proxy origin: when the repo is served by the Kortix git proxy
  // (KORTIX_REPO_URL = `${KORTIX_URL}/v1/git/<projectId>.git`), the git
  // credential IS our own KORTIX_TOKEN — the proxy authenticates it and resolves
  // the real upstream + host credential server-side. No clone-credential round
  // trip, and a real GitHub token never enters the sandbox.
  if (cfg.repoUrl && /\/v1\/git\//.test(cfg.repoUrl)) {
    return cfg.kortixToken
  }
  const cacheKey = `${cfg.apiUrl}\0${cfg.projectId}\0${cfg.kortixToken}`
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
          Authorization: `Bearer ${cfg.kortixToken}`,
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
        | { auth?: { token?: string | null } | null }
        | null
      const token = body?.auth?.token?.trim()
      const value = token || undefined
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
  if (!cfg.repoUrl || !cfg.projectId || !cfg.kortixToken) return
  const host = deriveAuthHost(cfg.repoUrl)
  if (!host) return

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
    ['config', '--global', '--replace-all', `credential.${host}.username`, 'x-access-token'],
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
  if (!cfg.repoUrl || !cfg.projectId || !cfg.kortixToken) return
  if (!(await pathExists(`${target}/.git`))) return
  const host = deriveAuthHost(cfg.repoUrl)
  if (!host) return

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
    ['-C', target, 'config', '--local', '--replace-all', `credential.${host}.username`, 'x-access-token'],
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
  let token: string | undefined
  try {
    token = await resolveCloneToken(cfg)
  } catch (err) {
    logger.warn('[git] credential helper could not resolve token', {
      err: err instanceof Error ? err.message : String(err),
    })
    return null
  }
  if (!token) return null
  return `username=x-access-token\npassword=${token}\n`
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

async function checkoutSessionBranch(
  cfg: Config,
  target: string,
  branch: string,
  token: string | undefined,
): Promise<void> {
  const refSpec = `+refs/heads/${branch}:refs/remotes/origin/${branch}`
  // Same stall-abort + hard timeout as the clone: a restored VM's RX can hang
  // this fetch with no reset. On failure/timeout we fall through to a local
  // branch from the base checkout (below), so the session still boots.
  const fetched = await gitWithAuth(token, cfg.repoUrl, [
    '-c', 'http.lowSpeedLimit=1000', '-c', 'http.lowSpeedTime=12',
    '-C',
    target,
    'fetch',
    'origin',
    refSpec,
  ], { timeoutMs: 30_000 })

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

  const local = await gitWithAuth(token, cfg.repoUrl, [
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
  const local = await execGit([
    '-C',
    target,
    'checkout',
    '-B',
    branch,
  ])
  if (local.code !== 0) {
    throw new Error(`failed to create local session branch ${branch}: ${local.stderr}`)
  }
  logger.info('[git] created local session branch from baked checkout', { branch })
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
    await rm(target, { recursive: true, force: true })
  }
  {
    const cloneToken = await resolveCloneToken(cfg)
    // Scaffold fast path: the image bakes the canonical starter repo at
    // /opt/kortix/scaffold.git whose root commit is SHARED with every project
    // seeded from the starter (deterministic root — comp git-backends/seed.ts).
    // A local clone is ~50ms and the follow-up fetch transfers only the
    // project's delta beyond that shared root (a fresh project = ~one tiny
    // commit) instead of the whole repo over the slow git path (9s through the
    // dev tunnel, 2026-06-13). Imported repos / other starters share no
    // ancestor → the fetch degrades to a full pack (same as a clone); ANY
    // failure falls through to the battle-tested clone path below.
    if (await tryScaffoldDeltaFetch(cfg, target, base, cloneToken)) {
      if (cfg.branchName) {
        // Fresh session → branch == base, create it LOCALLY (zero network).
        // Restart/resume → the remote branch may carry the agent's commits.
        if (cfg.sessionFresh) await checkoutLocalSessionBranch(target, cfg.branchName)
        else await checkoutSessionBranch(cfg, target, cfg.branchName, cloneToken)
      }
      await configureRepoGitIdentity(cfg, target)
      return
    }
    const tmpTarget = join(dirname(target), `.kortix-clone-${process.pid}-${Date.now()}`)
    await rm(tmpTarget, { recursive: true, force: true })
    logger.info('[git] cloning repo', {
      repoUrl: cfg.repoUrl,
      base,
      target,
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
    // while a transient blip clears in 1–2 retries. resolveCloneToken already
    // retries the credential fetch; the clone itself needs it just as much.
    const baseCloneArgs = [
      '-c', 'http.lowSpeedLimit=1000', '-c', 'http.lowSpeedTime=12',
      'clone', '--branch', base, '--single-branch',
    ]
    const isTransientGit = (s: string) =>
      /early EOF|RPC failed|Connection reset|Recv failure|fetch-pack|unexpected disconnect|index-pack|Could not resolve host|Connection timed out|timed out|GnuTLS recv|SSL_read|TLS packet|Failed to connect|Empty reply|Operation too slow|transfer closed|server hung up|remote end hung up|Stream closed|HTTP 5/i.test(s)
    const MAX_CLONE_ATTEMPTS = 4
    let cloned = { code: -1, stdout: '', stderr: '' } as Awaited<ReturnType<typeof gitWithAuth>>
    for (let attempt = 1; attempt <= MAX_CLONE_ATTEMPTS; attempt++) {
      await rm(tmpTarget, { recursive: true, force: true }).catch(() => {})
      // Blobless partial clone keeps full history but defers file blobs, cutting
      // the boot-time transfer from a full-history pack to roughly the working
      // tree. This is the dominant per-session boot cost on large repos.
      cloned = await gitWithAuth(cloneToken, cfg.repoUrl, [
        ...baseCloneArgs,
        ...(cfg.cloneFilter ? [`--filter=${cfg.cloneFilter}`] : []),
        cfg.repoUrl,
        tmpTarget,
      ], { timeoutMs: 35_000 })
      if (cloned.code !== 0 && cfg.cloneFilter && !isTransientGit(cloned.stderr)) {
        // Remote may not advertise uploadpack.allowFilter — fall back to a full
        // clone so a non-supporting host still boots (just slower).
        logger.warn('[git] partial clone failed; retrying as a full clone', {
          stderr: cloned.stderr.slice(0, 200),
        })
        await rm(tmpTarget, { recursive: true, force: true }).catch(() => {})
        cloned = await gitWithAuth(cloneToken, cfg.repoUrl, [...baseCloneArgs, cfg.repoUrl, tmpTarget], { timeoutMs: 35_000 })
      }
      if (cloned.code === 0) break
      const transient = isTransientGit(cloned.stderr)
      logger.warn('[git] clone attempt failed', { attempt, maxAttempts: MAX_CLONE_ATTEMPTS, transient, stderr: cloned.stderr.slice(0, 200) })
      if (!transient || attempt === MAX_CLONE_ATTEMPTS) break
      // Jittered backoff: base grows per attempt, jitter spreads concurrent retries.
      await new Promise((r) => setTimeout(r, 500 * attempt + Math.floor(Math.random() * 700)))
    }
    if (cloned.code !== 0) {
      await rm(tmpTarget, { recursive: true, force: true }).catch(() => {})
      throw new Error(`git clone failed after ${MAX_CLONE_ATTEMPTS} attempt(s): ${cloned.stderr}`)
    }
    await rm(target, { recursive: true, force: true })
    await rename(tmpTarget, target)
    // Fresh clone already left the working tree on `base` at tip — the old
    // extra `git fetch origin base` + `git reset --hard` here was a redundant
    // network round-trip on the per-session boot hot path. Removed.
  }

  if (cfg.branchName) {
    if (cfg.sessionFresh) {
      // Fresh session → branch == freshly-cloned base; local, no extra fetch.
      await checkoutLocalSessionBranch(target, cfg.branchName)
    } else {
      // resolveCloneToken is memoized — this second call is now ~free.
      const cloneToken = await resolveCloneToken(cfg)
      await checkoutSessionBranch(cfg, target, cfg.branchName, cloneToken)
    }
  }

  await configureRepoGitIdentity(cfg, target)
}

const SCAFFOLD_REPO_PATH = '/opt/kortix/scaffold.git'

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
  if (!existsSync(SCAFFOLD_REPO_PATH)) return false
  const tmp = join(dirname(target), `.kortix-seed-${process.pid}-${Date.now()}`)
  const t0 = Date.now()
  try {
    await mkdir(dirname(target), { recursive: true })
    await rm(tmp, { recursive: true, force: true })
    const cloned = await execGit(['clone', '-q', SCAFFOLD_REPO_PATH, tmp])
    if (cloned.code !== 0) throw new Error(`seed scaffold clone: ${cloned.stderr}`)
    const co = await execGit(['-C', tmp, 'checkout', '-q', '-B', base, 'HEAD'])
    if (co.code !== 0) throw new Error(`seed checkout base: ${co.stderr}`)
    await rm(target, { recursive: true, force: true })
    await rename(tmp, target)
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

// Materialize `target` from the image-baked scaffold + a delta fetch from the
// project origin. Returns true when target is ready on `base` tip; false →
// caller runs the normal network clone (never leaves a partial target behind).
async function tryScaffoldDeltaFetch(
  cfg: Config,
  target: string,
  base: string,
  cloneToken: string | undefined,
): Promise<boolean> {
  if (!existsSync(SCAFFOLD_REPO_PATH) || !cfg.repoUrl) return false
  const tmp = join(dirname(target), `.kortix-scaffold-${process.pid}-${Date.now()}`)
  const t0 = Date.now()
  try {
    await rm(tmp, { recursive: true, force: true })
    const local = await execGit(['clone', '-q', SCAFFOLD_REPO_PATH, tmp])
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
      await rm(target, { recursive: true, force: true })
      await rename(tmp, target)
      logger.info('[git] repo materialized via scaffold (zero-network: baked scaffold == base tip)', { ms: Date.now() - t0, base, head: localHead })
      return true
    }
    const fetched = await gitWithAuth(cloneToken, cfg.repoUrl, [
      '-C', tmp,
      '-c', 'http.lowSpeedLimit=1000', '-c', 'http.lowSpeedTime=12',
      'fetch', '-q', 'origin', base,
    ], { timeoutMs: 35_000 })
    if (fetched.code !== 0) throw new Error(`fetch: ${fetched.stderr}`)
    const co = await execGit(['-C', tmp, 'checkout', '-q', '-B', base, 'FETCH_HEAD'])
    if (co.code !== 0) throw new Error(`checkout base: ${co.stderr}`)
    await rm(target, { recursive: true, force: true })
    await rename(tmp, target)
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

export type CommitPushResult = {
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
  const cloneToken = await resolveCloneToken(cfg)
  const authRepoUrl = cfg.repoUrl ?? before.remoteUrl ?? undefined
  const push = await gitWithAuth(cloneToken, authRepoUrl, [
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

/**
 * Sync the workspace to the LATEST base-branch tip. Used when a warm-pool box
 * is claimed: it cloned base when it parked, so base may have advanced since.
 * Resets the current (session) branch to origin/<base> — safe because a fresh
 * warm session has no local work yet. No opencode restart needed; opencode's
 * file watcher picks up the changed files. See docs/specs/warm-pool.md.
 */
export async function syncWorkspaceToBase(cfg: Config): Promise<{ before: RepoInfo; after: RepoInfo }> {
  const target = cfg.projectTarget
  const before = await readRepoInfo(target)
  if (!before) throw new Error('project repo is not materialized')

  const cloneToken = await resolveCloneToken(cfg)
  const base = cfg.defaultBranch
  const fetched = await gitWithAuth(cloneToken, cfg.repoUrl, [
    '-C', target, 'fetch', '--prune', 'origin', `+refs/heads/${base}:refs/remotes/origin/${base}`,
  ])
  if (fetched.code !== 0) throw new Error(`git fetch base failed: ${fetched.stderr}`)

  const branch = cfg.branchName || before.branch || base
  const reset = await gitWithAuth(cloneToken, cfg.repoUrl, [
    '-C', target, 'checkout', '-B', branch, `refs/remotes/origin/${base}`,
  ])
  if (reset.code !== 0) throw new Error(`git reset to base failed: ${reset.stderr}`)

  const after = await readRepoInfo(target)
  if (!after) throw new Error('project repo disappeared after base sync')
  logger.info('[git] synced workspace to latest base', { base, branch, before: before.commit, after: after.commit })
  return { before, after }
}
