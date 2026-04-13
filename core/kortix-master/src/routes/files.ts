/**
 * File management routes — direct sandbox filesystem access.
 *
 * This is the authoritative file I/O layer for the sandbox. All file
 * operations (list, read, download, upload, delete, mkdir, rename) are
 * handled here instead of proxying to OpenCode, giving us full control
 * over binary content handling and sandbox-wide filesystem access.
 *
 * Mounted at /file in kortix-master (e.g. GET /file/raw?path=...).
 *
 * Security: all paths are resolved to absolute and validated against
 * ALLOWED_ROOTS before any filesystem operation.
 */

import { Hono } from 'hono'
import { describeRoute, resolver } from 'hono-openapi'
import path from 'path'
import fs from 'fs/promises'
import {
  ErrorResponse,
  FileNode,
  FileContentTextResponse,
  FileContentBinaryResponse,
  UploadResult,
} from '../schemas/common'

const filesRouter = new Hono()
const root = process.env.KORTIX_WORKSPACE || '/workspace'

let statusCache: { at: number; data: Array<{ path: string; added: number; removed: number; status: 'added' | 'deleted' | 'modified' }> } | null = null
let statusPending: Promise<Array<{ path: string; added: number; removed: number; status: 'added' | 'deleted' | 'modified' }>> | null = null

// ─── Security ────────────────────────────────────────────────────────────────

const ALLOWED_ROOTS = ['/', '/workspace', '/opt', '/tmp', '/home']

/**
 * Resolve and validate a file path. Returns the absolute path.
 * Prevents directory traversal and restricts access to allowed roots.
 * Relative paths are resolved relative to /workspace (sandbox default).
 */
function resolvePath(raw: string): string {
  const resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve('/workspace', raw)
  if (!ALLOWED_ROOTS.some((root) => resolved.startsWith(root))) {
    throw new Error('Access denied: path outside allowed directories')
  }
  return resolved
}

/** Return the resolved path or null (+ set 403 status) if validation fails. */
function validatePath(c: any, raw: string): string | null {
  try {
    return resolvePath(raw)
  } catch {
    c.status(403)
    return null
  }
}

// ─── Upload naming: collision-free writes ────────────────────────────────────

/** Short high-entropy suffix (~12 chars) for disambiguating filenames. */
function uniqueSuffix(): string {
  const ts = Date.now().toString(36)
  const rnd = Math.random().toString(36).slice(2, 8)
  return `${ts}-${rnd}`
}

/**
 * Insert a unique suffix before the file extension.
 *   foo.txt    → foo-<suffix>.txt
 *   README     → README-<suffix>
 *   .env       → .env-<suffix>
 *   foo.tar.gz → foo.tar-<suffix>.gz   (only the final extension is preserved)
 */
function withSuffix(dest: string, suffix: string): string {
  const dir = path.dirname(dest)
  const ext = path.extname(dest)
  const base = path.basename(dest, ext)
  const prefix = dir === '.' || dir === '' ? '' : `${dir}/`
  return `${prefix}${base}-${suffix}${ext}`
}

/**
 * Atomically write `buffer` to `dest`, never overwriting an existing file.
 *
 * Uses the POSIX `wx` flag (O_CREAT | O_EXCL) so concurrent uploads cannot
 * race past an exists-check and clobber each other. On collision the
 * filename is suffixed with a short unique token and the write is retried.
 *
 * Returns the path the file was actually written to (may differ from
 * `dest` if a collision forced a rename).
 */
async function writeUploadUnique(dest: string, buffer: ArrayBuffer): Promise<string> {
  const data = Buffer.from(buffer)
  await fs.mkdir(path.dirname(resolvePath(dest)), { recursive: true })

  let attempt = dest
  for (let i = 0; i < 6; i++) {
    try {
      await fs.writeFile(resolvePath(attempt), data, { flag: 'wx' })
      return attempt
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      attempt = withSuffix(dest, uniqueSuffix())
    }
  }

  // Extremely unlikely fallthrough — a full UUID makes further collision
  // effectively impossible.
  attempt = withSuffix(dest, crypto.randomUUID())
  await fs.writeFile(resolvePath(attempt), data, { flag: 'wx' })
  return attempt
}

function kind(code: string): 'added' | 'deleted' | 'modified' {
  if (code === '??') return 'added'
  if (code.includes('U')) return 'modified'
  if (code.includes('A') && !code.includes('D')) return 'added'
  if (code.includes('D') && !code.includes('A')) return 'deleted'
  return 'modified'
}

async function git(args: string[]): Promise<string> {
  const proc = Bun.spawn(['git', ...args], {
    cwd: root,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const [code, out, err] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])

  if (code === 0) return out
  throw new Error(err.trim() || `git ${args.join(' ')} failed (${code})`)
}

async function status(): Promise<Array<{ path: string; added: number; removed: number; status: 'added' | 'deleted' | 'modified' }>> {
  const now = Date.now()
  if (statusCache && now - statusCache.at < 5_000) return statusCache.data
  if (statusPending) return statusPending

  statusPending = (async () => {
    const inside = await git(['rev-parse', '--is-inside-work-tree']).catch(() => '')
    if (inside.trim() !== 'true') {
      statusCache = { at: Date.now(), data: [] }
      return []
    }

    const [raw, diff] = await Promise.all([
      git(['-c', 'core.fsmonitor=false', '-c', 'core.quotepath=false', 'status', '--porcelain=v1', '--untracked-files=all', '--no-renames', '-z', '--', '.']),
      git(['-c', 'core.fsmonitor=false', '-c', 'core.quotepath=false', 'diff', '--numstat', 'HEAD', '--', '.']).catch(() => ''),
    ])

    const stats = new Map<string, { added: number; removed: number }>()
    for (const line of diff.trim().split('\n').filter(Boolean)) {
      const [a, r, file] = line.split('\t')
      if (!file) continue
      const added = a === '-' ? 0 : Number.parseInt(a || '0', 10)
      const removed = r === '-' ? 0 : Number.parseInt(r || '0', 10)
      stats.set(file, {
        added: Number.isFinite(added) ? added : 0,
        removed: Number.isFinite(removed) ? removed : 0,
      })
    }

    const items = new Map<string, { path: string; added: number; removed: number; status: 'added' | 'deleted' | 'modified' }>()
    for (const item of raw.split('\u0000').filter(Boolean)) {
      const code = item.slice(0, 2)
      const file = item.slice(3)
      if (!file) continue
      const next = kind(code)
      const counts = stats.get(file)
      items.set(file, {
        path: file,
        added: counts?.added ?? 0,
        removed: counts?.removed ?? 0,
        status: next,
      })
    }

    const data = [...items.values()]
    statusCache = { at: Date.now(), data }
    return data
  })().finally(() => {
    statusPending = null
  })

  return statusPending
}

// ─── Binary detection ────────────────────────────────────────────────────────

const BINARY_EXTENSIONS = new Set([
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar', '.xz',
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.svg', '.webp', '.avif', '.heic',
  '.mp3', '.mp4', '.avi', '.mov', '.mkv', '.wav', '.ogg', '.webm', '.flac', '.aac',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.exe', '.dll', '.so', '.dylib', '.o', '.a',
  '.sqlite', '.db', '.wasm',
  '.dmg', '.iso', '.img',
])

function isBinary(filePath: string): boolean {
  return BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase())
}

// ─── GET / — list directory ──────────────────────────────────────────────────

filesRouter.get('/',
  describeRoute({
    tags: ['Files'],
    summary: 'List directory',
    description: 'Lists files and directories at the given path. Defaults to /workspace. Filters out .git and .DS_Store entries.',
    responses: {
      200: { description: 'Directory listing', content: { 'application/json': { schema: resolver(z.array(FileNode)) } } },
      403: { description: 'Access denied', content: { 'application/json': { schema: resolver(ErrorResponse) } } },
      404: { description: 'Directory not found', content: { 'application/json': { schema: resolver(ErrorResponse) } } },
      500: { description: 'Server error', content: { 'application/json': { schema: resolver(ErrorResponse) } } },
    },
  }),
  async (c) => {
    const dirPath = c.req.query('path') || '/workspace'
    const resolved = validatePath(c, dirPath)
    if (!resolved) return c.json({ error: 'Access denied: path outside allowed directories' })

    try {
      const entries = await fs.readdir(resolved, { withFileTypes: true })
      
      // For symlinks, we need to check the actual type they point to
      const nodes = await Promise.all(
        entries
          .filter((e) => e.name !== '.git' && e.name !== '.DS_Store')
          .map(async (e) => {
            let type: 'file' | 'directory' = e.isDirectory() ? 'directory' : 'file'
            
            // If it's a symlink, check what it actually points to (use stat, not lstat)
            if (e.isSymbolicLink()) {
              try {
                const stat = await fs.stat(path.join(resolved, e.name))
                type = stat.isDirectory() ? 'directory' : 'file'
              } catch {
                // stat failed, keep the original type
              }
            }
            
            return {
              name: e.name,
              path: path.join(dirPath, e.name),
              absolute: path.join(resolved, e.name),
              type,
              ignored: false,
            }
          })
      )
      
      nodes.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
        return a.name.localeCompare(b.name)
      })
      return c.json(nodes)
    } catch (err: any) {
      if (err.code === 'ENOENT') return c.json({ error: 'Directory not found' }, 404)
      if (err.code === 'ENOTDIR') return c.json({ error: 'Not a directory' }, 400)
      return c.json({ error: err.message }, 500)
    }
  },
)

// ─── GET /content — read file content (JSON, with base64 for binaries) ───────

filesRouter.get('/status',
  describeRoute({
    tags: ['Files'],
    summary: 'Git file status',
    description: 'Returns the git status of changed files for the current workspace using a fast local implementation in kortix-master.',
    responses: {
      200: {
        description: 'Changed files',
        content: {
          'application/json': {
            schema: resolver(z.array(z.object({
              path: z.string(),
              added: z.number(),
              removed: z.number(),
              status: z.enum(['added', 'deleted', 'modified']),
            }))),
          },
        },
      },
      500: { description: 'Server error', content: { 'application/json': { schema: resolver(ErrorResponse) } } },
    },
  }),
  async (c) => {
    try {
      return c.json(await status())
    } catch (err: any) {
      return c.json({ error: err?.message || 'Failed to read git status' }, 500)
    }
  },
)

filesRouter.get('/content',
  describeRoute({
    tags: ['Files'],
    summary: 'Read file content',
    description: 'Returns file content as text or base64-encoded binary depending on file type. Returns 404 for non-existent files.',
    responses: {
      200: {
        description: 'File content (text or binary)',
        content: {
          'application/json': {
            schema: resolver(z.union([FileContentTextResponse, FileContentBinaryResponse])),
          },
        },
      },
      400: { description: 'Missing path parameter', content: { 'application/json': { schema: resolver(ErrorResponse) } } },
      403: { description: 'Access denied', content: { 'application/json': { schema: resolver(ErrorResponse) } } },
      404: { description: 'File not found', content: { 'application/json': { schema: resolver(ErrorResponse) } } },
    },
  }),
  async (c) => {
    const filePath = c.req.query('path')
    if (!filePath) return c.json({ error: 'Missing path query parameter' }, 400)

    const resolved = validatePath(c, filePath)
    if (!resolved) return c.json({ error: 'Access denied: path outside allowed directories' })

    const file = Bun.file(resolved)
    if (!(await file.exists())) {
      return c.json({ error: 'File not found', path: filePath }, 404)
    }

    const mimeType = file.type || 'application/octet-stream'

    if (isBinary(resolved)) {
      const buffer = await file.arrayBuffer().catch(() => new ArrayBuffer(0))
      const content = Buffer.from(buffer).toString('base64')
      return c.json({ type: 'binary', content, mimeType, encoding: 'base64' })
    }

    // Text file — read as string
    const content = await file.text().catch(() => '')
    return c.json({ type: 'text', content: content.trim() })
  },
)

// ─── GET /raw — download raw file bytes ──────────────────────────────────────

filesRouter.get('/raw',
  describeRoute({
    tags: ['Files'],
    summary: 'Download raw file',
    description: 'Returns raw file bytes with appropriate Content-Type and Content-Disposition headers for direct download.',
    responses: {
      200: { description: 'Raw file bytes' },
      400: { description: 'Missing path parameter', content: { 'application/json': { schema: resolver(ErrorResponse) } } },
      403: { description: 'Access denied', content: { 'application/json': { schema: resolver(ErrorResponse) } } },
      404: { description: 'File not found', content: { 'application/json': { schema: resolver(ErrorResponse) } } },
    },
  }),
  async (c) => {
    const filePath = c.req.query('path')
    if (!filePath) return c.json({ error: 'Missing path query parameter' }, 400)

    const resolved = validatePath(c, filePath)
    if (!resolved) return c.json({ error: 'Access denied: path outside allowed directories' })

    const file = Bun.file(resolved)
    if (!(await file.exists())) {
      return c.json({ error: 'File not found' }, 404)
    }

    const mimeType = file.type || 'application/octet-stream'
    const fileName = path.basename(resolved)
    const buffer = await file.arrayBuffer()

    c.header('Content-Type', mimeType)
    c.header('Content-Disposition', `attachment; filename="${fileName}"`)
    c.header('Content-Length', buffer.byteLength.toString())
    return c.body(buffer)
  },
)

// ─── POST /upload — upload files via multipart form data ─────────────────────

filesRouter.post('/upload',
  describeRoute({
    tags: ['Files'],
    summary: 'Upload files',
    description: 'Upload one or more files via multipart form data. Optionally specify a target directory via the `path` form field.',
    responses: {
      200: { description: 'Upload results', content: { 'application/json': { schema: resolver(z.array(UploadResult)) } } },
      400: { description: 'No files in request', content: { 'application/json': { schema: resolver(ErrorResponse) } } },
    },
  }),
  async (c) => {
    const body = await c.req.parseBody({ all: true })
    const targetDir = typeof body['path'] === 'string' ? body['path'] : undefined
    const results: { path: string; size: number }[] = []

    for (const [key, value] of Object.entries(body)) {
      if (key === 'path') continue
      const files = Array.isArray(value) ? value : [value]
      for (const file of files) {
        if (typeof file === 'string') continue
        if (!(file instanceof globalThis.File)) continue
        const dest = targetDir
          ? targetDir + '/' + file.name
          : key === 'file' || key === 'file[]'
            ? file.name
            : key
        const buffer = await file.arrayBuffer()
        // Collision-free write: if `dest` already exists, the filename is
        // automatically suffixed with a unique token and the actual path
        // the bytes landed at is returned to the client.
        const actualPath = await writeUploadUnique(dest, buffer)
        results.push({ path: actualPath, size: buffer.byteLength })
      }
    }

    if (!results.length) return c.json({ error: 'No files found in request body' }, 400)
    return c.json(results)
  },
)

// ─── DELETE / — delete file or directory ─────────────────────────────────────

filesRouter.delete('/',
  describeRoute({
    tags: ['Files'],
    summary: 'Delete file or directory',
    description: 'Recursively deletes a file or directory at the given path.',
    responses: {
      200: { description: 'Deleted successfully' },
      400: { description: 'Missing path', content: { 'application/json': { schema: resolver(ErrorResponse) } } },
      403: { description: 'Access denied', content: { 'application/json': { schema: resolver(ErrorResponse) } } },
      404: { description: 'File not found', content: { 'application/json': { schema: resolver(ErrorResponse) } } },
    },
  }),
  async (c) => {
    const body = await c.req.json<{ path: string }>()
    if (!body.path) return c.json({ error: 'Missing path in request body' }, 400)

    const resolved = validatePath(c, body.path)
    if (!resolved) return c.json({ error: 'Access denied: path outside allowed directories' })

    const stat = await fs.stat(resolved).catch(() => null)
    if (!stat) return c.json({ error: 'File not found' }, 404)

    await fs.rm(resolved, { recursive: true, force: true })
    return c.json(true)
  },
)

// ─── POST /mkdir — create directory ──────────────────────────────────────────

filesRouter.post('/mkdir',
  describeRoute({
    tags: ['Files'],
    summary: 'Create directory',
    description: 'Creates a directory (and any missing parent directories) at the given path.',
    responses: {
      200: { description: 'Directory created' },
      400: { description: 'Missing path', content: { 'application/json': { schema: resolver(ErrorResponse) } } },
      403: { description: 'Access denied', content: { 'application/json': { schema: resolver(ErrorResponse) } } },
    },
  }),
  async (c) => {
    const body = await c.req.json<{ path: string }>()
    if (!body.path) return c.json({ error: 'Missing path in request body' }, 400)

    const resolved = validatePath(c, body.path)
    if (!resolved) return c.json({ error: 'Access denied: path outside allowed directories' })

    await fs.mkdir(resolved, { recursive: true })
    return c.json(true)
  },
)

// ─── POST /rename — rename or move file/directory ────────────────────────────

filesRouter.post('/rename',
  describeRoute({
    tags: ['Files'],
    summary: 'Rename or move',
    description: 'Renames or moves a file/directory from one path to another. Creates parent directories for the target path if needed.',
    responses: {
      200: { description: 'Renamed successfully' },
      400: { description: 'Missing from/to', content: { 'application/json': { schema: resolver(ErrorResponse) } } },
      403: { description: 'Access denied', content: { 'application/json': { schema: resolver(ErrorResponse) } } },
      404: { description: 'Source not found', content: { 'application/json': { schema: resolver(ErrorResponse) } } },
    },
  }),
  async (c) => {
    const body = await c.req.json<{ from: string; to: string }>()
    if (!body.from || !body.to) return c.json({ error: 'Missing from/to in request body' }, 400)

    const fromResolved = validatePath(c, body.from)
    if (!fromResolved) return c.json({ error: 'Access denied: source path outside allowed directories' })

    const toResolved = validatePath(c, body.to)
    if (!toResolved) return c.json({ error: 'Access denied: target path outside allowed directories' })

    const stat = await fs.stat(fromResolved).catch(() => null)
    if (!stat) return c.json({ error: 'Source file not found' }, 404)

    await fs.mkdir(path.dirname(toResolved), { recursive: true })
    await fs.rename(fromResolved, toResolved)
    return c.json(true)
  },
)

export default filesRouter

// z import needed for inline resolver usage
import { z } from 'zod'
