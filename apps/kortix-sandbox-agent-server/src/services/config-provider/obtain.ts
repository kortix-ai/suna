import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import type { Config } from '@/lib/config/config'
import { execGit, gitWithAuth, resolveCloneCredential } from '@/lib/git/git'
import { logger } from '@/lib/log/logger'
import { downloadAndExtractProjectSnapshot } from '@/lib/project-snapshot/archive'
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
export type ReleaseTransport = 'disk' | 'snapshot' | 'archive' | 'git'

/** Download, verify and extract budget for one snapshot. Stalls fail sooner (the transfer's inactivity watchdog). */
const SNAPSHOT_TIMEOUT_MS = 5 * 60_000

/** Budget for the one-commit Git fetch. `http.lowSpeed*` aborts a stalled transfer sooner. */
const GIT_FETCH_TIMEOUT_MS = 60_000

export interface ObtainReleaseInput {
  root: string
  manifest: ReleaseManifest
  /** The descriptor's project snapshot of the release's commit (v3), or null. */
  snapshot: ConfigReleaseSnapshot | null
  /** Downloads the API-built archive, when the release has one. */
  api: ConfigReleaseApi | null
  /** The archive from the published release's signed store URL (`published.ts`), tried before the API. */
  signedArchive?: Promise<Buffer>
  /** The project remote (`KORTIX_REPO_URL`, the Kortix Git proxy): the last source. */
  git: Pick<Config, 'repoUrl' | 'apiUrl' | 'projectId' | 'sandboxToken'> | null
  prepare?: (stagedDir: string) => Promise<void>
  managedSkillsDir?: string
  /** Test seam for the snapshot transfer. */
  fetchImpl?: typeof fetch
}

/**
 * Put one release on this box, from the first source that holds it:
 *
 *   1. disk     — the copy already in the store, intact.
 *   2. snapshot — the project snapshot of the commit, streamed from S3.
 *   3. archive  — the API-built archive, capped at `MAX_CONFIG_ARCHIVE_BYTES`:
 *                 first from the published release's signed store URL, then
 *                 through the API.
 *   4. git      — the commit alone (`--depth 1`) from the project remote: a
 *                 tree over the archive cap whose snapshot is not built yet.
 *
 * The session's `/workspace` checkout is never a source. The config provider
 * and the workspace provider download the same commit in parallel, each into
 * its own directory, and neither waits for the other.
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

  if (input.snapshot) {
    const stage = `${dir}.${randomUUID()}.snapshot`
    try {
      await downloadAndExtractProjectSnapshot(
        { tree: input.snapshot },
        stage,
        { timeoutMs: SNAPSHOT_TIMEOUT_MS, fetchImpl: input.fetchImpl },
      )
      await materializeReleaseFromTree({ ...shared, source: stage, transport: 'snapshot' })
      return done('snapshot')
    } catch (err) {
      reasons.push(`the project snapshot did not deliver it: ${(err as Error).message}`)
    } finally {
      await rm(stage, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  if (manifest.archive_url && input.signedArchive) {
    try {
      const archive = await input.signedArchive
      if (manifest.archive_bytes && archive.length !== manifest.archive_bytes) {
        throw new Error(`it is ${archive.length} bytes; the release says ${manifest.archive_bytes}`)
      }
      await materializeRelease({ ...shared, archive })
      return done('archive')
    } catch (err) {
      reasons.push(`the published archive did not deliver it: ${(err as Error).message}`)
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

  if (input.git?.repoUrl) {
    const stage = `${dir}.${randomUUID()}.git`
    try {
      await fetchCommit(input.git, manifest.source_commit, stage)
      await materializeReleaseFromTree({ ...shared, source: stage, transport: 'git' })
      return done('git')
    } catch (err) {
      reasons.push(`the project remote did not deliver it: ${(err as Error).message}`)
    } finally {
      await rm(stage, { recursive: true, force: true }).catch(() => undefined)
    }
  } else {
    reasons.push('this box has no project remote')
  }

  logger.warn('[boot-config] no source holds the release', { releaseId: manifest.release_id, reasons })
  throw new Error(reasons.join('; '))
}

/** Check out `commit` alone into a new repository at `dir`. Throws with git's own words. */
async function fetchCommit(cfg: NonNullable<ObtainReleaseInput['git']>, commit: string, dir: string): Promise<void> {
  const credential = await resolveCloneCredential(cfg as Config)
  await mkdir(dir, { recursive: true })
  const local = (args: string[]) => execGit(['-C', dir, '-c', 'core.hooksPath=/dev/null', ...args])
  const step = async (what: string, result: Promise<{ code: number; stderr: string }>) => {
    const { code, stderr } = await result
    if (code !== 0) throw new Error(`git ${what}: ${stderr.trim().slice(0, 300)}`)
  }
  await step('init', local(['init', '-q']))
  await step(
    'fetch',
    gitWithAuth(credential, cfg.repoUrl, [
      '-C', dir,
      '-c', 'http.lowSpeedLimit=1000', '-c', 'http.lowSpeedTime=12',
      'fetch', '-q', '--depth', '1', '--no-tags', cfg.repoUrl!, commit,
    ], { timeoutMs: GIT_FETCH_TIMEOUT_MS }),
  )
  await step('checkout', local(['checkout', '-q', '--detach', commit]))
}
