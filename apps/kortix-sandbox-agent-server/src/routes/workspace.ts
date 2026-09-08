import { Hono } from 'hono'
import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import type { Config } from '../config'
import { runGit } from '../git'

type FileChange = {
  file: string
  additions: number
  deletions: number
  status: 'added' | 'deleted' | 'modified'
  patch?: string
}

const MAX_PATCH_BYTES = 8 * 1024 * 1024

export function createWorkspaceRouter(cfg: Config): Hono {
  const app = new Hono()
  const workspace = resolve(cfg.workspace)
  let applying = false
  const git = (args: string[], input?: string) => runGit(
    ['--literal-pathspecs', '-c', 'core.quotePath=false', ...args],
    { cwd: workspace, input, maxOutputBytes: MAX_PATCH_BYTES },
  )
  const requireGit = async (args: string[], input?: string) => {
    const result = await git(args, input)
    if (result.code !== 0) throw new Error(result.stderr.trim() || 'Git command failed')
    return result.stdout
  }
  const isGit = async () => (await git(['rev-parse', '--is-inside-work-tree'])).stdout.trim() === 'true'
  const head = async () => {
    const result = await git(['rev-parse', '--verify', 'HEAD'])
    return result.code === 0 ? result.stdout.trim() : (await requireGit(['hash-object', '-t', 'tree', '--stdin'], '')).trim()
  }
  const base = async (mode: string) => {
    if (mode === 'git') return head()
    for (const ref of [`refs/remotes/origin/${cfg.defaultBranch}`, `refs/heads/${cfg.defaultBranch}`]) {
      const result = await git(['merge-base', 'HEAD', ref])
      if (result.code === 0) return result.stdout.trim()
    }
    if ((await git(['rev-parse', '--verify', 'HEAD'])).code !== 0) return head()
    throw new Error(`The default branch ${cfg.defaultBranch} is unavailable for comparison`)
  }
  const changes = async (mode: string, patches: boolean, context = 3): Promise<FileChange[]> => {
    if (!await isGit()) return []
    const ref = await base(mode)
    const options = ['diff', '--no-ext-diff', '--no-textconv', '--no-renames']
    const statuses = (await requireGit([...options, '--name-status', '-z', ref, '--'])).split('\0')
    const counts = new Map<string, [number, number]>()
    for (const record of (await requireGit([...options, '--numstat', '-z', ref, '--'])).split('\0')) {
      const match = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(record)
      if (match) counts.set(match[3]!, [Number(match[1]) || 0, Number(match[2]) || 0])
    }
    const result: FileChange[] = []
    for (let i = 0; i + 1 < statuses.length; i += 2) {
      const file = statuses[i + 1]!
      const [additions, deletions] = counts.get(file) ?? [0, 0]
      result.push({ file, additions, deletions, status: statuses[i] === 'A' ? 'added' : statuses[i] === 'D' ? 'deleted' : 'modified' })
    }
    const untracked = (await requireGit(['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean)
    for (const file of untracked) {
      const diff = await git([...options, '--numstat', '-z', '--no-index', '--', '/dev/null', file])
      if (diff.code !== 0 && diff.code !== 1) throw new Error(diff.stderr || 'Cannot read untracked file')
      const count = /^(\d+|-)\t(\d+|-)\t/.exec(diff.stdout)
      result.push({ file, additions: Number(count?.[1]) || 0, deletions: 0, status: 'added' })
    }
    if (patches) {
      let bytes = 0
      for (const entry of result) {
        const args = [...options, '--binary', `--unified=${context}`, '--src-prefix=a/', '--dst-prefix=b/']
        const diff = await git(untracked.includes(entry.file)
          ? [...args, '--no-index', '--', '/dev/null', entry.file]
          : [...args, ref, '--', entry.file])
        if (diff.code !== 0 && diff.code !== 1) throw new Error(diff.stderr || 'Cannot read patch')
        bytes += Buffer.byteLength(diff.stdout)
        if (bytes > MAX_PATCH_BYTES) throw new Error('Workspace diff exceeds the 8 MiB response limit')
        entry.patch = diff.stdout
      }
    }
    return result.sort((a, b) => a.file.localeCompare(b.file))
  }
  const project = async () => {
    const info = await stat(workspace)
    return {
      id: cfg.projectId || createHash('sha256').update(workspace).digest('hex'),
      worktree: workspace,
      ...(await isGit() ? { vcs: 'git' } : {}),
      name: basename(workspace),
      time: { created: info.birthtimeMs, updated: info.mtimeMs },
      sandboxes: [],
    }
  }

  app.use('*', async (c, next) => {
    const directory = c.req.query('directory')
    if (directory && resolve(workspace, directory) !== workspace) {
      return c.json({ error: 'This environment serves its configured workspace' }, 400)
    }
    return next()
  })
  app.onError((error, c) => c.json({ error: error.message }, 409))
  app.get('/project', async (c) => c.json([await project()]))
  app.get('/project/current', async (c) => c.json(await project()))
  app.get('/path', (c) => c.json({
    home: homedir(), state: join(homedir(), '.local/share/kortix'),
    config: join(homedir(), '.config/kortix'), worktree: workspace, directory: workspace,
  }))
  app.get('/vcs', async (c) => {
    if (!await isGit()) return c.json({})
    const branch = await git(['symbolic-ref', '--short', '-q', 'HEAD'])
    return c.json({ ...(branch.code === 0 ? { branch: branch.stdout.trim() } : {}), default_branch: cfg.defaultBranch })
  })
  app.get('/vcs/status', async (c) => c.json(await changes('git', false)))
  app.get('/vcs/diff', async (c) => {
    const mode = c.req.query('mode') || 'git'
    const context = Number(c.req.query('context') ?? 3)
    if (!['git', 'branch'].includes(mode) || !Number.isInteger(context) || context < 0 || context > 10000) {
      return c.json({ error: 'Invalid diff mode or context' }, 400)
    }
    return c.json(await changes(mode, true, context))
  })
  app.get('/vcs/diff/raw', async (c) => c.json((await changes('git', true)).map((change) => change.patch).join('')))
  app.post('/vcs/apply', async (c) => {
    const body = await c.req.json().catch(() => null)
    if (typeof body?.patch !== 'string' || !body.patch || Buffer.byteLength(body.patch) > MAX_PATCH_BYTES) {
      return c.json({ error: 'patch must be a nonempty string of at most 8 MiB' }, 400)
    }
    if (applying) return c.json({ error: 'A patch is already being applied' }, 409)
    applying = true
    try {
      if (!await isGit()) return c.json({ name: 'VcsApplyError', data: { reason: 'non-git', message: 'Workspace is not a Git repository' } }, 400)
      const dirty = await requireGit(['status', '--porcelain', '-z', '--untracked-files=all'])
      if (dirty) return c.json({ name: 'VcsApplyError', data: { reason: 'not-clean', message: 'Workspace has uncommitted changes' } }, 400)
      const check = await git(['apply', '--check', '--whitespace=nowarn', '-'], body.patch)
      if (check.code !== 0) return c.json({ error: 'Patch cannot be applied', message: check.stderr }, 400)
      await requireGit(['apply', '--whitespace=nowarn', '-'], body.patch)
      return c.json({ applied: true })
    } finally {
      applying = false
    }
  })
  return app
}
