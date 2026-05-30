import { Hono } from 'hono'
import path from 'node:path'
import fs from 'node:fs/promises'
import crypto from 'node:crypto'

import type { Config } from '../config'
import { logger } from '../logger'

/**
 * File write routes — direct sandbox filesystem access.
 *
 * OpenCode's HTTP API only serves READ endpoints (`/file` list,
 * `/file/content`, `/file/status`, `/find/file`). The write surface
 * (upload, delete, mkdir, rename) lived in the legacy kortix-master daemon
 * and must be served here: the catch-all reverse proxy forwards everything
 * else to OpenCode, which 404s these.
 *
 * Mounted at `/file` (e.g. POST /file/upload). Only the WRITE methods/paths
 * are registered, so GET /file and GET /file/content still fall through to
 * the OpenCode reverse-proxy catch-all.
 *
 * Security: every path is resolved to an absolute path and validated against
 * ALLOWED_ROOTS before any filesystem operation (no traversal escapes).
 */

const DEFAULT_ALLOWED_ROOTS = ['/workspace', '/opt', '/tmp', '/home']

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
