/**
 * pi's answer to OpenCode's `/project/current` `vcs` field and `GET /vcs/diff`.
 *
 * The Changes tab reads both: it treats the project as tracked only when
 * `vcs === 'git'`, then reads `/vcs/diff?mode=branch`. pi used to answer `[]`
 * for every diff and omit `vcs`, so the tab was empty on every pi session.
 *
 * Same shape as OpenCode (`VcsFileDiff`): one row per file with a git-format
 * patch, `additions`, `deletions` and `status`.
 *
 * - `git`: the working tree against HEAD, plus untracked files.
 * - `branch` (default): the same, against the merge base of HEAD and the
 *   project's default branch, so committed work stays listed.
 */
import { runGit } from '@/lib/git/git'

export interface VcsFileDiff {
  file: string
  patch?: string
  additions: number
  deletions: number
  status: 'added' | 'deleted' | 'modified'
}

// ponytail: per-file and total byte caps; a file over budget keeps its counts and loses its patch.
const MAX_FILE_PATCH_BYTES = 512 * 1024
const MAX_TOTAL_PATCH_BYTES = 8 * 1024 * 1024
// ponytail: one `git diff --no-index` per untracked file; past the cap a file is listed with no patch or counts.
const MAX_UNTRACKED_PATCHES = 200
const GIT = ['-c', 'core.quotepath=false', '-c', 'core.autocrlf=false', '--no-optional-locks']

const git = (cwd: string, args: string[]) => runGit([...GIT, ...args], { cwd, timeoutMs: 30_000 })

export async function isGitRepo(cwd: string): Promise<boolean> {
  const r = await git(cwd, ['rev-parse', '--is-inside-work-tree']).catch(() => null)
  return r?.code === 0 && r.stdout.trim() === 'true'
}

/** The commit the diff compares against, or null when the repo has no HEAD yet. */
async function baseRef(cwd: string, mode: string, defaultBranch: string): Promise<string | null> {
  if ((await git(cwd, ['rev-parse', '--verify', 'HEAD'])).code !== 0) return null
  if (mode === 'branch') {
    for (const candidate of [`refs/remotes/origin/${defaultBranch}`, `refs/heads/${defaultBranch}`]) {
      const fork = await git(cwd, ['merge-base', candidate, 'HEAD'])
      if (fork.code === 0 && fork.stdout.trim()) return fork.stdout.trim()
    }
  }
  return 'HEAD'
}

/** +/- lines of a single-file patch, counted after its first hunk header. */
function countPatch(patch: string): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  let inHunk = false
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@')) inHunk = true
    else if (!inHunk) continue
    else if (line.startsWith('+')) additions++
    else if (line.startsWith('-')) deletions++
  }
  return { additions, deletions }
}

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

export async function vcsDiff(cwd: string, mode: string, defaultBranch: string): Promise<VcsFileDiff[]> {
  if (!(await isGitRepo(cwd))) return []
  const ref = (await baseRef(cwd, mode, defaultBranch)) ?? EMPTY_TREE
  const diff = (...flags: string[]) => git(cwd, ['diff', '--no-ext-diff', '--no-renames', ...flags, ref, '--', '.'])
  const [names, patches, untracked] = await Promise.all([
    diff('--name-status', '-z'),
    diff(),
    git(cwd, ['ls-files', '--others', '--exclude-standard', '-z', '--', '.']),
  ])
  if (names.code !== 0) throw new Error(`git diff failed: ${names.stderr.trim()}`)

  const fields = names.stdout.split('\0').filter(Boolean)
  const tracked: Array<{ file: string; status: VcsFileDiff['status'] }> = []
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const code = fields[i]!
    tracked.push({ file: fields[i + 1]!, status: code === 'A' ? 'added' : code === 'D' ? 'deleted' : 'modified' })
  }
  // `git diff` writes the patch in the same order as `--name-status`: one `diff --git` chunk per file.
  const chunks = patches.code === 0 ? patches.stdout.split(/^(?=diff --git )/m).filter(Boolean) : []
  const chunkFor = (i: number) => (chunks.length === tracked.length ? chunks[i] : undefined)

  let budget = MAX_TOTAL_PATCH_BYTES
  const finish = (file: string, status: VcsFileDiff['status'], raw: string | undefined): VcsFileDiff => {
    // A binary or mode-only change has no hunk to render.
    const patch = raw && /^@@/m.test(raw) ? raw : undefined
    const counts = patch ? countPatch(patch) : { additions: 0, deletions: 0 }
    const bytes = patch ? Buffer.byteLength(patch) : 0
    const keep = patch !== undefined && bytes <= MAX_FILE_PATCH_BYTES && bytes <= budget
    if (keep) budget -= bytes
    return { file, status, additions: counts.additions, deletions: counts.deletions, ...(keep ? { patch } : {}) }
  }

  const rows = tracked.map((t, i) => finish(t.file, t.status, chunkFor(i)))
  const newFiles = untracked.code === 0 ? untracked.stdout.split('\0').filter(Boolean) : []
  for (const [i, file] of newFiles.entries()) {
    if (i >= MAX_UNTRACKED_PATCHES) {
      rows.push(finish(file, 'added', undefined))
      continue
    }
    // Exit 1 means "files differ", the normal answer here.
    const r = await git(cwd, ['diff', '--no-ext-diff', '--no-index', '--', '/dev/null', file])
    rows.push(finish(file, 'added', r.code <= 1 && r.stdout ? r.stdout : undefined))
  }
  return rows.sort((a, b) => a.file.localeCompare(b.file))
}
