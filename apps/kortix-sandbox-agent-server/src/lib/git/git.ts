import { spawn } from 'node:child_process'
import { mkdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

import type { Config } from '../config/config'
import { logger } from '../log/logger'

export type ExecResult = { code: number; stdout: string; stderr: string }
type GitIdentityConfig = Pick<Config, 'gitUserName' | 'gitUserEmail'>

export function execGit(
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

export async function configureRepoGitIdentity(cfg: GitIdentityConfig, target: string): Promise<void> {
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

export async function configureSafeDirectory(target: string): Promise<void> {
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

/** Build auth args only for the Kortix Git proxy. */
export function buildGitAuthArgs(
  repoUrl: string | undefined,
  token: string | undefined,
): string[] {
  if (!token || !repoUrl || !/\/v1\/git\//.test(repoUrl)) return []

  const parsed = new URL(repoUrl)
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return []
  const authOrigin = `${parsed.protocol}//${parsed.host}`

  const headerValue = Buffer.from(`x-access-token:${token}`).toString('base64')
  const header = `AUTHORIZATION: basic ${headerValue}`
  return [
    '-c',
    `http.${authOrigin}/.extraheader=${header}`,
    '-c',
    `http.extraheader=${header}`,
  ]
}

export interface CloneCredential {
  username: string
  token: string
}

export async function gitWithAuth(
  credential: CloneCredential | undefined,
  repoUrl: string | undefined,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<ExecResult> {
  return execGit([
    ...buildGitAuthArgs(repoUrl, credential?.token),
    ...args,
  ], opts)
}

export async function resolveCloneCredential(cfg: Config): Promise<CloneCredential | undefined> {
  // No configured remote: the caller works on the checkout's own origin, and
  // buildGitAuthArgs only ever attaches a credential to the Kortix Git proxy,
  // so there is nothing to resolve and nothing to refuse. This is the shape
  // the refresh/pull routes rely on: a materialized repo with no repoUrl in
  // env answers its own origin (or 409s when it is not materialized), it does
  // not turn the credential boundary into a 500.
  if (!cfg.repoUrl) return undefined
  if (
    !/\/v1\/git\//.test(cfg.repoUrl) &&
    !cfg.repoUrl.startsWith('/') &&
    !cfg.repoUrl.startsWith('file:')
  ) {
    throw new Error('direct Git origins are refused; KORTIX_REPO_URL must use the Kortix Git proxy')
  }
  if (!cfg.apiUrl || !cfg.projectId || !cfg.sandboxToken) return undefined
  return { username: 'x-access-token', token: cfg.sandboxToken }
}

/**
 * Configure git so that *any* push/fetch the agent runs against the project's
 * managed remote authenticates with zero setup — the same credential the
 * daemon receives as KORTIX_TOKEN at session start.
 *
 * Mechanism: a git credential helper pointed back at this very binary
 * (`kortix-agent git-credential`). When git needs a credential for the repo
 * host it execs the helper, which returns KORTIX_TOKEN without storing it in
 * `.git/config`.
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
  const username = (await resolveCloneCredential(cfg))?.username ?? 'x-access-token'

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
  const username = (await resolveCloneCredential(cfg))?.username ?? 'x-access-token'

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
 * the session token and writes `username`/`password` to stdout. Every other
 * action (`store`, `erase`) is a no-op. The helper persists nothing.
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

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
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
export async function createStagePath(target: string, kind: string): Promise<string> {
  await mkdir(target, { recursive: true })
  return join(target, `.kortix-${kind}-${process.pid}-${Date.now()}`)
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
  /** Files base changed that this session changed too. Left as they are. */
  kept?: string[]
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
 * It works file by file over what BASE changed since the session's branch left
 * it (`merge-base`), and refuses rather than overwrites: a file the session
 * edited — uncommitted, or committed on top of the fork — is its work, and a
 * button labelled "reload config" has no business discarding it. Such files are
 * reported in `kept`; every other base change is brought in. Files base did not
 * change are never looked at, which is what lets the platform's own writes into
 * the directory (OpenCode's plugin install, the managed-skill overlay) coexist
 * with the sync.
 *
 * Leaves the update UNSTAGED: `git checkout <sha> -- <path>` writes the index
 * too, so the index is reset afterwards. The result is a plain working-tree
 * modification, and its diff against base is empty by construction — so a change
 * request opened from this session carries nothing extra.
 */
export async function syncConfigDirToBase(
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

  // Only the files BASE changed since this session's branch left it are this
  // sync's business. Everything else in the directory stays as it is — and the
  // platform itself writes there: OpenCode's plugin install rewrites the tracked
  // `package.json` and the managed-skill overlay rewrites `skills/kortix-*`, so a
  // whole-directory "anything dirty?" guard refused on every live box (dev
  // 2026-09-30: a fresh session with no edits of its own reported 'local
  // changes').
  const fork = await execGit(['-C', target, 'merge-base', 'HEAD', ref])
  if (fork.code !== 0) return { synced: false, skipped: 'checkout failed' }
  const changed = await execGit(
    ['-C', target, 'diff', '--name-status', '--no-renames', fork.stdout.trim(), ref, '--', relConfigDir],
    LITERAL,
  )
  if (changed.code !== 0) return { synced: false, skipped: 'checkout failed' }
  const baseChanges = changed.stdout
    .split('\n')
    .map((line) => line.split('\t'))
    .filter((parts): parts is [string, string] => parts.length === 2 && parts[1]!.length > 0)
    .map(([status, file]) => ({ file, deleted: status === 'D' }))
  if (baseChanges.length === 0) {
    const inBase = await execGit(['-C', target, 'cat-file', '-e', `${ref}:${relConfigDir}`], LITERAL)
    return { synced: false, skipped: inBase.code === 0 ? 'already matches base' : 'not in base' }
  }

  // Files this session committed on top of the fork: its own work, kept.
  const committed = await execGit(
    ['-C', target, 'diff', '--name-only', '--no-renames', fork.stdout.trim(), 'HEAD', '--', relConfigDir],
    LITERAL,
  )
  const ownCommits = new Set(committed.stdout.split('\n').filter(Boolean))

  const toCheckout: string[] = []
  const toDelete: string[] = []
  const kept: string[] = []
  let keptByCommit = true
  for (const { file, deleted } of baseChanges) {
    // Already what base has: a previous reload brought it, or the session made
    // the same change. Nothing to do and nothing to protect.
    if ((await execGit(['-C', target, 'diff', '--quiet', ref, '--', file], LITERAL)).code === 0) continue
    if (ownCommits.has(file)) {
      kept.push(file)
      continue
    }
    // Uncommitted work on this file, including an untracked file where base
    // adds one.
    const status = await execGit(['-C', target, 'status', '--porcelain', '--', file], LITERAL)
    if (status.code !== 0 || status.stdout.trim().length > 0) {
      kept.push(file)
      keptByCommit = false
      continue
    }
    ;(deleted ? toDelete : toCheckout).push(file)
  }

  if (toCheckout.length === 0 && toDelete.length === 0) {
    if (kept.length === 0) return { synced: false, skipped: 'already matches base' }
    return { synced: false, skipped: keptByCommit ? 'local commits' : 'local changes', kept }
  }
  if (toCheckout.length > 0) {
    const checkout = await execGit(['-C', target, 'checkout', ref, '--', ...toCheckout], LITERAL)
    if (checkout.code !== 0) {
      logger.warn('[git] config-dir sync: checkout failed', { stderr: checkout.stderr })
      return { synced: false, skipped: 'checkout failed' }
    }
    // Un-stage: leave a plain working-tree change, not a staged one.
    await execGit(['-C', target, 'reset', '-q', '--', ...toCheckout], LITERAL)
  }
  // Base deleted these and the session never touched them: an unstaged deletion.
  for (const file of toDelete) await rm(join(target, file), { force: true })

  logger.info('[git] synced the runtime config dir to base', {
    dir: relConfigDir,
    ref,
    updated: toCheckout.length + toDelete.length,
    kept: kept.length,
  })
  return { synced: true, ...(kept.length > 0 ? { kept } : {}) }
}
