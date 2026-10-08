import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { runGit } from '@/lib/git/git'
import { logger } from '@/lib/log/logger'
import { downloadAndExtractProjectSnapshot } from '../config-provider/s3/s3-config-provider'
import { downloadConfigArchive, type ConfigReleaseApi } from './api-client'
import {
  materializeRelease,
  materializeReleaseFromTree,
  releaseDir,
  verifyRelease,
  writeReleaseManifest,
  type ReleaseManifest,
} from './boot-config'
import type { ConfigReleaseSnapshot } from './descriptor'

/** Where a release on this box came from. */
export type ReleaseTransport = 'disk' | 'workspace' | 'snapshot' | 'archive'

/** Download, verify and extract budget for one snapshot. Stalls fail sooner (the transfer's inactivity watchdog). */
const SNAPSHOT_TIMEOUT_MS = 5 * 60_000

export interface ObtainReleaseInput {
  root: string
  manifest: ReleaseManifest
  /** The descriptor's project snapshot of the release's commit (v3), or null. */
  snapshot: ConfigReleaseSnapshot | null
  /** Downloads the API-built archive, when the release has one. */
  api: ConfigReleaseApi | null
  /** The session's checkout, or null when it is not ready or not to be read. */
  workspace: string | null
  prepare?: (stagedDir: string) => Promise<void>
  managedSkillsDir?: string
  /** Test seam for the snapshot transfer. */
  fetchImpl?: typeof fetch
}

/**
 * Put one release on this box, from the first source that holds it:
 *
 *   1. disk      — the copy already in the store, intact.
 *   2. workspace — the session's checkout, when its HEAD is the release's
 *                  commit. A fresh box checked that commit out moments ago,
 *                  so the release costs no second download.
 *   3. snapshot  — the project snapshot of the commit, streamed to disk.
 *   4. archive   — the API-built archive, capped at `MAX_CONFIG_ARCHIVE_BYTES`.
 *
 * Every source is verified file by file against the release's blob IDs, so
 * one that does not hold the release is skipped, never served. Throws, with
 * every source's reason, when none does.
 */
export async function obtainRelease(input: ObtainReleaseInput): Promise<{ dir: string; transport: ReleaseTransport }> {
  const { root, manifest } = input
  const dir = releaseDir(root, manifest.release_id)
  const shared = { root, manifest, prepare: input.prepare, managedSkillsDir: input.managedSkillsDir }
  const reasons: string[] = []
  const done = (transport: ReleaseTransport) => ({ dir, transport })

  if (existsSync(dir) && (await verifyRelease({ dir, files: manifest.files, configDir: manifest.config_dir, managedSkillsDir: input.managedSkillsDir }))) {
    await writeReleaseManifest(root, manifest)
    return done('disk')
  }

  if (input.workspace) {
    const head = await runGit(['rev-parse', '--verify', 'HEAD'], { cwd: input.workspace }).catch(() => null)
    if (head?.code === 0 && head.stdout.trim() === manifest.source_commit) {
      try {
        await materializeReleaseFromTree({ ...shared, source: input.workspace, take: 'copy' })
        return done('workspace')
      } catch (err) {
        reasons.push(`the checkout does not hold it: ${(err as Error).message}`)
      }
    }
  }

  if (input.snapshot) {
    const stage = `${dir}.${randomUUID()}.snapshot`
    try {
      await downloadAndExtractProjectSnapshot(
        { tree: input.snapshot },
        stage,
        { timeoutMs: SNAPSHOT_TIMEOUT_MS, fetchImpl: input.fetchImpl },
      )
      await materializeReleaseFromTree({ ...shared, source: stage, take: 'move' })
      return done('snapshot')
    } catch (err) {
      reasons.push(`the project snapshot did not deliver it: ${(err as Error).message}`)
    } finally {
      await rm(stage, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  if (manifest.archive_url && input.api) {
    // Any error from here, including `feature_disabled`, is the caller's to read.
    const archive = await downloadConfigArchive(input.api, manifest.archive_url, { expectedBytes: manifest.archive_bytes })
    await materializeRelease({ ...shared, archive })
    return done('archive')
  }

  if (!input.snapshot) reasons.push('the API has no project snapshot of this commit yet')
  if (!manifest.archive_url) reasons.push('the repository is over the config archive limit, so there is no archive')
  logger.warn('[boot-config] no source holds the release', { releaseId: manifest.release_id, reasons })
  throw new Error(reasons.join('; '))
}
