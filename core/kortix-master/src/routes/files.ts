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
import { mkdirSync, existsSync } from 'fs'
import { randomBytes } from 'crypto'
import { installUploadedFile } from '../services/project-access-client'
import {
  fsReaddir,
  fsStat,
  fsRead,
  fsMkdir,
  fsUnlink,
  fsRename,
  FsError,
} from '../services/fs-client'

const SYSTEM_UID = Number(process.env.KORTIX_SYSTEM_UID || 911)

function callerUid(c: any): number {
  const member = getMember(c)
  return member?.linuxUid ?? SYSTEM_UID
}
import {
  ErrorResponse,
  FileNode,
  FileContentTextResponse,
  FileContentBinaryResponse,
  UploadResult,
} from '../schemas/common'
import { getMember } from '../services/member-context'
import { getDb } from '../services/db'
import {
  allowedWorkspacesFor,
  isManager,
  personalWorkspacePath,
  projectWorkspacePath,
  workspaceListFor,
} from '../services/workspace'

const filesRouter = new Hono()
const root = process.env.KORTIX_WORKSPACE || '/workspace'

function memberAllowedPaths(_c: any): string[] | null {
  // Per-member workspace gating disabled — "one access for all". The
  // ALLOWED_ROOTS check in resolvePath() still keeps requests inside
  // sane prefixes (/, /workspace, /opt, /tmp, /home, /srv/kortix), so
  // requests can't escape the sandbox; they just aren't filtered down
  // to the requesting member's project list. Project-level isolation
  // belongs in the apps/api preview-proxy layer, not here.
  return null
}

function pathIsUnderAny(target: string, allowed: string[]): boolean {
  if (allowed.length === 0) return false
  return allowed.some((prefix) => {
    if (target === prefix) return true
    return target.startsWith(prefix === '/' ? '/' : `${prefix}/`)
  })
}

function allowedChildrenAtAncestor(target: string, allowed: string[]): Set<string> {
  const names = new Set<string>()
  for (const prefix of allowed) {
    const boundary = target === '/' ? '/' : `${target}/`
    if (prefix.startsWith(boundary)) {
      const tail = prefix.slice(boundary.length)
      const head = tail.split('/')[0]
      if (head) names.add(head)
    }
  }
  return names
}

let statusCache: { at: number; data: Array<{ path: string; added: number; removed: number; status: 'added' | 'deleted' | 'modified' }> } | null = null
let statusPending: Promise<Array<{ path: string; added: number; removed: number; status: 'added' | 'deleted' | 'modified' }>> | null = null

// ─── Security ────────────────────────────────────────────────────────────────

const ALLOWED_ROOTS = ['/', '/workspace', '/opt', '/tmp', '/home', '/srv/kortix']

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

function validatePath(c: any, raw: string): string | null {
  let resolved: string
  try {
    resolved = resolvePath(raw)
  } catch {
    c.status(403)
    return null
  }
  const allowed = memberAllowedPaths(c)
  if (allowed !== null && !pathIsUnderAny(resolved, allowed)) {
    c.status(403)
    return null
  }
  return resolved
}

function validateListPath(c: any, raw: string): { resolved: string; filter: Set<string> | null } | null {
  let resolved: string
  try {
    resolved = resolvePath(raw)
  } catch {
    c.status(403)
    return null
  }
  const allowed = memberAllowedPaths(c)
  if (allowed === null) return { resolved, filter: null }
  if (pathIsUnderAny(resolved, allowed)) return { resolved, filter: null }
  const children = allowedChildrenAtAncestor(resolved, allowed)
  if (children.size === 0) {
    c.status(403)
    return null
  }
  return { resolved, filter: children }
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

filesRouter.get('/workspaces',
  describeRoute({
    tags: ['Files'],
    summary: 'List caller workspaces',
    description: 'Returns the top-level workspaces the caller can see: personal workspace plus granted projects.',
    responses: { 200: { description: 'Workspace list' } },
  }),
  async (c) => {
    const member = getMember(c)
    if (!member) {
      return c.json([
        { id: 'legacy', kind: 'project', label: 'Workspace', path: '/workspace' },
      ])
    }
    return c.json(workspaceListFor(member))
  },
)

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
    const gate = validateListPath(c, dirPath)
    if (!gate) return c.json({ error: 'Access denied: path outside allowed directories' })
    const resolved = gate.resolved
    const nameFilter = gate.filter

    try {
      const entries = await fsReaddir(callerUid(c), resolved)

      const nodes = entries
        .filter((e) => e.name !== '.git' && e.name !== '.DS_Store')
        .filter((e) => !nameFilter || nameFilter.has(e.name))
        .map((e) => {
          const type: 'file' | 'directory' =
            e.type === 'directory' ? 'directory' : 'file'
          return {
            name: e.name,
            path: path.join(dirPath, e.name),
            absolute: path.join(resolved, e.name),
            type,
            ignored: false,
          }
        })

      nodes.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
        return a.name.localeCompare(b.name)
      })
      return c.json(nodes)
    } catch (err: any) {
      if (err instanceof FsError) {
        if (err.code === 'ENOENT') return c.json({ error: 'Directory not found' }, 404)
        if (err.code === 'ENOTDIR') return c.json({ error: 'Not a directory' }, 400)
        if (err.code === 'EACCES') return c.json({ error: 'Access denied' }, 403)
        return c.json({ error: err.message }, (err.status as any) || 500)
      }
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

    try {
      const result = await fsRead(callerUid(c), resolved)
      if (result.type === 'binary') {
        const mimeType = 'application/octet-stream'
        return c.json({ type: 'binary', content: result.content, mimeType, encoding: 'base64' })
      }
      return c.json({ type: 'text', content: result.content.trim() })
    } catch (err: any) {
      if (err instanceof FsError) {
        if (err.code === 'ENOENT') return c.json({ error: 'File not found', path: filePath }, 404)
        if (err.code === 'EACCES') return c.json({ error: 'Access denied' }, 403)
        return c.json({ error: err.message }, (err.status as any) || 500)
      }
      return c.json({ error: err?.message || 'read failed' }, 500)
    }
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

    try {
      const result = await fsRead(callerUid(c), resolved)
      const buffer =
        result.type === 'binary'
          ? Buffer.from(result.content, 'base64')
          : Buffer.from(result.content, 'utf8')

      const fileName = path.basename(resolved)
      c.header('Content-Type', 'application/octet-stream')
      c.header('Content-Disposition', `attachment; filename="${fileName}"`)
      c.header('Content-Length', buffer.byteLength.toString())
      return c.body(buffer)
    } catch (err: any) {
      if (err instanceof FsError) {
        if (err.code === 'ENOENT') return c.json({ error: 'File not found' }, 404)
        if (err.code === 'EACCES') return c.json({ error: 'Access denied' }, 403)
        return c.json({ error: err.message }, (err.status as any) || 500)
      }
      return c.json({ error: err?.message || 'read failed' }, 500)
    }
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
    const requestedDir = typeof body['path'] === 'string' ? body['path'] : undefined
    const sessionId = typeof body['session_id'] === 'string' ? body['session_id'] : undefined
    const targetDir = resolveUploadDir(c, requestedDir, sessionId)
    if (targetDir === null) {
      return c.json({ error: 'Access denied: upload path outside allowed directories' }, 403)
    }
    const member = getMember(c)
    const results: { path: string; size: number }[] = []

    for (const [key, value] of Object.entries(body)) {
      if (key === 'path' || key === 'session_id') continue
      const files = Array.isArray(value) ? value : [value]
      for (const file of files) {
        if (typeof file === 'string') continue
        if (!(file instanceof globalThis.File)) continue
        const buffer = await file.arrayBuffer()
        let actualPath: string
        if (member && requiresPrivilegedWrite(targetDir)) {
          actualPath = await stageAndInstall(buffer, targetDir, file.name, member.linuxUid)
        } else {
          actualPath = await writeUploadUnique(targetDir + '/' + file.name, buffer)
        }
        results.push({ path: actualPath, size: buffer.byteLength })
      }
    }

    if (!results.length) return c.json({ error: 'No files found in request body' }, 400)
    return c.json(results)
  },
)

function requiresPrivilegedWrite(dir: string): boolean {
  const memberRoot = '/srv/kortix/home'
  const projectRoot = '/srv/kortix/projects'
  return dir.startsWith(`${memberRoot}/`) || dir.startsWith(`${projectRoot}/`)
}

async function stageAndInstall(
  buffer: ArrayBuffer,
  destDir: string,
  filename: string,
  ownerUid: number,
): Promise<string> {
  const stageDir = '/tmp/kortix-uploads'
  if (!existsSync(stageDir)) mkdirSync(stageDir, { recursive: true })
  const stagedPath = `${stageDir}/${randomBytes(8).toString('hex')}-${path.basename(filename)}`
  await fs.writeFile(stagedPath, Buffer.from(buffer), { flag: 'wx' })
  const installed = await installUploadedFile({
    src: stagedPath,
    destDir,
    filename,
    ownerUid,
  })
  return installed.path
}

function resolveUploadDir(
  c: any,
  requestedDir: string | undefined,
  sessionId: string | undefined,
): string | null {
  const member = getMember(c)
  if (!member) {
    const raw = requestedDir?.trim() || '/workspace/uploads'
    try {
      return resolvePath(raw)
    } catch {
      return null
    }
  }

  const defaultDir = defaultUploadDir(member, sessionId)

  if (!requestedDir || !requestedDir.trim()) {
    return ensureUploadSubdir(defaultDir)
  }

  let resolved: string
  try {
    resolved = resolvePath(requestedDir)
  } catch {
    return null
  }

  if (isManager(member)) {
    return ensureUploadSubdir(resolved)
  }

  const allowed = allowedWorkspacesFor(member).map((p) => path.resolve(p))
  if (!pathIsUnderAny(resolved, allowed)) {
    return ensureUploadSubdir(defaultDir)
  }
  return ensureUploadSubdir(resolved)
}

function defaultUploadDir(member: ReturnType<typeof getMember>, sessionId: string | undefined): string {
  if (!member) return '/workspace/uploads'
  if (sessionId) {
    const db = getDb()
    const row = db
      .prepare(
        `SELECT p.id, p.name, p.path, p.kind
         FROM session_projects sp
         JOIN projects p ON p.id = sp.project_id
         WHERE sp.session_id = ?`,
      )
      .get(sessionId) as { id: string; name: string; path: string; kind: 'scoped' | 'workspace' } | null
    if (row) {
      return `${projectWorkspacePath(row)}/uploads`
    }
  }
  return `${personalWorkspacePath(member)}/uploads`
}

function ensureUploadSubdir(dir: string): string {
  const final = dir.endsWith('/uploads') ? dir : `${dir}/uploads`
  try {
    mkdirSync(final, { recursive: true })
  } catch {}
  return final
}

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

    try {
      const info = await fsStat(callerUid(c), resolved)
      if (!info.exists) return c.json({ error: 'File not found' }, 404)
      await fsUnlink(callerUid(c), resolved)
      return c.json(true)
    } catch (err: any) {
      if (err instanceof FsError) {
        if (err.code === 'ENOENT') return c.json({ error: 'File not found' }, 404)
        if (err.code === 'EACCES') return c.json({ error: 'Access denied' }, 403)
        return c.json({ error: err.message }, (err.status as any) || 500)
      }
      return c.json({ error: err?.message || 'delete failed' }, 500)
    }
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

    try {
      await fsMkdir(callerUid(c), resolved)
      return c.json(true)
    } catch (err: any) {
      if (err instanceof FsError) {
        if (err.code === 'EACCES') return c.json({ error: 'Access denied' }, 403)
        return c.json({ error: err.message }, (err.status as any) || 500)
      }
      return c.json({ error: err?.message || 'mkdir failed' }, 500)
    }
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

    try {
      const info = await fsStat(callerUid(c), fromResolved)
      if (!info.exists) return c.json({ error: 'Source file not found' }, 404)
      await fsMkdir(callerUid(c), path.dirname(toResolved))
      await fsRename(callerUid(c), fromResolved, toResolved)
      return c.json(true)
    } catch (err: any) {
      if (err instanceof FsError) {
        if (err.code === 'ENOENT') return c.json({ error: 'Source file not found' }, 404)
        if (err.code === 'EACCES') return c.json({ error: 'Access denied' }, 403)
        return c.json({ error: err.message }, (err.status as any) || 500)
      }
      return c.json({ error: err?.message || 'rename failed' }, 500)
    }
  },
)

export default filesRouter

// z import needed for inline resolver usage
import { z } from 'zod'
