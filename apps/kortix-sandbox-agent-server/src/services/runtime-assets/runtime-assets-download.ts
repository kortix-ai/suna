import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { logger } from '@/lib/log/logger'
import { fetchArtifactByChunks } from './runtime-asset-chunks'
import { resolveRunningAgentPath } from './runtime-assets'
import { isSafeOverlayPath } from './runtime-assets-state'
import { noteControlPlaneResponse } from '@/lib/kortix-api/session-token-health'
const DOWNLOAD_TIMEOUT_MS = 180_000
import { agentStateDirOf, agentBakedPathOf } from './runtime-assets-manifest'
import type { OverlayFile, RuntimeAssetsOptions } from './runtime-assets'

export async function writeOverlay(dir: string, files: OverlayFile[]): Promise<void> {
  // Stage into a sibling temp dir, then swap. A partial write into the live dir
  // would leave the overlay half-old/half-new for whatever boots next.
  await mkdir(dirname(dir), { recursive: true })
  const staging = await mkdtemp(`${dir}.staging-`)
  try {
    for (const file of files) {
      if (!isSafeOverlayPath(file.path)) {
        logger.warn('[runtime-assets] rejected unsafe overlay path', { path: file.path })
        continue
      }
      const dest = join(staging, file.path)
      await mkdir(dirname(dest), { recursive: true })
      await writeFile(dest, file.content, 'utf8')
    }
    const retired = `${dir}.retired-${process.pid}`
    await rename(dir, retired).catch(() => {})
    await rename(staging, dir)
    await rm(retired, { recursive: true, force: true }).catch(() => {})
  } catch (err) {
    await rm(staging, { recursive: true, force: true }).catch(() => {})
    throw err
  }
}

export async function fetchJson<T>(
  fetchImpl: typeof fetch,
  url: string,
  token: string,
  timeoutMs: number,
): Promise<T | null> {
  const res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    noteControlPlaneResponse(res.status, body)
    logger.warn('[runtime-assets] non-ok response', { url, status: res.status })
    return null
  }
  // A 2xx is proof the control plane answers this box again — a rotated
  // credential, or a repaired sandbox row. Clear the shared dead-token breaker
  // so the surfaces gated on it (config-release convergence) resume. Reporting
  // only failures would leave the breaker tripped forever.
  noteControlPlaneResponse(res.status, null)
  return (await res.json()) as T
}

/**
 * One reconcile pass. Returns what happened for each half so callers (and tests)
 * can assert on it. NEVER throws.
 */
/** A downloaded artifact, or the HTTP status that stopped it. */
type ArtifactFetch = { bytes: Buffer } | { status: number }

/**
 * Get one artifact's bytes: chunked when this box can supply most of them,
 * a plain download otherwise.
 *
 * The chunk path is a transfer optimization and never a second install path —
 * it returns bytes or nothing, and the caller runs the SAME `verifyArtifact`
 * over the result either way. That is deliberate: one place decides whether
 * bytes are allowed near something that will be executed.
 */
export async function fetchArtifact(
  fetchImpl: typeof fetch,
  base: string,
  token: string,
  component: 'agent' | 'cli',
  expectedSha: string,
  url: string,
  localSources: string[],
): Promise<ArtifactFetch> {
  const chunked = await fetchArtifactByChunks({
    fetchImpl,
    base,
    token,
    component,
    expectedSha,
    localSources,
    timeoutMs: DOWNLOAD_TIMEOUT_MS,
  }).catch((err) => {
    // Never fatal. The full download below is the path this one is trying to
    // save, and it is still there.
    logger.warn('[runtime-assets] chunked fetch failed; falling back to the full download', {
      component,
      err: String(err),
    })
    return null
  })
  if (chunked) return { bytes: chunked }
  const res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  })
  if (!res.ok) return { status: res.status }
  return { bytes: Buffer.from(await res.arrayBuffer()) }
}

/**
 * Every binary this box already holds — the chunk store.
 *
 * There is no chunk cache on disk and there should not be one: ~90 MB of both
 * the CLI and the daemon is the same embedded Bun runtime, so the files the
 * box RUNS already carry almost everything a new build needs. They are always
 * current, never stale, and cost no extra disk. Missing entries are skipped by
 * the indexer, so listing a path that may not exist is free.
 */
export async function chunkStoreSources(
  cliPath: string,
  options: RuntimeAssetsOptions,
): Promise<string[]> {
  const stateDir = agentStateDirOf(options)
  return [
    cliPath,
    await resolveRunningAgentPath(options),
    agentBakedPathOf(options),
    join(stateDir, 'agent.current'),
  ]
}
