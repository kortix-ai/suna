/**
 * Config releases on pi.
 *
 * The contract is the OpenCode adapter's (open-code/config-release.ts and
 * open-code/boot-config-path.ts): the API assigns a release, the daemon
 * downloads it, verifies every file against its Git blob ID, seals it
 * read-only under `/opt/kortix/config/<release_id>`, and reports what it runs
 * in the health `config` block. `/workspace` is never a config source while
 * the feature is on.
 *
 * What differs is how the runtime starts reading a release. pi runs inside
 * this process, so applying one is a reconfigure in place: the compiled
 * governance goes into the runtime's env and the release's `skills/` becomes
 * its skill directory. There is no second process, no standby port and no
 * restart, so no turn ends. A turn in flight still defers the apply, because a
 * reconfigure mid-turn would change the model, policy and prompt under it.
 *
 * A release is a checkout of the base branch with the repository's own layout.
 * pi reads agents from the compiled governance, and inside the release the
 * same dirs it reads in `/workspace`: `skills/` (and the legacy
 * `.kortix/opencode/skills`), and its own config dir (the repository's
 * `pi.config_dir`, `harnesses/pi` or `.kortix/pi`: skills, extensions, prompts,
 * `settings.json`), and the project tools the governance declares
 * (kortix.yaml `tools`). OpenCode's files in the release are not pi's.
 * Extensions, prompts, settings and project tools are read when the runtime
 * starts, so a release that changes them restarts the runtime in place, while
 * it is idle.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import {
  activateBootConfig,
  bootConfigRoot,
  deactivateBootConfig,
  materializeRelease,
  pruneBootConfigs,
  quarantineRelease,
  readBootConfigPointer,
  readQuarantine,
  readReleaseManifest,
  releaseDir,
  verifyRelease,
  verifyReleaseDetail,
  writeReleaseManifest,
  type ReleaseManifest,
} from '@/services/config-release/boot-config'
import {
  configReleaseApiFrom,
  downloadConfigArchive,
  fetchConfigReleaseDescriptor,
  isFeatureDisabledError,
  type ConfigReleaseApi,
} from '@/services/config-release/api-client'
import type { ConfigReleaseDescriptor } from '@/services/config-release/descriptor'
import {
  CONFIG_RELEASE_NOTICE_PATH,
  clearConfigReleaseNotice,
  writeConfigReleaseNotice,
} from '@/services/config-release/notice'
import {
  ConvergeBusyError,
  deliverGovernance,
  effectiveReleaseId,
  manifestFromDescriptor,
} from '@/services/config-release/release'
import { sessionTokenPresumedDead } from '@/lib/kortix-api/session-token-health'
import { logger } from '@/lib/log/logger'
import type { Config } from '@/lib/config/config'
import type { Config as HostConfig } from '@/lib/config/config'
import { resolvePiProjectConfigDir } from './config'
import type { ConfigReleaseReport } from '@/types/config-release'
import { MAX_SWAP_DELAY_MS, type HarnessConfigConvergeResult } from '../contract/control'
import { parseCompiledAgentConfig } from './runtime'

type ConvergeOutcome = HarnessConfigConvergeResult['outcome']

/** The part of the runtime a convergence drives. */
export interface PiReleaseRuntime {
  /** No turn running and none admitted behind it. */
  idle(): boolean
  /** Re-read the env and the skill directories. Throws when the runtime cannot take the config. */
  reconfigure(): Promise<unknown>
  /** Stop and start in place: everything is re-read, the transcript is restored. Throws when start fails. */
  restart(): Promise<unknown>
}

interface RunningConfig extends ConfigReleaseReport {
  source_commit: string | null
  /** The release root (a checkout of the repository); null off the release source. */
  dir: string | null
  /** pi's own config dir inside the release, resolved as in `/workspace`; null when it has none. */
  piDir: string | null
}

const WORKSPACE: RunningConfig = {
  release_id: null,
  desired_release_id: null,
  source: 'workspace',
  mode: null,
  proven: false,
  fallback_reason: null,
  failed_release_id: null,
  source_commit: null,
  dir: null,
  piDir: null,
}

const MAX_FALLBACK_REASON = 1_000

export interface PiConfigReleasesOptions {
  cfg: Config
  /** The env the runtime reads its governance from; `process.env` in production. */
  env: NodeJS.ProcessEnv
  /** Defaults to the API settings in `cfg`. `null` means there is no API to ask. */
  api?: ConfigReleaseApi | null
  root?: string
  managedSkillsDir?: string
  noticePath?: string
  descriptorTimeoutMs?: number
}

export interface PiConfigReleases {
  /** The health `config` block. */
  report(): ConfigReleaseReport
  /** The running release's source commit; null off the release source. */
  sourceCommit(): string | null
  /**
   * The skill directories the running config decides, after the managed
   * overlay. Null while releases are not in play: pi then reads the working tree.
   */
  skillDirs(): string[] | null
  /**
   * The pi-native config dir the running config decides (resolved inside the
   * release as in the working tree: `pi.config_dir`, `harnesses/pi`, `.kortix/pi`), or
   * null when the running config has none. Undefined while releases are not
   * in play: pi then resolves the working tree's.
   */
  piConfigDir(): string | null | undefined
  /**
   * The checkout the running config decides, where project tools and the root
   * `AGENTS.md` load from:
   * the release root, or null when it has no tree (the image default).
   * Undefined while releases are not in play: pi then reads the working tree.
   */
  projectRoot(): string | null | undefined
  /** The notice text for the system prompt, or null when no release runs. */
  notice(): string | null
  /** True once a release owns the compiled governance: a `/kortix/env` push of it is dropped. */
  governanceOwned(): boolean
  inFlight(): boolean
  /**
   * Choose what the runtime starts on. Runs once, before `PiRuntime.start()`;
   * a second call joins the first. Never throws for a config reason.
   */
  boot(mark?: (label: string) => void): Promise<void>
  /** Apply the desired release. Single flight: a call while one runs throws `ConvergeBusyError`. */
  converge(runtime: PiReleaseRuntime | null, options?: { delayBeforeSwapMs?: number }): Promise<HarnessConfigConvergeResult>
}

/**
 * The repo paths a release is built from, for the session notice. pi reads the
 * agents (through the compiled governance), the skills and the root
 * `AGENTS.md`; the legacy layout keeps agents and skills under `.kortix/opencode`.
 */
export function piReleaseSourcePaths(configDir: string | null): string[] {
  return configDir === '.kortix/opencode' ? [configDir] : ['agents', 'skills', 'AGENTS.md']
}

/** pi's own config dir inside a release root, resolved exactly as in the working tree. */
function piDirIn(releaseRoot: string): Promise<string | null> {
  return resolvePiProjectConfigDir({ projectTarget: releaseRoot } as HostConfig)
}

/**
 * What only a runtime start reads from a release: everything in pi's own
 * config dir except its skills, and the tools (the project tools and the
 * Kortix tool list in the governance, and every file in the folder of each
 * tool module).
 */
function startOnlyFiles(release: Pick<ReleaseManifest, 'files' | 'compiled_governance'> | null, releaseRoot: string | null, piDir: string | null): string {
  if (!releaseRoot || !release) return ''
  const pi = piDir ? `${relative(releaseRoot, piDir)}/` : null
  const governance = parseCompiledAgentConfig(release.compiled_governance ?? undefined)
  const declared = governance?.project_tools ?? {}
  const toolDirs = Object.values(declared).map((path) => path.slice(0, path.lastIndexOf('/') + 1) || path)
  const startOnly = (path: string) =>
    (pi !== null && path.startsWith(pi) && !path.startsWith(`${pi}skills/`)) || toolDirs.some((dir) => path.startsWith(dir))
  const files = (release.files ?? []).filter(([path]) => startOnly(path!)).map(([path, , blob]) => `${path}:${blob}`).sort()
  return [
    ...(toolDirs.length > 0 ? [`tools:${JSON.stringify(declared)}`] : []),
    ...(governance?.kortix_tools ? [`kortix_tools:${JSON.stringify(governance.kortix_tools)}`] : []),
    ...files,
  ].join('\n')
}

/** A release's compiled governance must parse to a config object. Null governance keeps the running one. */
function governanceProblem(governance: string | null): string | null {
  if (governance === null) return null
  return parseCompiledAgentConfig(governance) ? null : 'the compiled governance is not a JSON object'
}

function bounded(reasons: readonly string[]): string | null {
  const reason = reasons.filter(Boolean).join('; ')
  if (!reason) return null
  return reason.length > MAX_FALLBACK_REASON ? `${reason.slice(0, MAX_FALLBACK_REASON - 1)}…` : reason
}

export function createPiConfigReleases(options: PiConfigReleasesOptions): PiConfigReleases {
  const { cfg, env } = options
  const root = options.root ?? bootConfigRoot()
  const noticePath = options.noticePath ?? CONFIG_RELEASE_NOTICE_PATH
  const api =
    options.api === undefined
      ? configReleaseApiFrom({
          apiUrl: cfg.apiUrl,
          projectId: cfg.projectId,
          sandboxToken: cfg.sandboxToken,
          sessionId: env.KORTIX_SESSION_ID,
        })
      : options.api
  let current: RunningConfig = { ...WORKSPACE }
  /** THE writer of the running config: health, `GET /config` and the runtime all read it. */
  const setCurrent = (next: RunningConfig) => {
    current = next
  }
  let inFlight: Promise<HarnessConfigConvergeResult> | null = null
  let booted: Promise<void> | null = null

  const report = (): ConfigReleaseReport => {
    const { source_commit: _commit, dir: _dir, piDir: _piDir, ...rest } = current
    return { ...rest }
  }
  const respond = (outcome: ConvergeOutcome, reason: string | null = null): HarnessConfigConvergeResult => ({
    ok: outcome === 'applied' || outcome === 'unchanged',
    outcome,
    config: report(),
    // Nothing restarts on pi: the runtime reads the new config in place.
    reload: null,
    reason,
  })

  const writeNotice = (manifest: Pick<ReleaseManifest, 'source_commit' | 'config_dir'> & { agent_repoint_reason?: string | null }, dir: string) => {
    try {
      writeConfigReleaseNotice(
        {
          sourceCommit: manifest.source_commit,
          sourcePaths: piReleaseSourcePaths(manifest.config_dir),
          releaseDir: dir,
          sessionId: env.KORTIX_SESSION_ID ?? null,
          agentRepoint: manifest.agent_repoint_reason ?? null,
        },
        noticePath,
      )
    } catch (err) {
      logger.warn('[pi-config] could not write the session config notice', { err: String(err) })
    }
  }
  const clearNotice = () => {
    try {
      clearConfigReleaseNotice(noticePath)
    } catch (err) {
      logger.warn('[pi-config] could not clear the session config notice', { err: String(err) })
    }
  }

  /** Download, verify, extract and seal a release, or reuse an intact copy. */
  const materialize = async (manifest: ReleaseManifest, from: ConfigReleaseApi): Promise<string> => {
    const dir = releaseDir(root, manifest.release_id)
    const intact =
      existsSync(dir) && (await verifyRelease({ dir, files: manifest.files, configDir: manifest.config_dir, managedSkillsDir: options.managedSkillsDir }))
    if (intact) {
      await writeReleaseManifest(root, manifest)
      return dir
    }
    const archive = await downloadConfigArchive(from, manifest.archive_url, { expectedBytes: manifest.archive_bytes })
    await materializeRelease({ root, manifest, archive, managedSkillsDir: options.managedSkillsDir })
    return dir
  }

  const settleRelease = async (releaseId: string, manifest: ReleaseManifest, dir: string) => {
    const previous = await readBootConfigPointer(root).catch(() => null)
    await activateBootConfig(root, {
      release_id: releaseId,
      source_commit: manifest.source_commit,
      config_dir: manifest.config_dir,
      dir,
      proven: true,
    })
    await pruneBootConfigs(root, previous && previous.release_id !== releaseId ? [releaseId, previous.release_id] : [releaseId])
  }

  // ── Boot ─────────────────────────────────────────────────────────────────

  async function chooseBootConfig(mark?: (label: string) => void): Promise<void> {
    // 1. The descriptor request IS this boot's flag evaluation.
    let descriptor: ConfigReleaseDescriptor | null = null
    let disabled: string | null = api
      ? null
      : 'this box has no API to ask (KORTIX_API_URL, KORTIX_PROJECT_ID, KORTIX_SESSION_ID or KORTIX_TOKEN is unset)'
    const reasons: string[] = []
    if (api) {
      try {
        descriptor = await fetchConfigReleaseDescriptor(api, { timeoutMs: options.descriptorTimeoutMs })
        mark?.('config-release-fetched')
      } catch (err) {
        if (isFeatureDisabledError(err)) disabled = 'config releases are disabled for this project'
        // Valve B: the feature stays on and the box runs what it has on disk.
        else reasons.push(`the API could not be asked for this session's release: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    // 2. Flag off, or no API: the pre-release behaviour — the working tree.
    if (disabled) {
      clearNotice()
      setCurrent({ ...WORKSPACE, proven: true })
      logger.info('[pi-config] config releases are not in play; pi reads the working tree', { reason: disabled })
      return
    }

    // 3. The candidates, best first: the desired release, the last release
    //    this box proved, the image default (managed skills only).
    const desiredId = descriptor ? effectiveReleaseId(descriptor) : null
    if (descriptor?.reason) reasons.push(descriptor.reason)
    let failedReleaseId: string | null = null

    if (descriptor && desiredId !== null) {
      const quarantined = (await readQuarantine(root))[desiredId]
      if (quarantined) {
        reasons.push(`release ${desiredId.slice(0, 12)} is quarantined on this box: ${quarantined.reason}`)
      } else if (descriptor.archive === null) {
        // Governance only: no repository access, or no config dir on the base branch.
        const problem = governanceProblem(descriptor.compiled_governance)
        if (!problem) {
          deliverGovernance(descriptor.compiled_governance, descriptor.compiled_governance_etag, env)
          clearNotice()
          setCurrent({
            release_id: desiredId,
            desired_release_id: desiredId,
            source: 'image-default',
            mode: 'follow-base',
            proven: true,
            fallback_reason: bounded(reasons),
            failed_release_id: null,
            source_commit: null,
            dir: null,
            piDir: null,
          })
          logger.info('[pi-config] pi runs a governance-only release', { releaseId: desiredId })
          return
        }
        reasons.push(`governance-only release ${desiredId.slice(0, 12)} failed: ${problem}`)
        failedReleaseId = desiredId
      } else {
        const manifest = manifestFromDescriptor(descriptor, desiredId)
        const problem = governanceProblem(manifest.compiled_governance)
        if (problem) {
          reasons.push(`release ${desiredId.slice(0, 12)} failed: ${problem}`)
          failedReleaseId = desiredId
          await quarantineRelease(root, desiredId, problem)
        } else {
          try {
            const dir = await materialize(manifest, api!)
            mark?.('config-release-extracted')
            await useRelease(desiredId, desiredId, manifest, dir, reasons, null)
            mark?.('config-release-proven')
            return
          } catch (err) {
            // Transport, disk or verification failure: not the release's fault, so not quarantined.
            reasons.push(`release ${desiredId.slice(0, 12)} could not be built: ${err instanceof Error ? err.message : String(err)}`)
          }
        }
      }
    }

    const pointer = await readBootConfigPointer(root).catch(() => null)
    if (pointer && pointer.release_id !== desiredId) {
      const manifest = pointer.proven ? await readReleaseManifest(root, pointer.release_id) : null
      const intact =
        manifest !== null &&
        (await verifyRelease({ dir: pointer.dir, files: manifest.files, configDir: manifest.config_dir, managedSkillsDir: options.managedSkillsDir }))
      if (intact && manifest && !governanceProblem(manifest.compiled_governance)) {
        await useRelease(pointer.release_id, desiredId, manifest, pointer.dir, reasons, failedReleaseId)
        return
      }
      reasons.push(`last proven release ${pointer.release_id.slice(0, 12)} no longer verifies on disk`)
    }

    // The floor. The provisioned governance stays: the agents are the project's
    // whether or not a release loads.
    clearNotice()
    setCurrent({
      release_id: null,
      desired_release_id: desiredId,
      source: 'image-default',
      mode: 'follow-base',
      proven: true,
      fallback_reason: bounded(reasons),
      failed_release_id: failedReleaseId,
      source_commit: null,
      dir: null,
      piDir: null,
    })
    logger.warn('[pi-config] pi runs the image default config', { desiredId, reason: current.fallback_reason })
  }

  async function useRelease(
    releaseId: string,
    desiredId: string | null,
    manifest: ReleaseManifest,
    dir: string,
    reasons: readonly string[],
    failedReleaseId: string | null,
  ): Promise<void> {
    deliverGovernance(manifest.compiled_governance, manifest.compiled_governance_etag, env)
    writeNotice(manifest, dir)
    await settleRelease(releaseId, manifest, dir)
    setCurrent({
      release_id: releaseId,
      desired_release_id: desiredId,
      source: 'release',
      mode: 'follow-base',
      proven: true,
      fallback_reason: releaseId === desiredId ? null : bounded(reasons),
      failed_release_id: failedReleaseId,
      source_commit: manifest.source_commit,
      dir,
      piDir: await piDirIn(dir),
    })
    logger.info('[pi-config] pi runs this release', { releaseId, desiredId, dir, sourceCommit: manifest.source_commit })
  }

  // ── Convergence ──────────────────────────────────────────────────────────

  /**
   * Point the runtime at `next` and reconfigure it. A runtime that refuses the
   * config (reconfigure throws) gets the previous config back, and the reason
   * is returned instead of thrown.
   */
  async function swap(
    runtime: PiReleaseRuntime,
    next: RunningConfig,
    governance: { value: string | null; etag: string | null },
    restart = false,
  ): Promise<string | null> {
    const previous = current
    const restoreGovernance = deliverGovernance(governance.value, governance.etag, env)
    const load = () => (restart ? runtime.restart() : runtime.reconfigure())
    setCurrent(next)
    try {
      await load()
      if (restart) logger.info('[pi-config] the release changes pi extensions, prompts, settings or project tools; the runtime restarted in place')
      return null
    } catch (err) {
      restoreGovernance()
      setCurrent(previous)
      await load().catch(() => undefined)
      return err instanceof Error ? err.message : String(err)
    }
  }

  /** The start-only pi files the runtime loaded: the running release's, or the working tree's pi dir. */
  async function loadedStartOnlyFiles(): Promise<string | null> {
    if (current.source === 'release' && current.release_id) {
      return startOnlyFiles(await readReleaseManifest(root, current.release_id), current.dir, current.piDir)
    }
    // Off the release path the working tree's pi dir may hold extensions: unknown, so restart.
    return current.source === 'workspace' ? null : ''
  }

  /** Record why the box keeps its running config instead of `releaseId`. The first reason for a release stays. */
  const recordKeptFailure = (releaseId: string, reason: string) => {
    if (current.failed_release_id === releaseId && current.fallback_reason) return
    setCurrent({ ...current, failed_release_id: releaseId, fallback_reason: reason })
  }

  async function revert(runtime: PiReleaseRuntime, apiMessage: string): Promise<HarnessConfigConvergeResult> {
    const reason = `config releases are disabled for this project; pi reads the working tree (${apiMessage})`
    if (current.source === 'workspace') {
      clearNotice()
      await deactivateBootConfig(root)
      setCurrent({ ...WORKSPACE, proven: true })
      return respond('unchanged', reason)
    }
    if (!runtime.idle()) return respond('failed', 'a turn is running; the revert waits for the next trigger')
    clearNotice()
    // Governance is not touched: with the flag off the API pushes it itself.
    // The working tree may carry a pi dir of its own: a restart loads whatever it holds.
    const refused = await swap(runtime, { ...WORKSPACE, proven: true }, { value: null, etag: null }, true)
    if (refused) return respond('declined', refused)
    await deactivateBootConfig(root)
    logger.info('[pi-config] disabled for this project; pi reverted to the working tree')
    return respond('applied', reason)
  }

  async function apply(
    runtime: PiReleaseRuntime | null,
    delayBeforeSwapMs: number | undefined,
  ): Promise<HarnessConfigConvergeResult> {
    if (!api) return respond('failed', 'KORTIX_API_URL, KORTIX_PROJECT_ID, KORTIX_SESSION_ID or KORTIX_TOKEN is unset')
    if (!runtime) return respond('failed', 'the pi runtime is not running; nothing to apply')

    let descriptor: ConfigReleaseDescriptor
    try {
      descriptor = await fetchConfigReleaseDescriptor(api)
    } catch (err) {
      if (isFeatureDisabledError(err)) return revert(runtime, err.message)
      return respond('failed', (err as Error).message)
    }
    const releaseId = effectiveReleaseId(descriptor)
    setCurrent({ ...current, desired_release_id: releaseId })
    if (releaseId === null || (descriptor.archive === null && descriptor.config_tree_id !== null)) {
      return respond(descriptor.reason ? 'failed' : 'unchanged', descriptor.reason)
    }
    const met = () => {
      setCurrent({ ...current, mode: 'follow-base', fallback_reason: null, failed_release_id: null })
      return respond('unchanged')
    }
    const busy = () => respond('failed', 'a turn is running; the apply waits for the next trigger')

    const governance = { value: descriptor.compiled_governance, etag: descriptor.compiled_governance_etag }
    if (descriptor.archive === null) {
      if (current.release_id === releaseId && current.source === 'image-default') return met()
      const problem = governanceProblem(governance.value)
      if (problem) {
        recordKeptFailure(releaseId, problem)
        return respond('declined', problem)
      }
      if (!runtime.idle()) return busy()
      const loaded = await loadedStartOnlyFiles()
      const refused = await swap(
        runtime,
        {
          release_id: releaseId,
          desired_release_id: releaseId,
          source: 'image-default',
          mode: 'follow-base',
          proven: true,
          fallback_reason: null,
          failed_release_id: null,
          source_commit: null,
          dir: null,
          piDir: null,
        },
        governance,
        loaded !== '',
      )
      if (refused) {
        recordKeptFailure(releaseId, refused)
        return respond('declined', refused)
      }
      clearNotice()
      // A release this session may no longer read must not come back at boot.
      await deactivateBootConfig(root)
      return respond('applied')
    }

    const manifest = manifestFromDescriptor(descriptor, releaseId)
    const dir = releaseDir(root, releaseId)
    if (current.source === 'release' && current.release_id === releaseId) {
      const check = await verifyReleaseDetail({ dir, files: manifest.files, configDir: manifest.config_dir, managedSkillsDir: options.managedSkillsDir })
      if (check.ok) return met()
      logger.warn('[pi-config] the running release no longer verifies; rebuilding', { releaseId, problem: check.problem })
    }
    const quarantined = (await readQuarantine(root))[releaseId]
    if (quarantined) {
      recordKeptFailure(releaseId, `release ${releaseId.slice(0, 12)} is quarantined on this box: ${quarantined.reason}`)
      return respond('quarantined', current.fallback_reason)
    }
    if (!runtime.idle()) return busy()

    // Fault injection only; zero in production. See `MAX_SWAP_DELAY_MS`.
    const delay = Math.min(Math.max(delayBeforeSwapMs ?? 0, 0), MAX_SWAP_DELAY_MS)
    if (delay > 0) {
      logger.warn('[pi-config] holding the convergence before the swap (fault injection)', { ms: delay })
      await new Promise((resolve) => setTimeout(resolve, delay))
    }

    try {
      await materialize(manifest, api)
    } catch (err) {
      if (isFeatureDisabledError(err)) return revert(runtime, err.message)
      const reason = `could not build release ${releaseId.slice(0, 12)}: ${(err as Error).message}`
      logger.warn('[pi-config] release build failed; keeping the running config', { releaseId, reason })
      return respond('failed', reason)
    }
    const problem = governanceProblem(governance.value)
    if (problem) {
      await quarantineRelease(root, releaseId, problem)
      recordKeptFailure(releaseId, problem)
      return respond('declined', problem)
    }
    // The download took time; a prompt may have arrived. Ask again right before the swap.
    if (!runtime.idle()) return busy()

    const piDir = await piDirIn(dir)
    const restart = (await loadedStartOnlyFiles()) !== startOnlyFiles(manifest, dir, piDir)
    writeNotice(manifest, dir)
    const refused = await swap(
      runtime,
      {
        release_id: releaseId,
        desired_release_id: releaseId,
        source: 'release',
        mode: 'follow-base',
        proven: true,
        fallback_reason: null,
        failed_release_id: null,
        source_commit: manifest.source_commit,
        dir,
        piDir,
      },
      governance,
      restart,
    )
    if (refused) {
      // The notice must name what runs: put back the previous release's, or none.
      const previous = current.release_id && current.dir ? await readReleaseManifest(root, current.release_id) : null
      if (previous && current.dir) writeNotice(previous, current.dir)
      else clearNotice()
      await quarantineRelease(root, releaseId, refused)
      recordKeptFailure(releaseId, refused)
      logger.warn('[pi-config] release declined; the running config stays', { releaseId, reason: refused })
      return respond('declined', refused)
    }
    await settleRelease(releaseId, manifest, dir)
    logger.info('[pi-config] release applied', { releaseId, sourceCommit: manifest.source_commit, dir })
    return respond('applied')
  }

  return {
    report,
    sourceCommit: () => (current.source === 'release' ? current.source_commit : null),
    skillDirs: () => {
      if (current.source === 'workspace') return null
      // The same dirs pi reads in the working tree (`resolvePiSkillDirectories`).
      return current.dir ? [join(current.dir, 'skills'), join(current.dir, '.kortix', 'opencode', 'skills')] : []
    },
    piConfigDir: () => {
      if (current.source === 'workspace') return undefined
      return current.piDir && existsSync(current.piDir) ? current.piDir : null
    },
    projectRoot: () => (current.source === 'workspace' ? undefined : current.dir),
    notice: () => {
      if (current.source !== 'release') return null
      try {
        return readFileSync(noticePath, 'utf8').trim() || null
      } catch {
        return null
      }
    },
    governanceOwned: () => current.release_id !== null,
    inFlight: () => inFlight !== null,
    boot(mark) {
      booted ??= chooseBootConfig(mark).catch((err: unknown) => {
        // A broken release store must not keep the runtime from starting: the
        // provisioned governance and the managed skills still run.
        setCurrent({
          ...WORKSPACE,
          source: 'image-default',
          mode: 'follow-base',
          proven: true,
          fallback_reason: `the boot config could not be chosen: ${err instanceof Error ? err.message : String(err)}`,
        })
        logger.error('[pi-config] boot config failed; pi runs the image default', { reason: current.fallback_reason })
      })
      return booted
    },
    converge(runtime, convergeOptions = {}) {
      if (inFlight) return Promise.reject(new ConvergeBusyError())
      // A dead session credential can never converge (KRTX-613): every call answers 401.
      if (sessionTokenPresumedDead()) {
        return Promise.resolve(respond('failed', 'the session credential is not active; config convergence is paused'))
      }
      const run = apply(runtime, convergeOptions.delayBeforeSwapMs)
        .catch((err: unknown) => {
          const reason = `convergence failed: ${err instanceof Error ? err.message : String(err)}`
          logger.error('[pi-config] convergence threw', { reason })
          return respond('failed', reason)
        })
        .finally(() => {
          inFlight = null
        })
      inFlight = run
      return run
    },
  }
}
