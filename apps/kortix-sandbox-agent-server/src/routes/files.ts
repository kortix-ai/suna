import { Hono } from 'hono'
import path from 'node:path'
import fs from 'node:fs/promises'
import crypto from 'node:crypto'

import type { Config } from '../config'
import { logger } from '../logger'
import { runGit } from '../git'
import { isLikelyBinary, mimeTypeFor } from '../file-mime'

/**
 * The daemon owns the entire file API — direct sandbox filesystem access.
 *
 * Reads (GET /file list, /file/content, /file/raw, /file/status) and writes
 * (upload, delete, mkdir, rename) are all served here. We deliberately do NOT
 * forward file reads to OpenCode: its /file/content is editor-oriented and
 * base64-inlines IMAGES only — every other binary (Office docs, PDFs, archives,
 * sqlite, …) comes back as { type:"binary", content:"" } with no bytes, so
 * previews and downloads were 0-byte/corrupt. Serving reads off disk here fixes
 * that and gives one coherent contract. (Text-search/find lives in find.ts.)
 *
 * Mounted at `/file`. Workspace identity is fixed by the ACP session cwd and
 * health is owned by `/kortix/health`; neither depends on a harness API.
 *
 * Security: every path is resolved to an absolute path and validated against
 * ALLOWED_ROOTS before any filesystem operation (no traversal escapes).
 */

const DEFAULT_ALLOWED_ROOTS = ['/workspace', '/opt', '/tmp', '/home']

/**
 * Which of `absPaths` are git-ignored. Uses `git check-ignore -z --stdin` (NUL
 * I/O so paths with spaces/newlines are safe). Returns an empty set when the
 * workspace isn't a git repo (check-ignore exits 128) — runGit never throws on
 * non-zero, so we just parse whatever matched.
 */
async function gitIgnoredSet(workspace: string, absPaths: string[]): Promise<Set<string>> {
  const set = new Set<string>()
  if (!absPaths.length) return set
  const res = await runGit(['check-ignore', '-z', '--stdin'], {
    cwd: workspace,
    input: absPaths.join('\0'),
  })
  for (const p of res.stdout.split('\0')) {
    if (p) set.add(p)
  }
  return set
}

/** Count text lines in a file (best-effort; 0 for binary, empty, or >5MB). */
async function countTextLines(absPath: string): Promise<number> {
  try {
    const buf = await fs.readFile(absPath)
    if (buf.length === 0 || buf.length > 5_000_000 || buf.includes(0)) return 0
    let n = 0
    for (let i = 0; i < buf.length; i++) if (buf[i] === 10) n++
    return buf[buf.length - 1] === 10 ? n : n + 1
  } catch {
    return 0
  }
}

type GitFileStatus = {
  path: string
  added: number
  removed: number
  status: 'added' | 'deleted' | 'modified'
}

/**
 * Uncommitted changes as GitFileStatus[] — matches OpenCode's `file.status`
 * shape. status enum from `git status --porcelain`; added/removed line counts
 * from `git diff --numstat HEAD` (tracked) + line-count for untracked files.
 * Returns [] when not a git repo.
 */
async function gitWorkingStatus(workspace: string): Promise<GitFileStatus[]> {
  const st = await runGit(['-c', 'core.quotePath=false', 'status', '--porcelain', '-uall'], {
    cwd: workspace,
  })
  if (st.code !== 0) return []
  const lines = st.stdout.split('\n').filter(Boolean)
  if (!lines.length) return []

  // Line counts vs HEAD (covers staged + unstaged for tracked files).
  const counts = new Map<string, { added: number; removed: number }>()
  const diff = await runGit(['-c', 'core.quotePath=false', 'diff', '--numstat', 'HEAD'], {
    cwd: workspace,
  })
  if (diff.code === 0) {
    for (const l of diff.stdout.split('\n').filter(Boolean)) {
      const parts = l.split('\t')
      if (parts.length >= 3) {
        const added = parts[0] === '-' ? 0 : parseInt(parts[0]!, 10) || 0
        const removed = parts[1] === '-' ? 0 : parseInt(parts[1]!, 10) || 0
        counts.set(parts.slice(2).join('\t'), { added, removed })
      }
    }
  }

  const out: GitFileStatus[] = []
  for (const line of lines) {
    const x = line[0]
    const y = line[1]
    let p = line.slice(3)
    const arrow = p.indexOf(' -> ') // rename: "orig -> new"
    if (arrow >= 0) p = p.slice(arrow + 4)
    const untracked = line.startsWith('??')
    const status: GitFileStatus['status'] =
      x === 'D' || y === 'D' ? 'deleted' : x === 'A' || untracked ? 'added' : 'modified'
    let c = counts.get(p)
    if (!c) {
      c = untracked ? { added: await countTextLines(path.join(workspace, p)), removed: 0 } : { added: 0, removed: 0 }
    }
    out.push({ path: p, added: c.added, removed: c.removed, status })
  }
  return out
}

export function createFilesRouter(cfg: Config): Hono {
  const app = new Hono()
  const workspace = cfg.workspace || '/workspace'
  // The configured workspace is always writable, even when it isn't the
  // canonical /workspace (e.g. a non-default KORTIX_WORKSPACE, or tests).
  const allowedRoots = Array.from(new Set([path.resolve(workspace), ...DEFAULT_ALLOWED_ROOTS]))

  /**
   * Resolve + validate a path. Relative paths resolve against the workspace.
   * Throws if the resolved path escapes the allowed roots.
   */
  function resolvePath(raw: string): string {
    const resolved = path.isAbsolute(raw)
      ? path.resolve(raw)
      : path.resolve(workspace, raw)
    if (!allowedRoots.some((root) => resolved === root || resolved.startsWith(root + '/'))) {
      throw new Error('Access denied: path outside allowed directories')
    }
    return resolved
  }

  /** Short high-entropy suffix (~12 chars) for disambiguating filenames. */
  function uniqueSuffix(): string {
    const ts = Date.now().toString(36)
    const rnd = crypto.randomBytes(4).toString('hex')
    return `${ts}-${rnd}`
  }

  /**
   * Insert a unique suffix before the file extension.
   *   foo.txt → foo-<suffix>.txt   README → README-<suffix>   .env → .env-<suffix>
   */
  function withSuffix(dest: string, suffix: string): string {
    const dir = path.dirname(dest)
    const ext = path.extname(dest)
    const base = path.basename(dest, ext)
    const prefix = dir === '.' || dir === '' ? '' : `${dir}/`
    return `${prefix}${base}-${suffix}${ext}`
  }

  /**
   * Atomically write to `dest`, never overwriting an existing file. Uses the
   * POSIX `wx` flag (O_CREAT | O_EXCL) so concurrent uploads can't clobber
   * each other; on collision the filename is suffixed and the write retried.
   * Returns the path the bytes actually landed at.
   */
  async function writeUploadUnique(dest: string, buffer: ArrayBuffer): Promise<string> {
    const data = Buffer.from(buffer)
    await fs.mkdir(path.dirname(resolvePath(dest)), { recursive: true })

    let attempt = dest
    for (let i = 0; i < 6; i++) {
      try {
        await fs.writeFile(resolvePath(attempt), data, { flag: 'wx' })
        return resolvePath(attempt)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
        attempt = withSuffix(dest, uniqueSuffix())
      }
    }

    attempt = withSuffix(dest, crypto.randomUUID())
    await fs.writeFile(resolvePath(attempt), data, { flag: 'wx' })
    return resolvePath(attempt)
  }

  // GET /file/raw?path=<path> — stream a file's RAW bytes off disk.
  //
  // OpenCode's read-only /file/content endpoint base64-encodes IMAGES only;
  // every other binary type (xlsx, pptx, docx, pdf, zip, …) comes back as
  // { type: "binary", content: "" } with NO bytes, so downloads and previews
  // of Office docs were 0-byte / corrupt. The daemon has direct filesystem
  // access (it already serves uploads), so it serves the real bytes here.
  // The web/mobile clients and the pptx Office Online viewer already target
  // this route — it just never existed until now.
  app.get('/raw', async (c) => {
    const raw = c.req.query('path')
    if (!raw) return c.json({ error: 'path query parameter is required' }, 400)

    let resolved: string
    try {
      resolved = resolvePath(raw)
    } catch (err) {
      return c.json({ error: (err as Error).message }, 403)
    }

    const stat = await fs.stat(resolved).catch(() => null)
    if (!stat) return c.json({ error: 'File not found' }, 404)
    if (stat.isDirectory()) return c.json({ error: 'Path is a directory' }, 400)

    let data: Buffer
    try {
      data = await fs.readFile(resolved)
    } catch (err) {
      logger.warn('[files] raw read failed', { path: resolved, error: (err as Error).message })
      return c.json({ error: (err as Error).message }, 500)
    }

    // fs.readFile returns an exact-sized Buffer (a Uint8Array view) — a valid
    // BodyInit, sent verbatim. Never text/html, so clients don't mistake it
    // for the SPA shell and reject it.
    return new Response(data, {
      status: 200,
      headers: {
        'Content-Type': mimeTypeFor(resolved, true),
        'Content-Length': String(stat.size),
        'Cache-Control': 'no-store',
      },
    })
  })

  // GET /file/content?path=<path> — read a file as JSON FileContent.
  //
  // Correct for ALL types: text → utf8 string; binary (Office docs, PDFs,
  // images, archives, sqlite, …) → base64 with encoding:'base64'. This replaces
  // OpenCode's editor-oriented /file/content, which returned empty content for
  // every non-image binary. Binary classification = known binary extension OR a
  // NUL byte in the first 8KB (git's heuristic).
  app.get('/content', async (c) => {
    const raw = c.req.query('path')
    if (!raw) return c.json({ error: 'path query parameter is required' }, 400)

    let resolved: string
    try {
      resolved = resolvePath(raw)
    } catch (err) {
      return c.json({ error: (err as Error).message }, 403)
    }

    const stat = await fs.stat(resolved).catch(() => null)
    if (!stat) return c.json({ error: 'File not found' }, 404)
    if (stat.isDirectory()) return c.json({ error: 'Path is a directory' }, 400)

    let data: Buffer
    try {
      data = await fs.readFile(resolved)
    } catch (err) {
      logger.warn('[files] content read failed', { path: resolved, error: (err as Error).message })
      return c.json({ error: (err as Error).message }, 500)
    }

    const binary = isLikelyBinary(data, resolved)
    if (binary) {
      return c.json({
        type: 'binary',
        content: data.toString('base64'),
        encoding: 'base64',
        mimeType: mimeTypeFor(resolved, true),
        size: stat.size,
      })
    }
    return c.json({
      type: 'text',
      content: data.toString('utf8'),
      mimeType: mimeTypeFor(resolved, false),
      size: stat.size,
    })
  })

  // GET /file?path=<dir> — list a directory as FileNode[] (worktree-relative
  // `path`, absolute `absolute`, `ignored` from git). Mirrors OpenCode's list.
  app.get('/', async (c) => {
    const raw = c.req.query('path') ?? '.'

    let resolved: string
    try {
      resolved = resolvePath(raw)
    } catch (err) {
      return c.json({ error: (err as Error).message }, 403)
    }

    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(resolved, { withFileTypes: true })
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return c.json({ error: 'Directory not found' }, 404)
      if (code === 'ENOTDIR') return c.json({ error: 'Path is not a directory' }, 400)
      return c.json({ error: (err as Error).message }, 500)
    }

    // Directories first, then alphabetical — matches typical explorer ordering.
    entries.sort((a, b) => {
      const ad = a.isDirectory() ? 0 : 1
      const bd = b.isDirectory() ? 0 : 1
      return ad - bd || a.name.localeCompare(b.name)
    })

    const absolutes = entries.map((e) => path.join(resolved, e.name))
    const ignored = await gitIgnoredSet(workspace, absolutes)

    const nodes = entries.map((e, i) => {
      const absolute = absolutes[i]!
      const rel = path.relative(workspace, absolute)
      return {
        name: e.name,
        path: rel,
        absolute,
        type: e.isDirectory() ? 'directory' : 'file',
        // .git is never gitignored but should never surface as a normal folder.
        ignored: ignored.has(absolute) || e.name === '.git',
      }
    })
    return c.json(nodes)
  })

  // GET /file/status — uncommitted changes as GitFileStatus[] (path, added,
  // removed, status). Empty when the workspace isn't a git repo.
  app.get('/status', async (c) => {
    try {
      return c.json(await gitWorkingStatus(workspace))
    } catch (err) {
      logger.warn('[files] status failed', { error: (err as Error).message })
      return c.json([])
    }
  })

  // POST /file/upload — upload one or more files via multipart form data.
  //
  // Two client conventions are supported (see apps/web opencode-files.ts):
  //   1. a `path` form field naming the target directory + a `file` field, or
  //   2. the field NAME itself is the destination path (field-name-as-path).
  // Returns [{ path, size }] with the actual on-disk path (post collision
  // resolution) so the client can reference exactly where the bytes landed.
  app.post('/upload', async (c) => {
    let body: Record<string, string | File | (string | File)[]>
    try {
      body = (await c.req.parseBody({ all: true })) as typeof body
    } catch (err) {
      logger.warn('[files] upload parseBody failed', { error: (err as Error).message })
      return c.json({ error: 'Invalid multipart form data' }, 400)
    }

    const targetDir = typeof body['path'] === 'string' ? (body['path'] as string) : undefined
    const results: { path: string; size: number }[] = []

    try {
      for (const [key, value] of Object.entries(body)) {
        if (key === 'path') continue
        const files = Array.isArray(value) ? value : [value]
        for (const file of files) {
          if (typeof file === 'string') continue
          if (!(file instanceof globalThis.File)) continue
          const dest = targetDir
            ? `${targetDir}/${file.name}`
            : key === 'file' || key === 'file[]'
              ? file.name
              : key
          const buffer = await file.arrayBuffer()
          const actualPath = await writeUploadUnique(dest, buffer)
          results.push({ path: actualPath, size: buffer.byteLength })
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const denied = message.startsWith('Access denied')
      logger.warn('[files] upload write failed', { error: message })
      return c.json({ error: message }, denied ? 403 : 500)
    }

    if (!results.length) return c.json({ error: 'No files found in request body' }, 400)
    logger.info('[files] uploaded', { count: results.length, paths: results.map((r) => r.path) })
    return c.json(results)
  })

  // DELETE /file — recursively delete a file or directory.
  app.delete('/', async (c) => {
    let raw: string | undefined
    try {
      raw = (await c.req.json<{ path: string }>()).path
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }
    if (!raw) return c.json({ error: 'Missing path in request body' }, 400)

    let resolved: string
    try {
      resolved = resolvePath(raw)
    } catch (err) {
      return c.json({ error: (err as Error).message }, 403)
    }

    const stat = await fs.stat(resolved).catch(() => null)
    if (!stat) return c.json({ error: 'File not found' }, 404)

    await fs.rm(resolved, { recursive: true, force: true })
    logger.info('[files] deleted', { path: resolved })
    return c.json(true)
  })

  // POST /file/mkdir — create a directory (recursive, idempotent).
  app.post('/mkdir', async (c) => {
    let raw: string | undefined
    try {
      raw = (await c.req.json<{ path: string }>()).path
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }
    if (!raw) return c.json({ error: 'Missing path in request body' }, 400)

    let resolved: string
    try {
      resolved = resolvePath(raw)
    } catch (err) {
      return c.json({ error: (err as Error).message }, 403)
    }

    await fs.mkdir(resolved, { recursive: true })
    logger.info('[files] mkdir', { path: resolved })
    return c.json(true)
  })

  // POST /file/rename — rename or move a file/directory.
  app.post('/rename', async (c) => {
    let from: string | undefined
    let to: string | undefined
    try {
      const parsed = await c.req.json<{ from: string; to: string }>()
      from = parsed.from
      to = parsed.to
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }
    if (!from || !to) return c.json({ error: 'Missing from/to in request body' }, 400)

    let fromResolved: string
    let toResolved: string
    try {
      fromResolved = resolvePath(from)
    } catch (err) {
      return c.json({ error: `source: ${(err as Error).message}` }, 403)
    }
    try {
      toResolved = resolvePath(to)
    } catch (err) {
      return c.json({ error: `target: ${(err as Error).message}` }, 403)
    }

    const stat = await fs.stat(fromResolved).catch(() => null)
    if (!stat) return c.json({ error: 'Source file not found' }, 404)

    await fs.mkdir(path.dirname(toResolved), { recursive: true })
    await fs.rename(fromResolved, toResolved)
    logger.info('[files] renamed', { from: fromResolved, to: toResolved })
    return c.json(true)
  })

  return app
}
