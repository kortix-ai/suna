import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, readFile, readlink } from 'node:fs/promises'
import { join } from 'node:path'
import {
  isPlainConfigDir,
  type WorkspaceChange,
  type WorkspaceChangeStatus,
  type WorkspaceCommittedScope,
  type WorkspaceReport,
} from './descriptor'

/**
 * The session's work under the config dir, read with READ-ONLY Git.
 * Spec: docs/specs/config-releases.md, "Workspace report".
 *
 * The API reads this report to choose the config mode. The daemon only lists
 * facts; it does not classify. Platform-written files (the plugin pin, the
 * installer lockfile, the managed-skill overlay) are listed like any other
 * file, because telling them apart is the API's job.
 *
 * Rules:
 *   - NEVER fetch. A booting box or a box without network still answers, and
 *     the user's `.git` gets no new refs or objects from the platform.
 *   - `GIT_OPTIONAL_LOCKS=0`: `git status` does not rewrite the index.
 *   - `GIT_LITERAL_PATHSPECS=1`, and a config dir that is not a plain
 *     relative path is refused before any Git call. The value comes from a
 *     repository-controlled manifest, and Git honours pathspec magic such as
 *     `:(top)*` even after `--`.
 */

const GIT_TIMEOUT_MS = 15_000
/** The API's `MAX_WORKSPACE_REPORT_ENTRIES`. */
export const MAX_REPORT_ENTRIES = 5_000

interface GitResult {
  code: number
  stdout: string
  stderr: string
}

function git(repo: string, args: string[], input?: string): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = spawn('git', ['-C', repo, ...args], {
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_LITERAL_PATHSPECS: '1',
        GIT_OPTIONAL_LOCKS: '0',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), GIT_TIMEOUT_MS)
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')))
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ code: 1, stdout, stderr: stderr + String(err) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? 1, stdout, stderr })
    })
    child.stdin.end(input)
  })
}

/**
 * `git status --porcelain -z` rows. A rename or copy row is followed by its
 * source path; the source is reported as deleted.
 */
function parseStatus(stdout: string): Array<{ path: string; status: WorkspaceChangeStatus }> {
  const tokens = stdout.split('\0').filter((token) => token.length > 0)
  const rows: Array<{ path: string; status: WorkspaceChangeStatus }> = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    const code = token.slice(0, 2)
    const path = token.slice(3)
    if (code === '??') {
      rows.push({ path, status: 'untracked' })
      continue
    }
    if (code.includes('R') || code.includes('C')) {
      const source = tokens[++i]
      rows.push({ path, status: 'added' })
      if (source && code.includes('R')) rows.push({ path: source, status: 'deleted' })
      continue
    }
    if (code.includes('D')) rows.push({ path, status: 'deleted' })
    else if (code.includes('A')) rows.push({ path, status: 'added' })
    else rows.push({ path, status: 'modified' })
  }
  return rows
}

function parseNameStatus(stdout: string): Array<{ path: string; status: WorkspaceChangeStatus }> {
  const tokens = stdout.split('\0').filter((token) => token.length > 0)
  const rows: Array<{ path: string; status: WorkspaceChangeStatus }> = []
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const letter = tokens[i]!.charAt(0)
    const path = tokens[i + 1]!
    rows.push({ path, status: letter === 'A' ? 'added' : letter === 'D' ? 'deleted' : 'modified' })
  }
  return rows
}

function blobIdOf(content: Buffer, format: 'sha1' | 'sha256'): string {
  const hash = createHash(format)
  hash.update(`blob ${content.length}\0`)
  hash.update(content)
  return hash.digest('hex')
}

/**
 * Blob ids of the working-tree files, null for a path that is gone. A regular
 * file goes through `git hash-object`, so clean filters and line-ending
 * conversion apply as they would on `git add`. A symlink is hashed by its target
 * text, which is what Git stores for it.
 */
async function worktreeBlobs(repo: string, paths: string[], format: 'sha1' | 'sha256'): Promise<Map<string, string | null>> {
  const blobs = new Map<string, string | null>()
  const regular: string[] = []
  for (const path of paths) {
    const stat = await lstat(join(repo, path)).catch(() => null)
    if (!stat) blobs.set(path, null)
    else if (stat.isSymbolicLink()) blobs.set(path, blobIdOf(Buffer.from(await readlink(join(repo, path))), format))
    else if (stat.isFile()) regular.push(path)
    else blobs.set(path, null)
  }
  if (regular.length > 0) {
    // `--stdin-paths` reads one path per line; a name with a newline cannot be
    // passed that way and is hashed in-process instead.
    const lineSafe = regular.filter((path) => !path.includes('\n'))
    const hashed = await git(repo, ['hash-object', '--stdin-paths'], `${lineSafe.join('\n')}\n`)
    const ids = hashed.code === 0 ? hashed.stdout.split('\n').filter(Boolean) : []
    if (ids.length !== lineSafe.length) throw new Error(`git hash-object failed: ${hashed.stderr.trim()}`)
    lineSafe.forEach((path, index) => blobs.set(path, ids[index]!))
    for (const path of regular.filter((candidate) => candidate.includes('\n'))) {
      blobs.set(path, blobIdOf(await readFile(join(repo, path)), format))
    }
  }
  return blobs
}

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

/**
 * The commit the session's committed changes are measured from.
 *
 *   - `remote`: the merge base of HEAD and `refs/remotes/origin/<base>`.
 *   - `base-sha`: `KORTIX_BASE_SHA`, when the commit exists locally and is an
 *     ancestor of HEAD. A fresh boot (compiled checkout, API delta bundle,
 *     local session branch) may have no remote-tracking ref at all, or one left
 *     at the image scaffold's root.
 *   - `none`: neither is usable; only uncommitted changes are reported.
 *
 * When both are usable, the more recent one wins: a remote ref left at the
 * scaffold root would otherwise list every base commit as session work.
 */
async function resolveCommittedBase(
  repo: string,
  baseBranch: string,
  baseSha: string | undefined,
): Promise<{ scope: WorkspaceCommittedScope; mergeBase: string | null }> {
  const baseRef = `refs/remotes/origin/${baseBranch}`
  let remote: string | null = null
  if ((await git(repo, ['rev-parse', '--verify', '-q', `${baseRef}^{commit}`])).code === 0) {
    const mergeBase = await git(repo, ['merge-base', 'HEAD', baseRef])
    if (mergeBase.code === 0 && mergeBase.stdout.trim()) remote = mergeBase.stdout.trim()
  }
  let pinned: string | null = null
  const sha = baseSha?.trim().toLowerCase()
  if (
    sha &&
    OBJECT_ID.test(sha) &&
    (await git(repo, ['cat-file', '-e', `${sha}^{commit}`])).code === 0 &&
    (await git(repo, ['merge-base', '--is-ancestor', sha, 'HEAD'])).code === 0
  ) {
    pinned = sha
  }
  if (remote && pinned) {
    const remoteIsOlder = (await git(repo, ['merge-base', '--is-ancestor', remote, pinned])).code === 0
    return remoteIsOlder ? { scope: 'base-sha', mergeBase: pinned } : { scope: 'remote', mergeBase: remote }
  }
  if (remote) return { scope: 'remote', mergeBase: remote }
  if (pinned) return { scope: 'base-sha', mergeBase: pinned }
  return { scope: 'none', mergeBase: null }
}

/**
 * Build the report, or return null when there is no repository to report on.
 *
 * @param repo       the session checkout (`cfg.projectTarget`)
 * @param configDir  repo-relative config dir; refused unless plain
 * @param baseBranch the base branch; its remote-tracking ref is used only if it
 *                   already exists locally
 * @param opts.baseSha the base commit the session was created at
 *                   (`KORTIX_BASE_SHA`); used when it exists locally and is an
 *                   ancestor of HEAD
 */
export async function buildWorkspaceReport(
  repo: string,
  configDir: string,
  baseBranch: string,
  opts: { baseSha?: string } = {},
): Promise<WorkspaceReport | null> {
  if (!isPlainConfigDir(configDir)) throw new Error('config dir is not a plain relative path')
  if (!/^[\w./-]+$/.test(baseBranch) || baseBranch.startsWith('-') || baseBranch.includes('..')) {
    throw new Error('base branch name is not plain')
  }
  const head = await git(repo, ['rev-parse', '--verify', '-q', 'HEAD^{commit}'])
  if (head.code !== 0) return null
  const headSha = head.stdout.trim()
  const formatResult = await git(repo, ['rev-parse', '--show-object-format'])
  const format: 'sha1' | 'sha256' = formatResult.stdout.trim() === 'sha256' ? 'sha256' : 'sha1'

  const changes = new Map<string, WorkspaceChangeStatus>()

  // Committed work since the point the session branched from the base. No
  // fetch, so only commits this box already holds can serve as that point.
  const { scope, mergeBase } = await resolveCommittedBase(repo, baseBranch, opts.baseSha)
  if (mergeBase) {
    const committed = await git(repo, [
      'diff', '--name-status', '-z', '--no-renames', `${mergeBase}..HEAD`, '--', configDir,
    ])
    if (committed.code !== 0) throw new Error(`git diff failed: ${committed.stderr.trim()}`)
    for (const row of parseNameStatus(committed.stdout)) changes.set(row.path, row.status)
  }

  // Uncommitted work: staged, unstaged and untracked. `--untracked-files=all`
  // lists an untracked directory file by file.
  const status = await git(repo, ['status', '--porcelain', '-z', '--untracked-files=all', '--', configDir])
  if (status.code !== 0) throw new Error(`git status failed: ${status.stderr.trim()}`)
  for (const row of parseStatus(status.stdout)) {
    const committed = changes.get(row.path)
    // Relative to the merge base, a file the session's commits added is still
    // added after a later edit.
    changes.set(row.path, committed === 'added' && row.status !== 'deleted' ? 'added' : row.status)
  }

  // The API refuses a report over MAX_WORKSPACE_REPORT_ENTRIES (5,000). A
  // truncated report still shows session work, which is all the mode needs.
  const paths = [...changes.keys()].sort().slice(0, MAX_REPORT_ENTRIES)
  const blobs = await worktreeBlobs(repo, paths, format)
  const changed: WorkspaceChange[] = paths.map((path) => {
    const blob = blobs.get(path) ?? null
    const listed = changes.get(path)!
    // The working tree is the truth for the blob: a committed file that was
    // removed afterwards is deleted, whatever the history says.
    const statusOut: WorkspaceChangeStatus = blob === null ? 'deleted' : listed === 'deleted' ? 'modified' : listed
    return { path, status: statusOut, blob }
  })
  return { head: headSha, config_dir: configDir, committed_scope: scope, changed }
}
