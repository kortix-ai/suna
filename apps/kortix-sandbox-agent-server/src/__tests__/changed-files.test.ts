import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { collectChangedFiles } from '../acp/changed-files'

const noneIgnored = async () => new Set<string>()

describe('collectChangedFiles', () => {
  let ws: string
  beforeAll(async () => { ws = await fs.mkdtemp(path.join(os.tmpdir(), 'kortix-changed-')) })
  afterAll(async () => { await fs.rm(ws, { recursive: true, force: true }) })

  it('includes files modified at/after since, newest-first, excludes older', async () => {
    const t0 = Date.now()
    await fs.writeFile(path.join(ws, 'old.txt'), 'x')
    await fs.utimes(path.join(ws, 'old.txt'), new Date(t0 - 60_000), new Date(t0 - 60_000))
    await fs.mkdir(path.join(ws, 'out'), { recursive: true })
    await fs.writeFile(path.join(ws, 'out/report.pdf'), 'x')
    await fs.writeFile(path.join(ws, 'data.csv'), 'x')
    const res = await collectChangedFiles(ws, t0 - 5_000, noneIgnored)
    const paths = res.files.map((f) => f.path)
    expect(paths).toContain('out/report.pdf')
    expect(paths).toContain('data.csv')
    expect(paths).not.toContain('old.txt')
    expect(res.truncated).toBe(false)
    const mtimes = res.files.map((f) => f.mtime)
    expect([...mtimes].sort((a, b) => b - a)).toEqual(mtimes)
    expect(res.files[0]!.absolute).toBe(path.join(ws, res.files[0]!.path))
    expect(res.files[0]!.size).toBeGreaterThan(0)
  })

  it('skips hidden segments, node_modules/__pycache__/venv, and lockfiles', async () => {
    for (const p of ['.secret/x.txt', 'node_modules/a/x.js', '__pycache__/x.pyc', 'venv/x.py']) {
      await fs.mkdir(path.dirname(path.join(ws, p)), { recursive: true })
      await fs.writeFile(path.join(ws, p), 'x')
    }
    await fs.writeFile(path.join(ws, '.env'), 'SECRET=1')
    await fs.writeFile(path.join(ws, 'pnpm-lock.yaml'), 'x')
    const res = await collectChangedFiles(ws, 0, noneIgnored)
    const paths = res.files.map((f) => f.path)
    for (const banned of ['.secret/x.txt', 'node_modules/a/x.js', '__pycache__/x.pyc', 'venv/x.py', '.env', 'pnpm-lock.yaml']) {
      expect(paths).not.toContain(banned)
    }
  })

  it('excludes gitignored paths via the injected isIgnored', async () => {
    await fs.mkdir(path.join(ws, 'dist'), { recursive: true })
    await fs.writeFile(path.join(ws, 'dist/site.html'), 'x')
    const ignoring = async (abs: string[]) => new Set(abs.filter((p) => p.includes('/dist/')))
    const res = await collectChangedFiles(ws, 0, ignoring)
    expect(res.files.map((f) => f.path)).not.toContain('dist/site.html')
    const kept = await collectChangedFiles(ws, 0, noneIgnored)
    expect(kept.files.map((f) => f.path)).toContain('dist/site.html')
  })

  it('never follows symlinks and reports only regular files', async () => {
    await fs.mkdir(path.join(ws, 'real'), { recursive: true })
    await fs.writeFile(path.join(ws, 'real/target.txt'), 'x')
    await fs.symlink(path.join(ws, 'real/target.txt'), path.join(ws, 'alias.txt'))
    await fs.symlink(path.join(ws, 'real'), path.join(ws, 'aliasdir'))
    const res = await collectChangedFiles(ws, 0, noneIgnored)
    const paths = res.files.map((f) => f.path)
    expect(paths).not.toContain('alias.txt')
    expect(paths.some((p) => p.startsWith('aliasdir/'))).toBe(false)
    expect(paths).toContain('real/target.txt')
  })

  it('caps results and sets truncated', async () => {
    const many = await fs.mkdtemp(path.join(os.tmpdir(), 'kortix-changed-many-'))
    for (let i = 0; i < 20; i++) await fs.writeFile(path.join(many, `f${i}.txt`), 'x')
    const res = await collectChangedFiles(many, 0, noneIgnored, { maxResults: 5 })
    expect(res.files.length).toBe(5)
    expect(res.truncated).toBe(true)
    const visited = await collectChangedFiles(many, 0, noneIgnored, { maxVisited: 3 })
    expect(visited.truncated).toBe(true)
    await fs.rm(many, { recursive: true, force: true })
  })

  it('skips unreadable subtrees while siblings survive', async () => {
    const tree = await fs.mkdtemp(path.join(os.tmpdir(), 'kortix-changed-unread-'))
    await fs.mkdir(path.join(tree, 'locked'))
    await fs.writeFile(path.join(tree, 'locked/hidden.txt'), 'x')
    await fs.writeFile(path.join(tree, 'ok.txt'), 'x')
    await fs.chmod(path.join(tree, 'locked'), 0o000)
    try {
      const res = await collectChangedFiles(tree, 0, noneIgnored)
      expect(res.files.map((f) => f.path)).toContain('ok.txt')
    } finally {
      await fs.chmod(path.join(tree, 'locked'), 0o755)
      await fs.rm(tree, { recursive: true, force: true })
    }
  })
})
