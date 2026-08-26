import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import type { Config } from './config'

export const COMPILED_CHECKOUT_FORMAT = 'kortix.compiled-checkout.v1'
export const COMPILED_CHECKOUT_CONTENT_TYPE =
  'application/vnd.kortix.compiled-checkout.v1+gzip'
const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024
const DOWNLOAD_TIMEOUT_MS = 45_000
const EXTRACT_TIMEOUT_MS = 120_000

interface CompiledCheckoutManifest {
  format: typeof COMPILED_CHECKOUT_FORMAT
  project_id: string
  ref: string
  source_sha: string
  shallow: true
}

export interface CompiledCheckoutMetrics {
  bytes: number
  cache: string | null
  downloadMs: number
  extractMs: number
  sha256: string
  sourceSha: string
  url: string
}

export function buildCompiledCheckoutUrl(repoUrl: string, ref: string, sourceSha: string): string {
  const url = new URL(repoUrl)
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`compiled checkout requires an HTTP(S) Git proxy URL, got ${url.protocol}`)
  }
  url.username = ''
  url.password = ''
  url.hash = ''
  url.pathname = `${url.pathname.replace(/\/$/, '')}/compiled-checkout`
  url.search = ''
  url.searchParams.set('ref', ref)
  url.searchParams.set('sha', sourceSha)
  return url.toString()
}

async function runProcess(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      stderr += `\nprocess exceeded ${timeoutMs}ms`
      child.kill('SIGKILL')
    }, timeoutMs)
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`${command} failed: ${stderr.trim() || `exit ${code}`}`))
    })
  })
}

async function downloadArtifact(
  url: string,
  token: string,
  archivePath: string,
  fetchImpl: typeof fetch,
): Promise<{ bytes: number; cache: string | null; downloadMs: number; sha256: string }> {
  const started = Date.now()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
  try {
    const response = await fetchImpl(url, {
      headers: {
        accept: COMPILED_CHECKOUT_CONTENT_TYPE,
        authorization: `Bearer ${token}`,
      },
      signal: controller.signal,
    })
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).trim().slice(0, 200)
      throw new Error(`compiled checkout HTTP ${response.status}${detail ? `: ${detail}` : ''}`)
    }
    const format = response.headers.get('x-kortix-artifact-format')
    if (format !== COMPILED_CHECKOUT_FORMAT) {
      throw new Error(`compiled checkout format mismatch: ${format || 'missing'}`)
    }
    const expectedSha256 = response.headers.get('x-kortix-artifact-sha256')
    if (!expectedSha256 || !/^[0-9a-f]{64}$/.test(expectedSha256)) {
      throw new Error('compiled checkout SHA-256 header is missing or invalid')
    }
    const declaredBytes = Number(response.headers.get('content-length'))
    if (Number.isFinite(declaredBytes) && declaredBytes > MAX_ARTIFACT_BYTES) {
      throw new Error(`compiled checkout exceeds ${MAX_ARTIFACT_BYTES} bytes (${declaredBytes})`)
    }
    if (!response.body) throw new Error('compiled checkout response body is empty')

    let bytes = 0
    const hash = createHash('sha256')
    const verifier = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length
        if (bytes > MAX_ARTIFACT_BYTES) {
          callback(new Error(`compiled checkout exceeds ${MAX_ARTIFACT_BYTES} bytes`))
          return
        }
        hash.update(chunk)
        callback(null, chunk)
      },
    })
    await pipeline(
      Readable.fromWeb(response.body as never),
      verifier,
      createWriteStream(archivePath, { mode: 0o600 }),
    )
    const sha256 = hash.digest('hex')
    if (sha256 !== expectedSha256) {
      throw new Error(`compiled checkout SHA-256 mismatch: expected ${expectedSha256}, got ${sha256}`)
    }
    return {
      bytes,
      cache: response.headers.get('x-kortix-artifact-cache'),
      downloadMs: Date.now() - started,
      sha256,
    }
  } finally {
    clearTimeout(timeout)
  }
}

async function validateExtractedCheckout(
  cfg: Config,
  stage: string,
  ref: string,
  sourceSha: string,
): Promise<void> {
  const rawManifest = await readFile(`${stage}/.git/kortix-compiled-checkout.json`, 'utf8')
  const manifest = JSON.parse(rawManifest) as CompiledCheckoutManifest
  if (
    manifest.format !== COMPILED_CHECKOUT_FORMAT ||
    manifest.project_id !== cfg.projectId ||
    manifest.ref !== ref ||
    manifest.source_sha !== sourceSha ||
    manifest.shallow !== true
  ) {
    throw new Error('compiled checkout manifest does not match this session')
  }
  const head = await runProcess('git', ['-C', stage, 'rev-parse', '--verify', 'HEAD'], 10_000)
  if (head.stdout.trim() !== sourceSha) {
    throw new Error(`compiled checkout HEAD mismatch: ${head.stdout.trim() || head.stderr}`)
  }
  const status = await runProcess('git', ['-C', stage, 'status', '--porcelain'], 10_000)
  if (status.stdout.trim() !== '') {
    throw new Error(`compiled checkout working tree is not clean: ${status.stdout || status.stderr}`)
  }
}

export async function materializeCompiledCheckoutToStage(
  cfg: Config,
  stage: string,
  ref: string,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<CompiledCheckoutMetrics> {
  if (!cfg.projectId) throw new Error('KORTIX_PROJECT_ID is required for compiled boot')
  if (!cfg.repoUrl) throw new Error('KORTIX_REPO_URL is required for compiled boot')
  if (!cfg.baseSha) throw new Error('KORTIX_BASE_SHA is required for compiled boot')
  if (!cfg.sandboxToken) throw new Error('KORTIX_TOKEN is required for compiled boot')

  const url = buildCompiledCheckoutUrl(cfg.repoUrl, ref, cfg.baseSha)
  const archivePath = `${stage}.tar.gz`
  await rm(stage, { recursive: true, force: true })
  await rm(archivePath, { force: true })
  await mkdir(stage, { recursive: true })
  try {
    const downloaded = await downloadArtifact(
      url,
      cfg.sandboxToken,
      archivePath,
      options.fetchImpl ?? fetch,
    )
    const extractStarted = Date.now()
    await runProcess('tar', ['-xzf', archivePath, '-C', stage], EXTRACT_TIMEOUT_MS)
    const extractMs = Date.now() - extractStarted
    await validateExtractedCheckout(cfg, stage, ref, cfg.baseSha)
    return {
      ...downloaded,
      extractMs,
      sourceSha: cfg.baseSha,
      url,
    }
  } catch (error) {
    await rm(stage, { recursive: true, force: true }).catch(() => {})
    throw error
  } finally {
    await rm(archivePath, { force: true }).catch(() => {})
  }
}
