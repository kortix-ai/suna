import { createHash } from 'node:crypto'
import type { ReleaseManifest } from './boot-config'
import type { ConfigReleaseDescriptor } from './descriptor'

/**
 * The harness-neutral half of a convergence: what the descriptor means. Each
 * harness adapter decides how its runtime starts reading a release.
 */

/** A second convergence while one runs. `POST /kortix/config/converge` answers `409`. */
export class ConvergeBusyError extends Error {
  constructor() {
    super('a config convergence is already running')
    this.name = 'ConvergeBusyError'
  }
}

/**
 * The release ID to compare. The spec defines it as
 * `sha256((config_tree_id ?? "") + ":" + (compiled_governance_etag ?? ""))`,
 * null only when both are null. An API that sends null for a governance-only
 * session (no archive) gets the same ID computed here, so a governance-only
 * change still converges.
 */
export function effectiveReleaseId(descriptor: ConfigReleaseDescriptor): string | null {
  if (descriptor.release_id !== null) return descriptor.release_id
  if (descriptor.config_tree_id !== null || descriptor.compiled_governance_etag === null) return null
  return createHash('sha256').update(`:${descriptor.compiled_governance_etag}`).digest('hex')
}

/** The descriptor's release, as the store keeps it beside the extracted copy. */
export function manifestFromDescriptor(descriptor: ConfigReleaseDescriptor, releaseId: string): ReleaseManifest {
  return {
    release_id: releaseId,
    source_commit: descriptor.source_commit!,
    config_dir: descriptor.config_dir!,
    config_tree_id: descriptor.config_tree_id!,
    archive_url: descriptor.archive!.url,
    archive_bytes: descriptor.archive!.bytes,
    files: descriptor.files!,
    compiled_governance: descriptor.compiled_governance,
    compiled_governance_etag: descriptor.compiled_governance_etag,
    agent_repoint_reason: agentRepointSentence(descriptor),
  }
}

/**
 * The sentence to put in front of the session about its agent, or null.
 *
 * Only an APPLIED re-point is stated: `applied: false` means nothing moved, and
 * telling a session about a decision that did not happen is noise. The sentence
 * is the API's, rendered verbatim — the daemon never writes its own words about
 * who may use which agent.
 */
export function agentRepointSentence(
  descriptor: Pick<ConfigReleaseDescriptor, 'agent_repoint'>,
): string | null {
  const repoint = descriptor.agent_repoint
  if (!repoint || !repoint.applied) return null
  const reason = repoint.reason?.trim()
  return reason ? reason : null
}

/**
 * Deliver the release's compiled governance to the runtime, through the same
 * env seam `/kortix/env` uses. A null governance leaves the running one in
 * place: the API sends null for a project without compiled governance or for
 * a read failure, and deleting the env would drop every agent. Returns the
 * function that restores the previous values.
 */
export function deliverGovernance(
  governance: string | null,
  etag: string | null,
  env: NodeJS.ProcessEnv = process.env,
): () => void {
  if (governance === null) return () => undefined
  const previous = {
    config: env.KORTIX_COMPILED_AGENT_CONFIG,
    etag: env.KORTIX_COMPILED_AGENT_CONFIG_ETAG,
  }
  env.KORTIX_COMPILED_AGENT_CONFIG = governance
  env.KORTIX_COMPILED_AGENT_CONFIG_ETAG = etag ?? ''
  return () => {
    if (previous.config === undefined) delete env.KORTIX_COMPILED_AGENT_CONFIG
    else env.KORTIX_COMPILED_AGENT_CONFIG = previous.config
    if (previous.etag === undefined) delete env.KORTIX_COMPILED_AGENT_CONFIG_ETAG
    else env.KORTIX_COMPILED_AGENT_CONFIG_ETAG = previous.etag
  }
}
