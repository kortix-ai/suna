import { logger } from '@/lib/log/logger'
import { downloadSignedArchive } from './api-client'
import { parseConfigReleaseDescriptor, type ConfigReleaseDescriptor } from './descriptor'

/**
 * The published release the API signed at session create
 * (`KORTIX_CONFIG_RELEASE`, base64 JSON; apps/api config-releases/publish.ts).
 * It names the release and two signed store URLs: its descriptor and its
 * archive. The box reads both from the store and asks the API nothing.
 */
export interface PublishedRelease {
  descriptor: ConfigReleaseDescriptor
  /** The archive download, started together with the descriptor read. */
  archive: Promise<Buffer>
}

/** A URL this close to expiry is not used: the download could outlive it. */
const EXPIRY_MARGIN_MS = 30_000
const DESCRIPTOR_TIMEOUT_MS = 10_000

/**
 * Read the published release, or null when there is none or it cannot be
 * used. Null is never fatal: the caller asks the config-release route, as a
 * box did before releases were published.
 */
export async function readPublishedRelease(raw: string | undefined): Promise<PublishedRelease | null> {
  if (!raw) return null
  let env: { release_id?: unknown; descriptor_url?: unknown; archive_url?: unknown; expires_at?: unknown }
  try {
    env = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'))
  } catch {
    logger.warn('[boot-config] KORTIX_CONFIG_RELEASE is not base64 JSON; asking the API')
    return null
  }
  const { release_id: releaseId, descriptor_url: descriptorUrl, archive_url: archiveUrl } = env
  if (typeof releaseId !== 'string' || typeof descriptorUrl !== 'string' || typeof archiveUrl !== 'string') {
    logger.warn('[boot-config] KORTIX_CONFIG_RELEASE lacks a field; asking the API')
    return null
  }
  const expiresAt = Date.parse(String(env.expires_at))
  if (!Number.isFinite(expiresAt) || expiresAt - Date.now() < EXPIRY_MARGIN_MS) {
    logger.info('[boot-config] published release URLs expired; asking the API', { releaseId })
    return null
  }

  const archive = downloadSignedArchive(archiveUrl)
  // Read by obtainRelease, or never: a box that already holds the release on disk does not need it.
  archive.catch(() => undefined)
  try {
    const res = await fetch(descriptorUrl, { redirect: 'error', signal: AbortSignal.timeout(DESCRIPTOR_TIMEOUT_MS) })
    if (!res.ok) throw new Error(`the store answered ${res.status}`)
    const descriptor = parseConfigReleaseDescriptor(await res.json())
    if (descriptor.release_id !== releaseId) throw new Error(`the descriptor names release ${descriptor.release_id}`)
    return { descriptor, archive }
  } catch (err) {
    logger.warn('[boot-config] published release descriptor unreadable; asking the API', { releaseId, err: (err as Error).message })
    return null
  }
}
