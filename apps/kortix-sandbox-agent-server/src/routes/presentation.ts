import { Hono } from 'hono'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'

import type { Config } from '../config'
import { logger } from '../logger'

/**
 * Presentation export — turn a deck of HTML slides (created by the
 * `presentations` skill under <workspace>/presentations/<name>) into a
 * downloadable PDF or PPTX, on demand from the web/mobile viewer's download
 * buttons.
 *
 * Why this lives in the daemon (and not a synchronous endpoint):
 *
 * The viewer POSTs to `${sandbox_url}/presentation/convert-to-{pdf,pptx}` —
 * `sandbox_url` is the apps/api preview proxy (`/v1/p/<id>/8000`), which caps
 * every upstream attempt at PROXY_ATTEMPT_TIMEOUT_MS (15s) and retries. A real
 * multi-slide PPTX render takes well over 15s, so a convert-and-return handler
 * would time out → 502 AND re-run the conversion on each retry. Instead we run
 * the conversion in the BACKGROUND and the client POSTs repeatedly:
 *
 *   - file fresh on disk        → 200 + the binary (download it)
 *   - conversion in flight      → 202 {status:'generating'} (poll again)
 *   - conversion failed         → 500 {error} (stop, surface it)
 *
 * Every request returns in milliseconds, so it never trips the proxy timeout.
 *
 * The actual rasterize/extract is the SAME working engine the agent's
 * `export_pdf`/`export_pptx` skill actions use: the Python scripts in the
 * presentations skill (convert_pdf.py / convert_pptx.py). We just locate and
 * invoke them here so the viewer buttons reuse it instead of a missing endpoint.
 */

export type PresentationFormat = 'pdf' | 'pptx'

const FORMAT_MIME: Record<PresentationFormat, string> = {
  pdf: 'application/pdf',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

const FORMAT_SCRIPT: Record<PresentationFormat, string> = {
  pdf: 'convert_pdf.py',
  pptx: 'convert_pptx.py',
}

// Mirrors files.ts — a path must resolve inside one of these roots.
const DEFAULT_ALLOWED_ROOTS = ['/workspace', '/opt', '/tmp', '/home']

// The presentation skill's `scripts/` dir, relative to an opencode config dir.
const SCRIPTS_REL = 'skills/GENERAL-KNOWLEDGE-WORKER/presentations/scripts'

const CONVERT_TIMEOUT_MS = 240_000

export interface ConvertOutcome {
  success: boolean
  error?: string
}

export type ConvertRunner = (
  format: PresentationFormat,
  presDir: string,
  outPath: string,
  scriptsDir: string,
) => Promise<ConvertOutcome>

export interface PresentationRouterOptions {
  /** Override the conversion runner (tests inject a fake that writes a file). */
  runConvert?: ConvertRunner
  /** Override script-dir resolution (tests point at a stub, or return null). */
  resolveScriptsDir?: (cfg: Config) => Promise<string | null>
}

/** Matches the skill's sanitizeFilename so a path built from a raw, unsanitized
 *  presentation name still resolves to the on-disk directory. */
function sanitizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 80)
}

/**
 * Parse the single JSON line the convert scripts print on stdout
 * (`{"success": true, "output_path": "..."}` or `{"success": false, "error": "..."}`).
 * Returns null when no parseable result line is present.
 */
export function parseScriptResult(stdout: string): ConvertOutcome | null {
  const lines = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!
    if (!line.startsWith('{')) continue
    try {
      const obj = JSON.parse(line) as { success?: unknown; error?: unknown }
      if (typeof obj.success === 'boolean') {
        return obj.success
          ? { success: true }
          : { success: false, error: String(obj.error ?? 'conversion failed') }
      }
    } catch {
      /* not the result line — keep scanning upward */
    }
  }
  return null
}

/** Run the Python convert script the same way the skill does: `python3 <script>`
 *  on Linux (the sandbox), `uv run <script>` elsewhere (local dev / mac). */
function defaultRunConvert(
  format: PresentationFormat,
  presDir: string,
  outPath: string,
  scriptsDir: string,
): Promise<ConvertOutcome> {
  return new Promise((resolve) => {
    const script = FORMAT_SCRIPT[format]
    const isLinux = process.platform === 'linux'
    const cmd = isLinux ? 'python3' : 'uv'
    const args = isLinux ? [script, presDir, outPath] : ['run', script, presDir, outPath]

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(cmd, args, { cwd: scriptsDir, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      resolve({ success: false, error: err instanceof Error ? err.message : String(err) })
      return
    }

    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }, CONVERT_TIMEOUT_MS)

    child.stdout?.on('data', (d) => {
      stdout += d
    })
    child.stderr?.on('data', (d) => {
      stderr += d
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ success: false, error: err.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const parsed = parseScriptResult(stdout)
      if (parsed) {
        resolve(parsed)
        return
      }
      if (code === 0) {
        resolve({ success: true })
        return
      }
      const detail = (stderr || stdout || `convert exited with code ${code}`).trim().slice(0, 500)
      resolve({ success: false, error: detail })
    })
  })
}

/** Find the presentation skill's scripts dir. Prefers the project's resolved
 *  opencode config dir, then the conventional in-repo + installed locations. */
async function defaultResolveScriptsDir(cfg: Config): Promise<string | null> {
  const candidates: string[] = []
  try {
    const { resolveOpencodeConfigDir } = await import('../config')
    const configDir = await resolveOpencodeConfigDir(cfg)
    candidates.push(path.join(configDir, SCRIPTS_REL))
  } catch {
    /* fall back to the static candidates below */
  }
  candidates.push(path.join(cfg.workspace || '/workspace', '.kortix/opencode', SCRIPTS_REL))
  candidates.push(path.join(os.homedir(), '.opencode', SCRIPTS_REL))
  for (const dir of candidates) {
    if (existsSync(path.join(dir, FORMAT_SCRIPT.pdf))) return dir
  }
  return null
}

export function createPresentationRouter(
  cfg: Config,
  options: PresentationRouterOptions = {},
): Hono {
  const app = new Hono()
  const workspace = cfg.workspace || '/workspace'
  const allowedRoots = Array.from(new Set([path.resolve(workspace), ...DEFAULT_ALLOWED_ROOTS]))
  const runConvert = options.runConvert ?? defaultRunConvert
  const resolveScriptsDir = options.resolveScriptsDir ?? defaultResolveScriptsDir

  // In-flight conversions, keyed by `${format}:${presDir}`. A 'running' entry
  // makes concurrent polls return 202; an 'error' entry is surfaced once (as a
  // 500) and then cleared so a later request can retry from scratch.
  type Job = { status: 'running' | 'error'; error?: string }
  const jobs = new Map<string, Job>()

  /** Resolve + validate a presentation path against the allowed roots. */
  function resolvePresentationDir(raw: string): string {
    const resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(workspace, raw)
    if (!allowedRoots.some((root) => resolved === root || resolved.startsWith(root + '/'))) {
      throw new Error('Access denied: path outside allowed directories')
    }
    return resolved
  }

  /** Is the rendered output newer than the deck's source (metadata + slides)?
   *  A stale file must be regenerated rather than served. */
  async function outputIsFresh(presDir: string, outPath: string): Promise<boolean> {
    const outStat = await fs.stat(outPath).catch(() => null)
    if (!outStat || !outStat.isFile() || outStat.size === 0) return false
    let newestSource = 0
    const metaStat = await fs.stat(path.join(presDir, 'metadata.json')).catch(() => null)
    if (metaStat) newestSource = Math.max(newestSource, metaStat.mtimeMs)
    const entries = await fs.readdir(presDir).catch(() => [] as string[])
    for (const entry of entries) {
      if (!/^slide_.*\.html$/i.test(entry)) continue
      const slideStat = await fs.stat(path.join(presDir, entry)).catch(() => null)
      if (slideStat) newestSource = Math.max(newestSource, slideStat.mtimeMs)
    }
    return outStat.mtimeMs >= newestSource
  }

  async function streamFile(
    outPath: string,
    fileName: string,
    format: PresentationFormat,
  ): Promise<Response> {
    const data = await fs.readFile(outPath)
    return new Response(data, {
      status: 200,
      headers: {
        'Content-Type': FORMAT_MIME[format],
        'Content-Length': String(data.byteLength),
        'Content-Disposition': `attachment; filename="${fileName}"`,
        'Cache-Control': 'no-store',
      },
    })
  }

  async function handle(c: import('hono').Context, format: PresentationFormat): Promise<Response> {
    let presentationPath: string | undefined
    try {
      const body = (await c.req.json()) as { presentation_path?: unknown }
      if (typeof body.presentation_path === 'string') presentationPath = body.presentation_path
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }
    if (!presentationPath) {
      return c.json({ error: 'presentation_path is required' }, 400)
    }

    let presDir: string
    try {
      presDir = resolvePresentationDir(presentationPath)
    } catch (err) {
      return c.json({ error: (err as Error).message }, 403)
    }

    // Resolve the directory, falling back to the sanitized name (the viewer
    // sometimes posts the raw, unsanitized presentation name).
    const dirStat = await fs.stat(presDir).catch(() => null)
    if (!dirStat || !dirStat.isDirectory()) {
      const sanitized = path.join(path.dirname(presDir), sanitizeName(path.basename(presDir)))
      const altStat = await fs.stat(sanitized).catch(() => null)
      if (altStat?.isDirectory()) {
        presDir = sanitized
      } else {
        return c.json({ error: `Presentation not found: ${presentationPath}` }, 404)
      }
    }
    if (!existsSync(path.join(presDir, 'metadata.json'))) {
      return c.json({ error: 'Presentation has no metadata.json' }, 404)
    }

    const fileName = `${path.basename(presDir)}.${format}`
    const outPath = path.join(presDir, fileName)
    const jobKey = `${format}:${presDir}`
    const job = jobs.get(jobKey)

    // Fast path: a fresh render already exists and nothing is regenerating it.
    if (!job && (await outputIsFresh(presDir, outPath))) {
      return streamFile(outPath, fileName, format)
    }

    if (job) {
      if (job.status === 'error') {
        const error = job.error ?? 'conversion failed'
        jobs.delete(jobKey) // surfaced once; allow a retry on the next request
        return c.json({ status: 'error', error }, 500)
      }
      return c.json({ status: 'generating' }, 202)
    }

    const scriptsDir = await resolveScriptsDir(cfg)
    if (!scriptsDir) {
      return c.json(
        { error: 'presentation conversion tooling is not available in this sandbox' },
        501,
      )
    }

    jobs.set(jobKey, { status: 'running' })
    logger.info('[presentation] starting conversion', { format, presDir })
    void runConvert(format, presDir, outPath, scriptsDir)
      .then((result) => {
        if (result.success) {
          jobs.delete(jobKey)
          logger.info('[presentation] conversion complete', { format, presDir })
        } else {
          jobs.set(jobKey, { status: 'error', error: result.error ?? 'conversion failed' })
          logger.warn('[presentation] conversion failed', { format, presDir, error: result.error })
        }
      })
      .catch((err) => {
        const error = err instanceof Error ? err.message : String(err)
        jobs.set(jobKey, { status: 'error', error })
        logger.warn('[presentation] conversion threw', { format, presDir, error })
      })

    return c.json({ status: 'generating' }, 202)
  }

  app.post('/convert-to-pdf', (c) => handle(c, 'pdf'))
  app.post('/convert-to-pptx', (c) => handle(c, 'pptx'))

  return app
}
