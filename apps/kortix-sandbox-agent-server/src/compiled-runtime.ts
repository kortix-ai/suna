import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { Config } from './config'

export const COMPILED_RUNTIME_FORMAT = 'kortix.compiled-runtime.v1'
export const COMPILED_RUNTIME_CONTENT_TYPE =
  'application/vnd.kortix.compiled-runtime.v1+javascript'
const MAX_RUNTIME_BYTES = 16 * 1024 * 1024
const DOWNLOAD_TIMEOUT_MS = 15_000
const MANIFEST_MARKER = '// kortix-manifest-base64url:'

interface CompiledRuntimeManifest {
  format: typeof COMPILED_RUNTIME_FORMAT
  engine: 'opencode'
  project_id: string
  ref: string
  source_sha: string
}

export interface CompiledRuntimeInstallResult {
  path: string
  bytes: number
  cache: string | null
  downloadMs: number
  sha256: string
}

type FetchImpl = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

export function buildCompiledRuntimeUrl(repoUrl: string, ref: string, sourceSha: string): string {
  const url = new URL(repoUrl)
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`compiled runtime requires an HTTP(S) Git proxy URL, got ${url.protocol}`)
  }
  url.username = ''
  url.password = ''
  url.hash = ''
  url.pathname = `${url.pathname.replace(/\/$/, '')}/compiled-runtime`
  url.search = ''
  url.searchParams.set('ref', ref)
  url.searchParams.set('sha', sourceSha)
  return url.toString()
}

export function parseCompiledRuntimeManifest(
  source: Uint8Array | string,
): CompiledRuntimeManifest {
  const prefix = typeof source === 'string' ? source : Buffer.from(source).toString('utf8')
  const marker = prefix
    .split('\n', 4)
    .find((line) => line.startsWith(MANIFEST_MARKER))
  if (!marker) throw new Error('compiled runtime manifest marker is missing')
  try {
    const encoded = marker.slice(MANIFEST_MARKER.length).trim()
    if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error('invalid marker')
    return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as CompiledRuntimeManifest
  } catch {
    throw new Error('compiled runtime manifest is not valid JSON')
  }
}

function validateManifest(cfg: Config, manifest: CompiledRuntimeManifest): void {
  const ref = cfg.defaultBranch
  if (
    manifest.format !== COMPILED_RUNTIME_FORMAT ||
    manifest.engine !== 'opencode' ||
    manifest.project_id !== cfg.projectId ||
    manifest.ref !== ref ||
    manifest.source_sha !== cfg.baseSha
  ) {
    throw new Error('compiled runtime manifest does not match this session')
  }
}

export async function installCompiledRuntime(
  cfg: Config,
  options: {
    destination?: string
    fetchImpl?: FetchImpl
  } = {},
): Promise<CompiledRuntimeInstallResult> {
  if (!cfg.projectId) throw new Error('KORTIX_PROJECT_ID is required for compiled runtime')
  if (!cfg.repoUrl) throw new Error('KORTIX_REPO_URL is required for compiled runtime')
  if (!cfg.baseSha) throw new Error('KORTIX_BASE_SHA is required for compiled runtime')
  if (!cfg.sandboxToken) throw new Error('KORTIX_TOKEN is required for compiled runtime')

  const ref = cfg.defaultBranch
  const url = buildCompiledRuntimeUrl(cfg.repoUrl, ref, cfg.baseSha)
  const destination = options.destination || '/opt/kortix/server.mjs'
  const staged = `${destination}.${crypto.randomUUID()}.tmp.mjs`
  const started = Date.now()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
  try {
    const response = await (options.fetchImpl ?? fetch)(url, {
      headers: {
        accept: COMPILED_RUNTIME_CONTENT_TYPE,
        authorization: `Bearer ${cfg.sandboxToken}`,
      },
      signal: controller.signal,
    })
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).trim().slice(0, 200)
      throw new Error(`compiled runtime HTTP ${response.status}${detail ? `: ${detail}` : ''}`)
    }
    const format = response.headers.get('x-kortix-artifact-format')
    if (format !== COMPILED_RUNTIME_FORMAT) {
      throw new Error(`compiled runtime format mismatch: ${format || 'missing'}`)
    }
    const expectedSha256 = response.headers.get('x-kortix-artifact-sha256')
    if (!expectedSha256 || !/^[0-9a-f]{64}$/.test(expectedSha256)) {
      throw new Error('compiled runtime SHA-256 header is missing or invalid')
    }
    const sourceSha = response.headers.get('x-kortix-artifact-source-sha')
    if (sourceSha !== cfg.baseSha) {
      throw new Error(`compiled runtime source mismatch: expected ${cfg.baseSha}, got ${sourceSha}`)
    }
    const body = Buffer.from(await response.arrayBuffer())
    if (body.length <= 0) throw new Error('compiled runtime response body is empty')
    if (body.length > MAX_RUNTIME_BYTES) {
      throw new Error(`compiled runtime exceeds ${MAX_RUNTIME_BYTES} bytes (${body.length})`)
    }
    const sha256 = createHash('sha256').update(body).digest('hex')
    if (sha256 !== expectedSha256) {
      throw new Error(`compiled runtime SHA-256 mismatch: expected ${expectedSha256}, got ${sha256}`)
    }

    await mkdir(dirname(destination), { recursive: true })
    const manifest = parseCompiledRuntimeManifest(body)
    validateManifest(cfg, manifest)
    await writeFile(staged, body, { mode: 0o700 })
    await rename(staged, destination)
    await chmod(destination, 0o700)
    return {
      path: destination,
      bytes: body.length,
      cache: response.headers.get('x-kortix-artifact-cache'),
      downloadMs: Date.now() - started,
      sha256,
    }
  } finally {
    clearTimeout(timeout)
    await rm(staged, { force: true }).catch(() => {})
  }
}

export async function readInstalledCompiledRuntimeManifest(
  path: string,
): Promise<CompiledRuntimeManifest> {
  return parseCompiledRuntimeManifest(await readFile(path))
}
