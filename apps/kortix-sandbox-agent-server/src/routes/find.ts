import { Hono } from 'hono'
import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs/promises'

import type { Config } from '../config'
import { logger } from '../logger'
import { runGit } from '../git'

/**
 * Search routes — the daemon owns find too (was forwarded to OpenCode).
 *
 *   GET /find/file?query=&type=&limit=  → string[] of workspace-relative paths
 *   GET /find?pattern=                  → FindMatch[] (ripgrep, Node fallback)
 *
 * Mounted at `/find`. File listing uses `git ls-files` (respects .gitignore)
 * with a plain directory-walk fallback for non-git workspaces. Text search
 * prefers `rg --json`; if ripgrep isn't on PATH it falls back to a Node walk so
 * search degrades gracefully on images that predate the ripgrep bake.
 */

const MAX_FILES = 20_000
const MAX_TEXT_MATCHES = 500
const WALK_SKIP = new Set(['.git', 'node_modules', '.next', 'dist', 'build', '.turbo'])

type FindMatch = {
  path: string
  lines: string
  line_number: number
  absolute_offset: number
  submatches: Array<{ start: number; end: number }>
}

/** Run a command, capturing stdout. Resolves {code:-1} if the binary is missing. */
function runCmd(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<{ code: number; stdout: string; missing: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'ignore'] })
    let stdout = ''
    let missing = false
    const timer = opts.timeoutMs
      ? setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs)
      : undefined
    child.stdout?.on('data', (d) => (stdout += d.toString()))
    child.on('error', (e) => {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') missing = true
      if (timer) clearTimeout(timer)
      resolve({ code: -1, stdout, missing })
    })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      resolve({ code: code ?? 0, stdout, missing })
    })
  })
}

/** All non-ignored file paths (workspace-relative). git ls-files when possible. */
async function listAllFiles(workspace: string): Promise<string[]> {
  const res = await runGit(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: workspace,
  })
  if (res.code === 0 && res.stdout) {
    return res.stdout.split('\0').filter(Boolean).slice(0, MAX_FILES)
  }
  // Non-git fallback: walk, skipping VCS/dependency dirs.
  const out: string[] = []
  async function walk(dir: string): Promise<void> {
    if (out.length >= MAX_FILES) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (out.length >= MAX_FILES) return
      if (e.isDirectory() && WALK_SKIP.has(e.name)) continue
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) await walk(abs)
      else if (e.isFile()) out.push(path.relative(workspace, abs))
    }
  }
  await walk(workspace)
  return out
}

/** Parent directories implied by a set of file paths. */
function dirsFromFiles(files: string[]): string[] {
  const dirs = new Set<string>()
  for (const f of files) {
    const parts = f.split('/')
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'))
  }
  return [...dirs]
}

/** Fuzzy rank: substring beats subsequence; shorter paths win ties. 0 = no match. */
function fuzzyScore(candidate: string, query: string): number {
  if (!query) return 1
  const c = candidate.toLowerCase()
  const q = query.toLowerCase()
  const idx = c.indexOf(q)
  if (idx >= 0) return 10_000 - idx - candidate.length // substring
  // subsequence
  let ci = 0
  for (let qi = 0; qi < q.length; qi++) {
    ci = c.indexOf(q[qi]!, ci)
    if (ci < 0) return 0
    ci++
  }
  return 1_000 - candidate.length
}

export function createFindRouter(cfg: Config): Hono {
  const app = new Hono()
  const workspace = cfg.workspace || '/workspace'

  // GET /find/file?query=&type=file|directory&limit=N → string[] of paths.
  app.get('/file', async (c) => {
    const query = c.req.query('query') ?? ''
    const type = c.req.query('type')
    const limit = Math.min(parseInt(c.req.query('limit') || '100', 10) || 100, 1000)

    const files = await listAllFiles(workspace)
    let candidates: string[]
    if (type === 'directory') candidates = dirsFromFiles(files)
    else if (type === 'file') candidates = files
    else candidates = [...files, ...dirsFromFiles(files)]

    const ranked = candidates
      .map((p) => ({ p, score: fuzzyScore(p, query) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((r) => r.p)
    return c.json(ranked)
  })

  // GET /find?pattern=<regex> → FindMatch[] (ripgrep JSON, Node fallback).
  app.get('/', async (c) => {
    const pattern = c.req.query('pattern')
    if (!pattern) return c.json({ error: 'pattern query parameter is required' }, 400)

    const rg = await runCmd(
      'rg',
      ['--json', '--max-count', '50', '--', pattern, '.'],
      { cwd: workspace, timeoutMs: 15_000 },
    )

    if (!rg.missing && (rg.code === 0 || rg.code === 1)) {
      const matches: FindMatch[] = []
      for (const line of rg.stdout.split('\n')) {
        if (!line || matches.length >= MAX_TEXT_MATCHES) break
        let obj: any
        try {
          obj = JSON.parse(line)
        } catch {
          continue
        }
        if (obj?.type !== 'match') continue
        const d = obj.data
        matches.push({
          path: d?.path?.text ?? '',
          lines: d?.lines?.text ?? '',
          line_number: d?.line_number ?? 0,
          absolute_offset: d?.absolute_offset ?? 0,
          submatches: (d?.submatches ?? []).map((s: any) => ({ start: s.start, end: s.end })),
        })
      }
      return c.json(matches)
    }

    // Fallback: Node walk + regex (ripgrep unavailable on this image).
    logger.info('[find] ripgrep unavailable — using Node text-search fallback')
    return c.json(await nodeTextSearch(workspace, pattern))
  })

  return app
}

/** Regex text search across non-ignored text files (ripgrep fallback). */
async function nodeTextSearch(workspace: string, pattern: string): Promise<FindMatch[]> {
  let re: RegExp
  try {
    re = new RegExp(pattern)
  } catch {
    re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  }
  const files = await listAllFiles(workspace)
  const matches: FindMatch[] = []
  for (const rel of files) {
    if (matches.length >= MAX_TEXT_MATCHES) break
    let buf: Buffer
    try {
      buf = await fs.readFile(path.join(workspace, rel))
    } catch {
      continue
    }
    if (buf.length > 2_000_000 || buf.includes(0)) continue // skip large/binary
    const text = buf.toString('utf8')
    const lines = text.split('\n')
    let offset = 0
    for (let i = 0; i < lines.length; i++) {
      const lineText = lines[i]!
      const m = re.exec(lineText)
      if (m) {
        matches.push({
          path: rel,
          lines: lineText,
          line_number: i + 1,
          absolute_offset: offset + m.index,
          submatches: [{ start: m.index, end: m.index + m[0].length }],
        })
        if (matches.length >= MAX_TEXT_MATCHES) break
      }
      offset += lineText.length + 1
    }
  }
  return matches
}
