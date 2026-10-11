import type { Config } from '../config/config'
import { logger } from '../log/logger'
import { PROJECT_SNAPSHOT_FORMAT, SHA256_RE, type ProjectSnapshotDescriptor, type SnapshotObjectRef } from './contract'
import { ProjectSnapshotError, abortReason, errorMessage, isAbortError } from './errors'
import { linkedSignal } from './transfer'

/** Per-attempt wall clock for the descriptor call. */
const DESCRIPTOR_TIMEOUT_MS = 10_000

/** `…/v1/git/<project>.git` → `…/v1/git/<project>.git/project-snapshot?sha=<sha>` */
export function buildProjectSnapshotDescriptorUrl(repoUrl: string, sha: string): string {
  const url = new URL(repoUrl)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ProjectSnapshotError('precondition', 'not-configured', `project snapshot requires an HTTP(S) Git proxy URL, got ${url.protocol}`)
  }
  url.username = ''
  url.password = ''
  url.hash = ''
  url.pathname = `${url.pathname.replace(/\/$/, '')}/project-snapshot`
  url.search = ''
  url.searchParams.set('sha', sha)
  return url.toString()
}

function objectRefOk(ref: SnapshotObjectRef | undefined): boolean {
  return (
    typeof ref?.url === 'string' &&
    SHA256_RE.test(ref?.sha256 ?? '') &&
    Number.isInteger(ref?.bytes) &&
    (ref?.bytes ?? 0) > 0
  )
}

export async function fetchProjectSnapshotDescriptor(
  cfg: Config,
  sha: string,
  options: { fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<ProjectSnapshotDescriptor> {
  if (!cfg.repoUrl || !cfg.sandboxToken) {
    throw new ProjectSnapshotError('precondition', 'not-configured', 'KORTIX_REPO_URL and KORTIX_TOKEN are required')
  }
  const url = buildProjectSnapshotDescriptorUrl(cfg.repoUrl, sha)
  const link = linkedSignal(options.signal, DESCRIPTOR_TIMEOUT_MS)
  let res: Response
  try {
    res = await (options.fetchImpl ?? fetch)(url, {
      headers: { accept: 'application/json', authorization: `Bearer ${cfg.sandboxToken}` },
      signal: link.signal,
    })
  } catch (err) {
    const reason = isAbortError(err) ? abortReason(options, link.timedOut()) : 'unavailable'
    throw new ProjectSnapshotError('descriptor', reason, `descriptor request failed: ${errorMessage(err)}`, 0, { cause: err })
  } finally {
    link.dispose()
  }
  if (res.status === 404) {
    throw new ProjectSnapshotError('descriptor', 'missing', `no prepared archive for ${sha}`)
  }
  if (res.status === 401 || res.status === 403) {
    throw new ProjectSnapshotError('descriptor', 'denied', `descriptor authorization denied (HTTP ${res.status})`)
  }
  if (!res.ok) {
    throw new ProjectSnapshotError('descriptor', 'unavailable', `descriptor HTTP ${res.status}`)
  }
  let body: ProjectSnapshotDescriptor
  try {
    body = (await res.json()) as ProjectSnapshotDescriptor
  } catch (err) {
    throw new ProjectSnapshotError('descriptor', 'malformed', 'descriptor is not valid JSON', 0, { cause: err })
  }
  if (!describesSnapshot(body, sha)) {
    throw new ProjectSnapshotError('descriptor', 'malformed', 'descriptor does not describe the expected snapshot objects')
  }
  return body
}

function describesSnapshot(body: ProjectSnapshotDescriptor | undefined, sha: string): body is ProjectSnapshotDescriptor {
  return (
    body?.format === PROJECT_SNAPSHOT_FORMAT &&
    body.commit_sha === sha &&
    objectRefOk(body.tree) &&
    Number.isInteger(body.tree?.entries) &&
    objectRefOk(body.blobs) &&
    typeof body.repository?.external_id === 'string'
  )
}

/**
 * A URL that will die within this margin is not worth starting a transfer on:
 * a slow provider create already ate into the descriptor's lifetime.
 */
const ENV_DESCRIPTOR_EXPIRY_MARGIN_MS = 30_000

/**
 * The descriptor the API presigned at session create
 * (KORTIX_PROJECT_SNAPSHOT_DESCRIPTOR, base64 JSON of the proxy's body). Used
 * for the FIRST attempt only, and only when it names the pinned sha and both
 * URLs have the margin left; anything else → null, and the proxy is asked as
 * before. Never fatal: a bad env value costs one round trip, not the boot.
 */
export function parseEnvProjectSnapshotDescriptor(cfg: Config, sha: string): ProjectSnapshotDescriptor | null {
  const raw = cfg.projectSnapshotDescriptor
  if (!raw) return null
  let body: ProjectSnapshotDescriptor | undefined
  try {
    body = JSON.parse(Buffer.from(raw, 'base64').toString('utf8')) as ProjectSnapshotDescriptor
  } catch {
    logger.warn('[project-snapshot] env descriptor is not base64 JSON; asking the proxy')
    return null
  }
  if (!describesSnapshot(body, sha)) {
    logger.warn('[project-snapshot] env descriptor does not describe the pinned snapshot; asking the proxy')
    return null
  }
  const soonest = Math.min(Date.parse(body.tree.expires_at), Date.parse(body.blobs.expires_at))
  if (!Number.isFinite(soonest) || soonest - Date.now() < ENV_DESCRIPTOR_EXPIRY_MARGIN_MS) {
    logger.info('[project-snapshot] env descriptor expired or about to; asking the proxy', {
      expiresAt: Number.isFinite(soonest) ? new Date(soonest).toISOString() : null,
    })
    return null
  }
  return body
}
