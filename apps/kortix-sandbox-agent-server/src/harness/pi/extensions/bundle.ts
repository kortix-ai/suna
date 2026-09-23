/**
 * The project's pi packages, delivered as one prebuilt bundle.
 *
 * The API installs kortix.yaml `harnesses.pi.packages` once per package list
 * (apps/api/src/pi-packages/bundle.ts) and hands the session a short-lived
 * download URL plus the bundle's digest. Here the bundle is unpacked to
 * `<dir>/<digest>/node_modules` before the pi runtime starts. A restart of the
 * same sandbox finds the `.complete` marker and downloads nothing.
 *
 * Any failure leaves the project packages out, never the session: the runtime
 * reports each missing package in its extension status.
 */
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import * as tar from 'tar'
import { logger } from '../../../logger'

const DOWNLOAD_TIMEOUT_MS = 60_000
const DIGEST_RE = /^[0-9a-f]{64}$/

export interface ProjectBundleInput {
  url?: string
  digest?: string
  dir: string
  fetchImpl?: typeof fetch
}

/** The unpacked bundle root (holding `node_modules`), or null when there is none. */
export async function ensureProjectPackageBundle(input: ProjectBundleInput): Promise<string | null> {
  const digest = input.digest?.trim()
  if (!digest) return null
  if (!DIGEST_RE.test(digest)) {
    logger.warn('[pi] project package bundle digest is not a sha256; ignoring', { digest })
    return null
  }
  const root = join(input.dir, digest)
  if (existsSync(join(root, '.complete'))) return root
  if (!input.url) {
    logger.warn('[pi] project package bundle is not built yet; project packages load on a later session', { digest })
    return null
  }
  const staging = `${root}.partial-${process.pid}`
  const startedAt = performance.now()
  try {
    rmSync(staging, { recursive: true, force: true })
    mkdirSync(staging, { recursive: true })
    const response = await (input.fetchImpl ?? fetch)(input.url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
    if (!response.ok || !response.body) throw new Error(`download answered ${response.status}`)
    await pipeline(Readable.fromWeb(response.body as never), tar.x({ cwd: staging, strict: true }))
    if (!existsSync(join(staging, 'node_modules'))) throw new Error('bundle has no node_modules')
    writeFileSync(join(staging, '.complete'), digest)
    rmSync(root, { recursive: true, force: true })
    renameSync(staging, root)
    logger.info('[pi] project package bundle ready', { digest, ms: Math.round(performance.now() - startedAt) })
    return root
  } catch (err) {
    rmSync(staging, { recursive: true, force: true })
    logger.warn('[pi] project package bundle download failed; project packages are left out', { digest, err: (err as Error).message })
    return null
  }
}
