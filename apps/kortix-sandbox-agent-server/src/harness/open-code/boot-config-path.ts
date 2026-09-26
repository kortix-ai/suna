import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  activateBootConfig,
  bootConfigRoot,
  materializeRelease,
  pruneBootConfigs,
  quarantineRelease,
  readBootConfigPointer,
  readQuarantine,
  readReleaseManifest,
  releaseDir,
  verifyRelease,
  writeReleaseManifest,
  type ReleaseManifest,
} from '../../boot-config'
import {
  configReleaseApiFrom,
  downloadConfigArchive,
  fetchConfigReleaseDescriptor,
  isFeatureDisabledError,
  type ConfigReleaseApi,
} from '../../config-release/api-client'
import type { ConfigReleaseDescriptor } from '../../config-release/descriptor'
import { clearConfigReleaseNotice } from '../../config-release/notice'
import { logger } from '../../logger'
import { repairOpencodeConfigDir } from './apple-double'
import { serveConfigDir } from './boot-link'
import { resolveOpencodeConfigDir, type OpenCodeConfig } from './config'
import {
  deliverGovernance,
  effectiveReleaseId,
  manifestFromDescriptor,
  noteRunningConfig,
  prepareConfigDir,
  preparePlatformConfigDir,
  setRunningConfig,
  type ConfigSource,
} from './config-release'
import { VERIFY_READY_TIMEOUT_MS, type Opencode } from './lifecycle'
import { pluginFilesFrom, provenCheck, toolNamesFromFiles, type ProvenCheckInput } from './proven-check'

/**
 * THE boot path. One function decides what OpenCode runs, and nothing else does
 * (docs/specs/config-releases.md; PLAN-one-boot-path C1–C8).
 *
 * The straight line, in order, with no timer anywhere on it:
 *
 *   0. Point the boot link at the image default and spawn OpenCode on it with
 *      the directory gate CLOSED. OpenCode's process boot (~3–7 s) does not
 *      read the config dir; only its per-directory Instance does, and the first
 *      thing that builds one is the proof in step 5.
 *   1. Ask the API for the desired release. THIS request is the `config_releases`
 *      flag evaluation for this boot, and its answer is assigned HERE — never
 *      inside a `.then()` that a wait can outrun (the 2026-09-24 defect: losing
 *      a 3,000 ms race by 282 ms booted `/workspace` and reported
 *      `proven:true, fallback_reason:null`).
 *   2. Flag off, or no API at all: one marked early return to the pre-release
 *      behaviour. That branch is the ONLY place `/workspace` is read to decide
 *      config (C4, C8).
 *   3+4. The candidate list, best first: the desired release (materialized here,
 *      with NO timer — the release IS the config and the code waits for it),
 *      then the last release this box proved, then the image default. Every
 *      step that is skipped states why (C6, C7).
 *   5. Serve each candidate through the boot link and prove it — "proven" means
 *      OpenCode answers its own session API on that directory (C2). The first
 *      pass wins. The image default is the floor and is proved like any other
 *      candidate, so a box that runs it knows whether it works.
 *   6. Activate the pointer, prune, and write the running state ONCE.
 *   7. Open the readiness gate — lexically after the proof, so a box is never
 *      reportable as ready on a config nothing proved (C3).
 *
 * Never throws for a config reason: the image default is always the last
 * candidate. It throws only when the boot link itself cannot be written, which
 * is a broken box, not a broken config.
 */

/** What the API answered on THIS boot. Assigned once, on the straight line. */
interface DescriptorAnswer {
  /** The `config_releases` flag, as the API answered it on this boot. */
  releasesEnabled: boolean
  descriptor: ConfigReleaseDescriptor | null
  /** Why there is no descriptor. Null when one arrived, or when none was owed. */
  reason: string | null
}

export interface BootConfigPathInput {
  cfg: OpenCodeConfig
  opencode: Pick<Opencode, 'getInternalUrl' | 'markWorkspaceReady'>
  /**
   * The repository checkout. Resolves with its failure message, or null. The
   * candidates are built while this runs; nothing is served before it settles,
   * because an Instance built against a partial tree caches failed tool imports
   * for the life of the process.
   */
  workspace: Promise<string | null>
  /** Spawn OpenCode on the boot link. Called exactly once, in step 0. */
  start: () => Promise<void>
  /** Replace the running OpenCode so it re-reads the boot link. */
  respawn: () => Promise<void>
  /**
   * Rewrite the composed config and dispose idle instances in place. True when
   * the running process will re-read the link without a respawn; false means
   * the caller must respawn. Absent: always respawn.
   */
  refresh?: () => Promise<boolean>
  /**
   * Told once, right before the gate opens, so the host can mirror the state
   * its own proxy reads. The GATE itself is opened here and nowhere else.
   */
  onReady?: () => void
  api?: ConfigReleaseApi | null
  root?: string
  managedSkillsDir?: string
  /** Dependencies + overlay for a config dir. Injectable for tests. */
  prepare?: (dir: string, platformOwned: boolean) => Promise<void>
  prove?: typeof provenCheck
  proveFetch?: typeof fetch
  proofBudgetMs?: number
  proofOptions?: Partial<Pick<ProvenCheckInput, 'requestTimeoutMs' | 'hangLimit' | 'pollMs' | 'fetchImpl'>>
  mark?: (label: string) => void
  descriptorTimeoutMs?: number
}

export interface BootConfigPathResult {
  dir: string
  source: ConfigSource
  releaseId: string | null
  sourceCommit: string | null
  proven: boolean
  fallbackReason: string | null
  failedReleaseId: string | null
  /** The `config_releases` flag as the API answered it on this boot. */
  releasesEnabled: boolean
}

interface Candidate {
  dir: string
  source: ConfigSource
  /** One phrase, for the log and for `fallback_reason`. */
  label: string
  releaseId: string | null
  sourceCommit: string | null
  manifest: ReleaseManifest | null
}

const MAX_FALLBACK_REASON = 1_000

function boundedReason(reasons: readonly string[]): string | null {
  const reason = reasons.filter(Boolean).join('; ')
  if (!reason) return null
  return reason.length > MAX_FALLBACK_REASON ? `${reason.slice(0, MAX_FALLBACK_REASON - 1)}…` : reason
}

async function pluginFilesInDir(dir: string): Promise<string[]> {
  const entries = await readdir(join(dir, 'plugins'), { withFileTypes: true }).catch(() => [])
  return pluginFilesFrom(entries.filter((entry) => entry.isFile()).map((entry) => `plugins/${entry.name}`))
}

async function toolNamesInDir(dir: string): Promise<string[]> {
  const entries = await readdir(join(dir, 'tools'), { withFileTypes: true }).catch(() => [])
  return toolNamesFromFiles(entries.filter((entry) => entry.isFile()).map((entry) => `tools/${entry.name}`))
}

/**
 * Step 1. Ask the API what to run, and write the flag answer on the spot.
 *
 * Every outcome is a value, so the caller reads one variable instead of racing
 * a promise: a descriptor means the feature is ON, `403 feature_disabled` means
 * OFF, and anything else means the API could not be asked — valve B, which
 * keeps the feature ON and falls back to the copy already on disk.
 */
async function askForTheDesiredRelease(
  api: ConfigReleaseApi | null,
  timeoutMs: number | undefined,
): Promise<DescriptorAnswer> {
  if (!api) {
    return {
      releasesEnabled: false,
      descriptor: null,
      reason: 'this box has no API to ask (KORTIX_API_URL, KORTIX_PROJECT_ID, KORTIX_SESSION_ID or KORTIX_TOKEN is unset)',
    }
  }
  try {
    return { releasesEnabled: true, descriptor: await fetchConfigReleaseDescriptor(api, { timeoutMs }), reason: null }
  } catch (err) {
    if (isFeatureDisabledError(err)) {
      return { releasesEnabled: false, descriptor: null, reason: 'config releases are disabled for this project' }
    }
    // Valve B: the API or the store could not be reached. The feature stays on
    // and the box runs the previously available verified copy on disk.
    return {
      releasesEnabled: true,
      descriptor: null,
      reason: `the API could not be asked for this session's release: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

/**
 * Steps 3 and 4. The candidates, best first, with the desired release already
 * on disk. No timer: a candidate that has to be downloaded is waited for.
 *
 * `/workspace` is deliberately absent. A box must never silently run a stale
 * session checkout as the project's config (C4).
 */
async function bootCandidates(
  input: BootConfigPathInput,
  root: string,
  api: ConfigReleaseApi | null,
  answer: DescriptorAnswer,
  reasons: string[],
): Promise<Candidate[]> {
  const { cfg } = input
  const candidates: Candidate[] = []
  const desiredId = answer.descriptor ? effectiveReleaseId(answer.descriptor) : null

  if (answer.descriptor && desiredId !== null && answer.descriptor.archive !== null && api) {
    const manifest = manifestFromDescriptor(answer.descriptor, desiredId)
    const dir = releaseDir(root, desiredId)
    const quarantined = (await readQuarantine(root))[desiredId]
    if (quarantined) {
      reasons.push(`release ${desiredId.slice(0, 12)} is quarantined on this box: ${quarantined.reason}`)
    } else {
      try {
        const intact =
          existsSync(dir) &&
          (await verifyRelease({ dir, files: manifest.files, managedSkillsDir: input.managedSkillsDir }))
        if (intact) {
          await writeReleaseManifest(root, manifest)
        } else {
          const archive = await downloadConfigArchive(api, manifest.archive_url, {
            expectedBytes: manifest.archive_bytes,
          })
          await materializeRelease({
            root,
            manifest,
            archive,
            managedSkillsDir: input.managedSkillsDir,
            prepare: (staged) => (input.prepare ?? defaultPrepare(input))(staged, true),
          })
        }
        input.mark?.('config-release-extracted')
        candidates.push({
          dir,
          source: 'release',
          label: `release ${desiredId.slice(0, 12)}`,
          releaseId: desiredId,
          sourceCommit: manifest.source_commit,
          manifest,
        })
      } catch (err) {
        // Valve B again, one level down: the descriptor arrived but the archive
        // did not. Nothing is wrong with the release itself, so it is NOT
        // quarantined; the next trigger retries it.
        reasons.push(
          `release ${desiredId.slice(0, 12)} could not be built: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
  } else if (answer.descriptor && desiredId !== null && answer.descriptor.archive === null) {
    // Governance only: no repository access, or no config dir on the base
    // branch. The image default runs with the release's compiled governance.
    candidates.push({
      dir: cfg.defaultOpencodeConfigDir,
      source: 'image-default',
      label: `governance-only release ${desiredId.slice(0, 12)}`,
      releaseId: desiredId,
      sourceCommit: null,
      manifest: null,
    })
    if (answer.descriptor.reason) reasons.push(answer.descriptor.reason)
  }

  // Valve B's floor: the previously available config on disk.
  const pointer = await readBootConfigPointer(root).catch(() => null)
  if (pointer && !candidates.some((candidate) => candidate.releaseId === pointer.release_id)) {
    if (!pointer.proven) {
      reasons.push(`release ${pointer.release_id.slice(0, 12)} was never proven on this box`)
    } else {
      const manifest = await readReleaseManifest(root, pointer.release_id)
      const intact =
        manifest !== null &&
        (await verifyRelease({ dir: pointer.dir, files: manifest.files, managedSkillsDir: input.managedSkillsDir }))
      if (intact && manifest) {
        candidates.push({
          dir: pointer.dir,
          source: 'release',
          label: `last proven release ${pointer.release_id.slice(0, 12)}`,
          releaseId: pointer.release_id,
          sourceCommit: pointer.source_commit,
          manifest,
        })
      } else {
        reasons.push(`last proven release ${pointer.release_id.slice(0, 12)} no longer verifies on disk`)
      }
    }
  }

  // The floor. Always last, always present, always proved.
  if (!candidates.some((candidate) => candidate.dir === cfg.defaultOpencodeConfigDir && candidate.releaseId === null)) {
    candidates.push({
      dir: cfg.defaultOpencodeConfigDir,
      source: 'image-default',
      label: 'image default config',
      releaseId: null,
      sourceCommit: null,
      manifest: null,
    })
  }
  return candidates
}

function defaultPrepare(input: BootConfigPathInput): (dir: string, platformOwned: boolean) => Promise<void> {
  return (dir, platformOwned) =>
    platformOwned
      ? preparePlatformConfigDir(dir, input.managedSkillsDir)
      : prepareConfigDir(dir, input.managedSkillsDir, {}, input.cfg.projectTarget)
}

export async function bootOpenCodeConfig(input: BootConfigPathInput): Promise<BootConfigPathResult> {
  const { cfg, opencode } = input
  const root = input.root ?? bootConfigRoot()
  const api =
    input.api === undefined
      ? configReleaseApiFrom({ apiUrl: cfg.apiUrl, projectId: cfg.projectId, sandboxToken: cfg.sandboxToken })
      : input.api
  const prepare = input.prepare ?? defaultPrepare(input)
  const budget = input.proofBudgetMs ?? VERIFY_READY_TIMEOUT_MS
  const linkFailures: string[] = []
  /** The one seam that changes what OpenCode reads. A refusal is stated, not thrown. */
  const point = async (dir: string, why: string): Promise<boolean> => {
    try {
      await serveConfigDir(dir, why, root)
      return true
    } catch (err) {
      const reason = `the boot link could not be pointed at ${dir}: ${err instanceof Error ? err.message : String(err)}`
      if (!linkFailures.includes(reason)) linkFailures.push(reason)
      logger.error('[boot-config] the boot link could not be written', { dir, why, err: String(err) })
      return false
    }
  }
  const prove = (dir: string, toolNames: readonly string[], pluginFiles: readonly string[]) =>
    (input.prove ?? provenCheck)(opencode.getInternalUrl(), Date.now() + budget, {
      directory: cfg.projectTarget,
      toolNames,
      pluginFiles,
      configDir: dir,
      waitForSessionApi: true,
      fetchImpl: input.proveFetch,
      ...input.proofOptions,
    })

  // ── Step 0 ─────────────────────────────────────────────────────────────────
  // The image default through the boot link, and OpenCode on its way up. The
  // gate is closed, so nothing can build an Instance against this placeholder.
  await point(cfg.defaultOpencodeConfigDir, 'the placeholder the early spawn starts on')
  const started = input.start()

  // ── Step 1 ─────────────────────────────────────────────────────────────────
  const answer = await askForTheDesiredRelease(api, input.descriptorTimeoutMs)
  if (answer.descriptor) input.mark?.('config-release-fetched')

  // ── Step 2 ─────────────────────────────────────────────────────────────────
  // LEGACY BRANCH — `config_releases` is off for this project, or this box has
  // no API to ask. Exactly the pre-release behaviour: OpenCode reads the
  // session's own checkout, and this is the only line in the boot path that
  // reads `/workspace` to decide anything (C8).
  if (!answer.releasesEnabled) {
    const workspaceError = await input.workspace
    const dir = workspaceError ? cfg.defaultOpencodeConfigDir : await resolveOpencodeConfigDir(cfg)
    const source: ConfigSource = dir === cfg.defaultOpencodeConfigDir ? 'image-default' : 'workspace'
    // No release runs, so the session notice would be a false statement about
    // which commit's config this box serves.
    clearConfigReleaseNotice()
    // A checkout from a macOS-authored archive carries AppleDouble `._` files
    // that OpenCode reads as config. Unchanged pre-release behaviour.
    if (source === 'workspace') await repairOpencodeConfigDir(dir)
    // A working tree's `package.json` is a tracked user file, so its
    // dependencies are prepared without the platform's plugin pin or lockfile
    // sentinel — the pre-release preparation, unchanged.
    await prepare(dir, source === 'image-default')
    input.mark?.('config-deps')
    await point(dir, `config releases are not in play: ${answer.reason ?? 'no reason given'}`)
    await started
    if (!(await input.refresh?.().catch(() => false))) await input.respawn()
    logger.info('[boot-config] config releases are not in play; opencode reads the checkout', {
      dir,
      source,
      reason: answer.reason,
    })
    setRunningConfig({
      release_id: null,
      desired_release_id: null,
      source,
      mode: null,
      proven: true,
      fallback_reason: null,
      failed_release_id: null,
      source_commit: null,
    })
    input.onReady?.()
    opencode.markWorkspaceReady()
    return {
      dir,
      source,
      releaseId: null,
      sourceCommit: null,
      proven: true,
      fallbackReason: null,
      failedReleaseId: null,
      releasesEnabled: false,
    }
  }

  // ── Steps 3 and 4 ──────────────────────────────────────────────────────────
  const reasons: string[] = [...linkFailures, ...(answer.reason ? [answer.reason] : [])]
  const desiredReleaseId = answer.descriptor ? effectiveReleaseId(answer.descriptor) : null
  const candidates = await bootCandidates(input, root, api, answer, reasons)

  // The checkout has to be complete before anything builds an Instance: the
  // proof below is the first directory-scoped request this process answers.
  const workspaceError = await input.workspace
  if (workspaceError) reasons.push(`the repository did not materialize: ${workspaceError}`)
  await started

  // ── Step 5 ─────────────────────────────────────────────────────────────────
  let chosen: Candidate = candidates[candidates.length - 1]!
  let proven = false
  let failedReleaseId: string | null = null
  for (const [index, candidate] of candidates.entries()) {
    const last = index === candidates.length - 1
    // Governance and dependencies for the spawn. A release was prepared inside
    // its staging directory before it was sealed; the image default is the
    // platform's own directory and is prepared the same way, which is what
    // keeps OpenCode's installer from reifying node_modules through the boot
    // link (~10 s, measured 2026-09-22).
    // A release delivers its own governance. A step down to the image default
    // KEEPS the last release's governance on purpose: the agents are the
    // project's, whether or not its config dir loads, and dropping them would
    // leave the box with no agents at all. `deliverGovernance(null, …)` is a
    // no-op for exactly that reason.
    deliverGovernance(candidate.manifest?.compiled_governance ?? null, candidate.manifest?.compiled_governance_etag ?? null)
    if (!candidate.manifest) {
      await prepare(candidate.dir, true)
      input.mark?.('config-deps')
    }
    if (candidate.manifest) {
      // The session runs this commit's config while `/workspace` is a separate
      // checkout that may be behind it. Written BEFORE the spawn: the composed
      // config declares the file in OpenCode's `instructions`.
      noteRunningConfig(
        {
          source_commit: candidate.manifest.source_commit,
          config_dir: candidate.manifest.config_dir,
          agent_repoint_reason: candidate.manifest.agent_repoint_reason ?? null,
        },
        candidate.dir,
      )
    }
    await point(candidate.dir, `boot candidate ${index + 1} of ${candidates.length}: ${candidate.label}`)
    if (index === 0 && (await input.refresh?.().catch(() => false))) {
      // The process from step 0 has not read a config dir yet, so repointing
      // the link and rewriting the composed config is enough — no respawn.
    } else {
      await input.respawn()
    }
    const proof = await prove(
      candidate.dir,
      candidate.manifest ? toolNamesFromFiles(candidate.manifest.files) : await toolNamesInDir(candidate.dir),
      candidate.manifest ? pluginFilesFrom(candidate.manifest.files) : await pluginFilesInDir(candidate.dir),
    )
    if (proof.ok) {
      chosen = candidate
      proven = true
      break
    }
    // Valve A: present, but it does not load. Say so, then step down.
    reasons.push(`${candidate.label} failed: ${proof.reason}`)
    logger.warn('[boot-config] a boot candidate did not load; stepping down', {
      dir: candidate.dir,
      source: candidate.source,
      candidate: candidate.label,
      reason: proof.reason,
    })
    if (candidate.releaseId && candidate.manifest) {
      failedReleaseId = candidate.releaseId
      await quarantineRelease(root, candidate.releaseId, proof.reason)
    }
    if (last) {
      // The image default is the floor: the box runs it even unproven, and
      // health says so, rather than never becoming reportable at all.
      chosen = candidate
      break
    }
  }

  // ── Step 6 ─────────────────────────────────────────────────────────────────
  if (proven && chosen.manifest && chosen.releaseId) {
    const previous = await readBootConfigPointer(root).catch(() => null)
    await activateBootConfig(root, {
      release_id: chosen.releaseId,
      source_commit: chosen.manifest.source_commit,
      config_dir: chosen.manifest.config_dir,
      dir: chosen.dir,
      proven: true,
    })
    await pruneBootConfigs(root, previous ? [chosen.releaseId, previous.release_id] : [chosen.releaseId])
    input.mark?.('config-release-proven')
  }
  const fallbackReason = boundedReason([...reasons, ...linkFailures.filter((reason) => !reasons.includes(reason))])
  setRunningConfig({
    release_id: chosen.releaseId,
    desired_release_id: desiredReleaseId,
    source: chosen.source,
    mode: 'follow-base',
    proven,
    fallback_reason: fallbackReason,
    failed_release_id: failedReleaseId,
    source_commit: chosen.sourceCommit,
  })
  logger.info('[boot-config] opencode runs this config', {
    dir: chosen.dir,
    source: chosen.source,
    releaseId: chosen.releaseId,
    desiredReleaseId,
    proven,
    fallbackReason,
  })

  // ── Step 7 ─────────────────────────────────────────────────────────────────
  // THE readiness gate (PLAN-one-boot-path C3 / tripwire T3). It is opened in
  // exactly one place in the daemon, and that place is lexically after the
  // proof above, so a box can never be reportable as ready on a config nothing
  // proved.
  input.onReady?.()
  opencode.markWorkspaceReady()

  // ── Step 8 ─────────────────────────────────────────────────────────────────
  return {
    dir: chosen.dir,
    source: chosen.source,
    releaseId: chosen.releaseId,
    sourceCommit: chosen.sourceCommit,
    proven,
    fallbackReason,
    failedReleaseId,
    releasesEnabled: true,
  }
}
