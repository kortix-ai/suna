import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
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
  writeReleaseManifest,
  type ReleaseManifest,
} from '../../boot-config'
import {
  configReleaseApiFrom,
  downloadConfigArchive,
  fetchConfigReleaseDescriptor,
  isRepositoryChangedError,
  type ConfigReleaseApi,
} from '../../config-release/api-client'
import type { ConfigReleaseDescriptor, WorkspaceReport } from '../../config-release/descriptor'
import { buildWorkspaceReport } from '../../config-release/workspace-report'
import { logger } from '../../logger'
import { ensureInjectedManagedSkills } from '../../managed-skills'
import { resolveOpencodeConfigDir, resolveOpencodeConfigDirLiteral, type OpenCodeConfig } from './config'
import { VERIFY_READY_TIMEOUT_MS, type Opencode, type VerifiedReloadResult } from './lifecycle'
import { ensureOpencodeConfigDeps } from './opencode-config-deps'
import { pluginFilesFrom, provenCheck, toolNamesFromFiles, type ProvenCheckInput } from './proven-check'

/**
 * Convergence: the daemon applies the release the API assigns.
 * Spec: docs/specs/config-releases.md, "Apply sequence", "Fallback chain",
 * "Health".
 *
 * The API decides. The daemon fetches the descriptor itself (a request body
 * never supplies it), verifies the archive against the descriptor's blob IDs,
 * starts a replacement OpenCode on the standby port, and promotes it only
 * after the proven check. Every failure keeps the running process.
 */

export type ConfigSource = 'release' | 'workspace' | 'image-default'
export type ConfigMode = 'follow-base' | 'session-files'

/** The health `config` block. The converge response carries the same object. */
export interface ConfigReleaseReport {
  release_id: string | null
  desired_release_id: string | null
  source: ConfigSource
  mode: ConfigMode | null
  proven: boolean
  fallback_reason: string | null
  failed_release_id: string | null
}

export type ConvergeOutcome = 'applied' | 'unchanged' | 'declined' | 'quarantined' | 'session-files' | 'failed'

export interface ConvergeResponse {
  ok: boolean
  outcome: ConvergeOutcome
  config: ConfigReleaseReport
  reload: { how: 'restarted'; turn_ended: boolean | null } | null
  /** Why the release did not apply. Null when it applied or nothing changed. */
  reason: string | null
}

/** A second convergence while one runs. The route answers `409`. */
export class ConvergeBusyError extends Error {
  constructor() {
    super('a config convergence is already running')
    this.name = 'ConvergeBusyError'
  }
}

interface RunningConfig extends ConfigReleaseReport {
  /** The running release's commit; null off the release path. */
  source_commit: string | null
}

const INITIAL: RunningConfig = {
  release_id: null,
  desired_release_id: null,
  source: 'workspace',
  mode: null,
  proven: false,
  fallback_reason: null,
  failed_release_id: null,
  source_commit: null,
}

let running: RunningConfig = { ...INITIAL }
/** Workspace report + release of the running session-files config. */
let sessionFilesFingerprint: string | null = null
let inFlight: Promise<ConvergeResponse> | null = null

export function configReleaseReport(): ConfigReleaseReport {
  const { source_commit: _sourceCommit, ...report } = running
  return { ...report }
}

/** The running release's source commit, for readers that predate `config`. */
export function runningSourceCommit(): string | null {
  return running.source === 'release' ? running.source_commit : null
}

/**
 * The release directory OpenCode runs from, or null off the release path.
 * The managed-skill overlay goes there, never into `/workspace`, while a
 * release runs — proven or not yet proven.
 */
export function runningReleaseDir(root: string = bootConfigRoot()): string | null {
  return running.source === 'release' && running.release_id ? releaseDir(root, running.release_id) : null
}

/**
 * Is OpenCode's compiled governance owned by a config release? True once a
 * release (any source) was applied or spawned on. Then a `/kortix/env` push of
 * `KORTIX_COMPILED_AGENT_CONFIG` must not replace it: the release is the
 * authority, and the next convergence delivers any newer governance.
 */
export function releaseGovernanceActive(): boolean {
  return running.release_id !== null
}

/** Boot records what it spawned on. */
export function recordBootConfig(next: Partial<RunningConfig> & Pick<RunningConfig, 'source'>): void {
  running = { ...INITIAL, ...next }
  sessionFilesFingerprint = null
}

export function resetConfigReleaseStateForTests(): void {
  running = { ...INITIAL }
  sessionFilesFingerprint = null
  inFlight = null
}

export function convergeInFlight(): boolean {
  return inFlight !== null
}

export interface ConvergeDeps {
  cfg: OpenCodeConfig
  opencode: Pick<Opencode, 'useConfigDir' | 'getConfigDir' | 'reloadVerified' | 'getPid' | 'getInternalUrl'>
  root?: string
  /** Overlay source; defaults to the image-baked overlay. */
  managedSkillsDir?: string
  /** Defaults to the API settings in `cfg`. */
  api?: ConfigReleaseApi | null
  /** Dependencies + managed-skill overlay for a directory. Injectable for tests. */
  prepare?: (dir: string) => Promise<void>
  /** Injectable for tests. */
  workspaceReport?: () => Promise<WorkspaceReport | null>
  /** Overrides the proven check. Tests point it at a fake OpenCode. */
  prove?: typeof provenCheck
  proveFetch?: typeof fetch
  /**
   * Is a turn running? A replacement retires the running process and would
   * end the turn, so any answer other than `false` defers the swap to the next
   * trigger (the API converges again at turn end). Absent: never deferred.
   */
  turnInFlight?: () => Promise<boolean | null>
  /** Proven check budget for a release already running; the spec's 90 s. */
  proofBudgetMs?: number
}

/** Dependencies and the managed-skill overlay, the preparation every config dir gets. */
export async function prepareConfigDir(dir: string, managedSkillsDir?: string): Promise<void> {
  await ensureOpencodeConfigDeps(dir)
  await ensureInjectedManagedSkills(dir, managedSkillsDir ? { bakedDir: managedSkillsDir } : {})
}

/** The workspace report for this session, or null when there is none to give. */
export async function workspaceReportFor(cfg: OpenCodeConfig): Promise<WorkspaceReport | null> {
  const configDir = await resolveOpencodeConfigDirLiteral(cfg)
  if (!configDir) return null
  return buildWorkspaceReport(cfg.projectTarget, configDir, cfg.defaultBranch, { baseSha: cfg.baseSha })
}

/**
 * Deliver the release's compiled governance to the next spawn, through the
 * same env seam `/kortix/env` uses. A null governance leaves the running one in
 * place: the API sends null for a project without compiled governance or for
 * a read failure, and deleting the env would drop every agent. Returns the
 * function that restores the previous values.
 */
export function deliverGovernance(governance: string | null, etag: string | null): () => void {
  if (governance === null) return () => undefined
  const previous = {
    config: process.env.KORTIX_COMPILED_AGENT_CONFIG,
    etag: process.env.KORTIX_COMPILED_AGENT_CONFIG_ETAG,
  }
  process.env.KORTIX_COMPILED_AGENT_CONFIG = governance
  process.env.KORTIX_COMPILED_AGENT_CONFIG_ETAG = etag ?? ''
  return () => {
    if (previous.config === undefined) delete process.env.KORTIX_COMPILED_AGENT_CONFIG
    else process.env.KORTIX_COMPILED_AGENT_CONFIG = previous.config
    if (previous.etag === undefined) delete process.env.KORTIX_COMPILED_AGENT_CONFIG_ETAG
    else process.env.KORTIX_COMPILED_AGENT_CONFIG_ETAG = previous.etag
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

function manifestFrom(descriptor: ConfigReleaseDescriptor, releaseId: string): ReleaseManifest {
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
  }
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
 * Apply the desired release. Single flight: a call while one runs throws
 * `ConvergeBusyError`. Never throws otherwise; a failure is an outcome.
 */
export function convergeConfigRelease(deps: ConvergeDeps): Promise<ConvergeResponse> {
  if (inFlight) return Promise.reject(new ConvergeBusyError())
  const run = applyDesiredRelease(deps)
    .catch((err: unknown): ConvergeResponse => {
      const reason = `convergence failed: ${err instanceof Error ? err.message : String(err)}`
      logger.error('[config-release] convergence threw', { reason })
      return respond('failed', null, reason)
    })
    .finally(() => {
      inFlight = null
    })
  inFlight = run
  return run
}

function respond(
  outcome: ConvergeOutcome,
  reload: VerifiedReloadResult | null,
  reason: string | null = null,
): ConvergeResponse {
  return {
    ok: outcome === 'applied' || outcome === 'unchanged' || outcome === 'session-files',
    outcome,
    config: configReleaseReport(),
    reload: reload && reload.outcome === 'swapped' ? { how: 'restarted', turn_ended: reload.turnEnded } : null,
    reason,
  }
}

async function applyDesiredRelease(deps: ConvergeDeps): Promise<ConvergeResponse> {
  const { cfg, opencode } = deps
  const root = deps.root ?? bootConfigRoot()
  const api =
    deps.api === undefined
      ? configReleaseApiFrom({ apiUrl: cfg.apiUrl, projectId: cfg.projectId, sandboxToken: cfg.sandboxToken })
      : deps.api
  if (!api) return respond('failed', null, 'KORTIX_API_URL, KORTIX_PROJECT_ID, KORTIX_SESSION_ID or KORTIX_TOKEN is unset')

  // 1. Workspace report → descriptor. The report is best effort: without one
  //    the API assumes follow-base.
  const readReport = deps.workspaceReport ?? (() => workspaceReportFor(cfg))
  const report = await readReport().catch((err: unknown) => {
    logger.warn('[config-release] workspace report failed; sending none', { err: String(err) })
    return null
  })
  let descriptor: ConfigReleaseDescriptor
  try {
    descriptor = await fetchConfigReleaseDescriptor(api, report)
  } catch (err) {
    // A previous-repository session is frozen on its running config: nothing
    // failed, nothing falls back, nothing is quarantined.
    if (isRepositoryChangedError(err)) return respond('unchanged', null, err.message)
    // API unreachable or older than the spec: the running config stays.
    return respond('failed', null, (err as Error).message)
  }
  const releaseId = effectiveReleaseId(descriptor)
  running.desired_release_id = releaseId
  // No release: a config dir over the 4 MiB limit (a tree without an
  // archive), a governance compile failure, or nothing to run at all. The
  // running config stays.
  const noRelease =
    releaseId === null ||
    (descriptor.mode === 'follow-base' && descriptor.archive === null && descriptor.config_tree_id !== null)
  if (noRelease || releaseId === null) {
    return respond(descriptor.reason ? 'failed' : 'unchanged', null, descriptor.reason)
  }

  // Every replacement needs a live process to fall back on, and must not end
  // a running turn.
  const requireRunning = async (): Promise<ConvergeResponse | null> => {
    if (opencode.getPid() === null) return respond('failed', null, 'opencode is not running; nothing to replace')
    if (deps.turnInFlight && (await deps.turnInFlight().catch(() => null)) !== false) {
      return respond('failed', null, 'a turn is running or its state is unknown; the swap waits for the next trigger')
    }
    return null
  }

  const swap = async (dir: string, toolNames: readonly string[], pluginFiles: readonly string[] = []) => {
    const previousDir = opencode.useConfigDir(dir)
    const restoreGovernance = deliverGovernance(descriptor.compiled_governance, descriptor.compiled_governance_etag)
    const result = await opencode.reloadVerified({
      prove: (baseUrl, deadline) =>
        (deps.prove ?? provenCheck)(baseUrl, deadline, {
          directory: cfg.projectTarget,
          toolNames,
          pluginFiles,
          configDir: dir,
          fetchImpl: deps.proveFetch,
        }),
    })
    if (result.outcome === 'kept-old') {
      opencode.useConfigDir(previousDir)
      restoreGovernance()
    }
    return result
  }

  // 2. The session edits its own config: OpenCode reads the workspace dir.
  if (descriptor.mode === 'session-files') {
    const dir = await resolveOpencodeConfigDir(cfg)
    const fingerprintOf = (workspace: WorkspaceReport | null) =>
      createHash('sha256').update(JSON.stringify([releaseId, dir, workspace])).digest('hex')
    const fingerprint = fingerprintOf(report)
    if (
      running.mode === 'session-files' &&
      sessionFilesFingerprint === fingerprint &&
      opencode.getConfigDir() === dir
    ) {
      return respond('unchanged', null)
    }
    const notRunning = await requireRunning()
    if (notRunning) return notRunning
    await (deps.prepare ?? ((target) => prepareConfigDir(target, deps.managedSkillsDir)))(dir)
    const result = await swap(dir, await toolNamesInDir(dir), await pluginFilesInDir(dir))
    if (result.outcome === 'kept-old') {
      running.fallback_reason = result.reason
      return respond('declined', null, result.reason)
    }
    running = {
      release_id: releaseId,
      desired_release_id: releaseId,
      source: dir === cfg.defaultOpencodeConfigDir ? 'image-default' : 'workspace',
      mode: 'session-files',
      proven: true,
      fallback_reason: null,
      failed_release_id: null,
      source_commit: null,
    }
    // Taken AFTER preparation and the spawn: the overlay and the installer
    // write into this directory, and their output must not read as a new edit.
    sessionFilesFingerprint = fingerprintOf(await readReport().catch(() => report))
    logger.info('[config-release] opencode runs the session config', { releaseId, dir })
    return respond('session-files', result)
  }

  // Governance only: no repository access, or no config dir on the base branch.
  // The image default config dir runs with the compiled governance.
  if (descriptor.archive === null) {
    const dir = cfg.defaultOpencodeConfigDir
    if (running.release_id === releaseId && running.source === 'image-default' && opencode.getConfigDir() === dir) {
      running.mode = 'follow-base'
      return respond('unchanged', null)
    }
    const notRunning = await requireRunning()
    if (notRunning) return notRunning
    const result = await swap(dir, [])
    if (result.outcome === 'kept-old') {
      running.fallback_reason = result.reason
      return respond('declined', null, result.reason)
    }
    // A release this session may no longer read must not come back at boot.
    await deactivateBootConfig(root)
    running = {
      release_id: releaseId,
      desired_release_id: releaseId,
      source: 'image-default',
      mode: 'follow-base',
      proven: true,
      fallback_reason: null,
      failed_release_id: null,
      source_commit: null,
    }
    sessionFilesFingerprint = null
    logger.info('[config-release] opencode runs the image default config', { releaseId, reason: descriptor.reason })
    return respond('applied', result)
  }

  const manifest = manifestFrom(descriptor, releaseId)
  const dir = releaseDir(root, releaseId)
  const verifies = () =>
    verifyRelease({ dir, files: manifest.files, managedSkillsDir: deps.managedSkillsDir })

  // 3. Same release, intact copy: nothing to do. A release spawned at boot
  //    before any proof is proven now, on the live process.
  if (running.source === 'release' && running.release_id === releaseId && opencode.getConfigDir() === dir) {
    if (await verifies()) {
      running.mode = 'follow-base'
      if (running.proven) return respond('unchanged', null)
      return proveBootRelease(deps, { root, api, releaseId, manifest, dir })
    }
    logger.warn('[config-release] the running release no longer verifies; rebuilding', { releaseId })
  }

  // 4. Quarantined on this box: keep the running config.
  const quarantined = (await readQuarantine(root))[releaseId]
  if (quarantined) {
    running.failed_release_id = releaseId
    running.fallback_reason = `release ${releaseId.slice(0, 12)} is quarantined on this box: ${quarantined.reason}`
    return respond('quarantined', null, running.fallback_reason)
  }

  const notRunning = await requireRunning()
  if (notRunning) return notRunning

  // 5–6. Download, extract, verify, prepare, seal, rename. An intact copy
  //      from an earlier attempt is reused without a download.
  try {
    if (existsSync(dir) && (await verifies())) {
      await writeReleaseManifest(root, manifest)
    } else {
      const archive = await downloadConfigArchive(api, manifest.archive_url, { expectedBytes: manifest.archive_bytes })
      await materializeRelease({
        root,
        manifest,
        archive,
        managedSkillsDir: deps.managedSkillsDir,
        prepare: deps.prepare ?? ((staged) => prepareConfigDir(staged, deps.managedSkillsDir)),
      })
    }
  } catch (err) {
    // The archive route gates on the repository generation too.
    if (isRepositoryChangedError(err)) return respond('unchanged', null, err.message)
    // Transport, disk or verification failure: nothing is wrong with the
    // release itself, so it is not quarantined. The next trigger retries.
    const reason = `could not build release ${releaseId.slice(0, 12)}: ${(err as Error).message}`
    logger.warn('[config-release] release build failed; keeping the running config', { releaseId, reason })
    return respond('failed', null, reason)
  }

  // 7–9. Governance, replacement on the standby port, proven check, promotion.
  const result = await swap(dir, toolNamesFromFiles(manifest.files), pluginFilesFrom(manifest.files))
  if (result.outcome === 'kept-old') {
    // 10. Keep the old process. Quarantine only a release whose candidate failed.
    if (result.candidateFailed) await quarantineRelease(root, releaseId, result.reason)
    running.failed_release_id = releaseId
    running.fallback_reason = result.reason
    logger.warn('[config-release] release declined; the running config stays', { releaseId, reason: result.reason })
    return respond('declined', null, result.reason)
  }

  const previous = await readBootConfigPointer(root)
  await activateBootConfig(root, {
    release_id: releaseId,
    source_commit: manifest.source_commit,
    config_dir: manifest.config_dir,
    dir,
    proven: true,
  })
  await pruneBootConfigs(root, previous ? [releaseId, previous.release_id] : [releaseId])
  running = {
    release_id: releaseId,
    desired_release_id: releaseId,
    source: 'release',
    mode: 'follow-base',
    proven: true,
    fallback_reason: null,
    failed_release_id: null,
    source_commit: manifest.source_commit,
  }
  sessionFilesFingerprint = null
  logger.info('[config-release] release applied', { releaseId, sourceCommit: manifest.source_commit, dir })
  return respond('applied', result)
}

/**
 * Prove a release OpenCode was spawned on at boot, before any proof ran.
 *
 * No replacement is started: the proven check runs against the live process.
 * On success the pointer is written. On failure the release is quarantined
 * and OpenCode moves down the fallback chain (last proven release, workspace,
 * image default) through a verified swap.
 */
async function proveBootRelease(
  deps: ConvergeDeps,
  input: { root: string; api: ConfigReleaseApi; releaseId: string; manifest: ReleaseManifest; dir: string },
): Promise<ConvergeResponse> {
  const { cfg, opencode } = deps
  const { root, releaseId, manifest, dir } = input
  const budget = deps.proofBudgetMs ?? VERIFY_READY_TIMEOUT_MS
  const proof = await (deps.prove ?? provenCheck)(opencode.getInternalUrl(), Date.now() + budget, {
    directory: cfg.projectTarget,
    toolNames: toolNamesFromFiles(manifest.files),
    pluginFiles: pluginFilesFrom(manifest.files),
    configDir: dir,
    fetchImpl: deps.proveFetch,
  })
  if (proof.ok) {
    const previous = await readBootConfigPointer(root)
    await activateBootConfig(root, {
      release_id: releaseId,
      source_commit: manifest.source_commit,
      config_dir: manifest.config_dir,
      dir,
      proven: true,
    })
    await pruneBootConfigs(root, previous ? [releaseId, previous.release_id] : [releaseId])
    running = { ...running, mode: 'follow-base', proven: true, fallback_reason: null, failed_release_id: null }
    logger.info('[config-release] the boot release is proven', { releaseId })
    return respond('applied', null)
  }

  await quarantineRelease(root, releaseId, proof.reason)
  running.failed_release_id = releaseId
  running.fallback_reason = proof.reason
  logger.warn('[config-release] the boot release failed the proven check; falling back', {
    releaseId,
    reason: proof.reason,
  })
  if (deps.turnInFlight && (await deps.turnInFlight().catch(() => null)) !== false) {
    return respond('declined', null, `${proof.reason}; the fallback waits for the turn to end`)
  }
  const fallback = await resolveBootConfig({
    cfg,
    root,
    managedSkillsDir: deps.managedSkillsDir,
    api: input.api,
    prepare: deps.prepare,
  })
  const previousDir = opencode.useConfigDir(fallback.dir)
  const result = await opencode.reloadVerified()
  if (result.outcome === 'kept-old') {
    opencode.useConfigDir(previousDir)
    return respond('declined', null, `${proof.reason}; the fallback did not start: ${result.reason}`)
  }
  running = {
    release_id: fallback.release_id,
    desired_release_id: releaseId,
    source: fallback.source,
    mode: 'follow-base',
    proven: fallback.source === 'release',
    fallback_reason: [proof.reason, fallback.fallback_reason].filter(Boolean).join('; '),
    failed_release_id: releaseId,
    source_commit: fallback.source_commit,
  }
  return respond('declined', result, proof.reason)
}

const MAX_FALLBACK_REASON = 1_000

/**
 * Prove the release OpenCode was spawned on at boot, BEFORE the session
 * runtime starts (spec "Boot", "Fallback chain"; verification DEF-4).
 *
 * A release that is not the proven pointer is unproven. The initial session
 * cannot be created on a config OpenCode refuses to load, so readiness never
 * comes and a proof that waits for readiness never runs. This proof waits for
 * the session API itself, fails fast on a config error, and on failure:
 *   1. quarantines the release on this box;
 *   2. walks the fallback chain — last proven release, workspace config dir
 *      with opencode.json(c), image default — restarting OpenCode on each and
 *      proving it;
 *   3. reports `fallback_reason` and `failed_release_id` in health, which is
 *      how the API learns of the failure.
 * The image default is the floor: OpenCode runs there even if it fails too.
 */
interface BootProofInput {
  cfg: OpenCodeConfig
  opencode: Pick<Opencode, 'getInternalUrl'>
  /** Reconfigure and restart OpenCode on `dir`; resolves once it listens. */
  spawnOn: (dir: string) => Promise<void>
  /** Put back the governance the box booted with (before the release's). */
  restoreGovernance?: () => void
  root?: string
  managedSkillsDir?: string
  api?: ConfigReleaseApi | null
  prepare?: (dir: string) => Promise<void>
  prove?: typeof provenCheck
  proofBudgetMs?: number
  proofOptions?: Partial<Pick<ProvenCheckInput, 'requestTimeoutMs' | 'hangLimit' | 'pollMs' | 'fetchImpl'>>
  mark?: (label: string) => void
}

type BootProofResult = { proven: boolean; dir: string; source: ConfigSource }

function boundedReason(reasons: readonly string[]): string | null {
  const reason = reasons.filter(Boolean).join('; ')
  if (!reason) return null
  return reason.length > MAX_FALLBACK_REASON ? `${reason.slice(0, MAX_FALLBACK_REASON - 1)}…` : reason
}

function bootProver(input: BootProofInput) {
  const budget = input.proofBudgetMs ?? VERIFY_READY_TIMEOUT_MS
  return (dir: string, toolNames: readonly string[], pluginFiles: readonly string[]) =>
    (input.prove ?? provenCheck)(input.opencode.getInternalUrl(), Date.now() + budget, {
      directory: input.cfg.projectTarget,
      toolNames,
      pluginFiles,
      configDir: dir,
      waitForSessionApi: true,
      ...input.proofOptions,
    })
}

/**
 * Restart OpenCode on each candidate below a failed config and prove it. The
 * first that passes wins; the image default is the floor and runs even if it
 * fails too. Records the result, with every step down, as the running state.
 */
async function walkFallbackChain(
  input: BootProofInput,
  from: 'release' | 'workspace',
  reasons: string[],
  failed: { releaseId: string | null; desiredReleaseId: string | null },
): Promise<BootProofResult> {
  const { cfg } = input
  const root = input.root ?? bootConfigRoot()
  const proveDir = bootProver(input)
  type Candidate = {
    dir: string
    source: ConfigSource
    label: string
    manifest?: ReleaseManifest
    releaseId?: string
    sourceCommit?: string
  }
  const candidates: Candidate[] = []
  if (from === 'release') {
    const pointer = await readBootConfigPointer(root)
    if (pointer?.proven && pointer.release_id !== failed.releaseId) {
      const manifest = await readReleaseManifest(root, pointer.release_id)
      if (
        manifest &&
        (await verifyRelease({ dir: pointer.dir, files: manifest.files, managedSkillsDir: input.managedSkillsDir }))
      ) {
        candidates.push({
          dir: pointer.dir,
          source: 'release',
          label: `last proven release ${pointer.release_id.slice(0, 12)}`,
          manifest,
          releaseId: pointer.release_id,
          sourceCommit: pointer.source_commit,
        })
      } else {
        reasons.push(`last proven release ${pointer.release_id.slice(0, 12)} no longer verifies`)
      }
    }
    const workspaceDir = await resolveOpencodeConfigDir(cfg)
    if (workspaceDir !== cfg.defaultOpencodeConfigDir) {
      candidates.push({ dir: workspaceDir, source: 'workspace', label: 'workspace config' })
    }
  }
  candidates.push({ dir: cfg.defaultOpencodeConfigDir, source: 'image-default', label: 'image default config' })

  for (const [index, candidate] of candidates.entries()) {
    const last = index === candidates.length - 1
    if (candidate.manifest) {
      deliverGovernance(candidate.manifest.compiled_governance, candidate.manifest.compiled_governance_etag)
    } else {
      input.restoreGovernance?.()
      await (input.prepare ?? ((dir) => prepareConfigDir(dir, input.managedSkillsDir)))(candidate.dir)
    }
    await input.spawnOn(candidate.dir)
    const files = candidate.manifest?.files
    const result = await proveDir(
      candidate.dir,
      files ? toolNamesFromFiles(files) : await toolNamesInDir(candidate.dir),
      files ? pluginFilesFrom(files) : await pluginFilesInDir(candidate.dir),
    )
    if (!result.ok) reasons.push(`${candidate.label} failed: ${result.reason}`)
    if (result.ok || last) {
      running = {
        release_id: candidate.releaseId ?? null,
        desired_release_id: failed.desiredReleaseId,
        source: candidate.source,
        mode: 'follow-base',
        proven: result.ok,
        fallback_reason: boundedReason(reasons),
        failed_release_id: failed.releaseId,
        source_commit: candidate.sourceCommit ?? null,
      }
      logger.warn('[config-release] boot fell back', {
        dir: candidate.dir,
        source: candidate.source,
        reason: running.fallback_reason,
      })
      return { proven: result.ok, dir: candidate.dir, source: candidate.source }
    }
  }
  throw new Error('unreachable: the image default is always the last candidate')
}

/**
 * Prove the release OpenCode was spawned on at boot, BEFORE the session
 * runtime starts (spec "Boot", "Fallback chain"; verification DEF-4).
 *
 * A release that is not the proven pointer is unproven. The initial session
 * cannot be created on a config OpenCode refuses to load, so readiness never
 * comes and a proof that waits for readiness never runs. This proof waits for
 * the session API itself, fails fast on a config error, and on failure:
 *   1. quarantines the release on this box;
 *   2. walks the fallback chain — last proven release, workspace config dir
 *      with opencode.json(c), image default — restarting OpenCode on each and
 *      proving it;
 *   3. reports `fallback_reason` and `failed_release_id` in health, which is
 *      how the API learns of the failure.
 */
export async function proveBootConfig(input: BootProofInput & { boot: BootRelease }): Promise<BootProofResult> {
  const { boot } = input
  const root = input.root ?? bootConfigRoot()
  const proof = await bootProver(input)(
    boot.dir,
    toolNamesFromFiles(boot.manifest.files),
    pluginFilesFrom(boot.manifest.files),
  )
  if (proof.ok) {
    const previous = await readBootConfigPointer(root)
    await activateBootConfig(root, {
      release_id: boot.releaseId,
      source_commit: boot.sourceCommit,
      config_dir: boot.manifest.config_dir,
      dir: boot.dir,
      proven: true,
    })
    await pruneBootConfigs(root, previous ? [boot.releaseId, previous.release_id] : [boot.releaseId])
    running = {
      release_id: boot.releaseId,
      desired_release_id: boot.releaseId,
      source: 'release',
      mode: 'follow-base',
      proven: true,
      fallback_reason: null,
      failed_release_id: null,
      source_commit: boot.sourceCommit,
    }
    input.mark?.('config-release-proven')
    logger.info('[config-release] the boot release is proven', { releaseId: boot.releaseId })
    return { proven: true, dir: boot.dir, source: 'release' }
  }

  await quarantineRelease(root, boot.releaseId, proof.reason)
  logger.warn('[config-release] the boot release failed its proof; walking the fallback chain', {
    releaseId: boot.releaseId,
    reason: proof.reason,
  })
  return walkFallbackChain(input, 'release', [`release ${boot.releaseId.slice(0, 12)} failed: ${proof.reason}`], {
    releaseId: boot.releaseId,
    desiredReleaseId: boot.releaseId,
  })
}

/**
 * Prove a workspace or image-default config a box booted on without a
 * release: a restart after its release was quarantined, an API that is
 * unreachable, or an API that predates releases. A workspace config that
 * OpenCode cannot load steps down to the image default, so the box still
 * becomes ready and a later convergence can heal it (verification DEF-4b).
 * `prior` carries the reasons the boot already stepped down for.
 */
export async function proveBootFallback(
  input: BootProofInput & {
    current: { dir: string; source: 'workspace' | 'image-default' }
    prior?: { reason: string | null; failedReleaseId: string | null }
  },
): Promise<BootProofResult> {
  const { current } = input
  const reasons = input.prior?.reason ? [input.prior.reason] : []
  const failed = { releaseId: input.prior?.failedReleaseId ?? null, desiredReleaseId: input.prior?.failedReleaseId ?? null }
  const proof = await bootProver(input)(current.dir, await toolNamesInDir(current.dir), await pluginFilesInDir(current.dir))
  if (proof.ok || current.source === 'image-default') {
    if (!proof.ok) reasons.push(`image default config failed: ${proof.reason}`)
    running = {
      ...running,
      mode: running.mode ?? (failed.releaseId ? 'follow-base' : null),
      proven: proof.ok,
      fallback_reason: boundedReason(reasons),
      failed_release_id: failed.releaseId,
      desired_release_id: failed.desiredReleaseId ?? running.desired_release_id,
    }
    return { proven: proof.ok, dir: current.dir, source: current.source }
  }
  reasons.push(`workspace config failed: ${proof.reason}`)
  return walkFallbackChain(input, 'workspace', reasons, failed)
}

export interface BootRelease {
  dir: string
  releaseId: string
  sourceCommit: string
  manifest: ReleaseManifest
}

/**
 * Fetch and extract the desired release at boot, in parallel with the repo
 * clone. No workspace report exists yet, so the request carries none and the
 * API answers follow-base; the convergence after ready corrects the mode.
 * Null when there is no archive to run (older API, API unreachable, a
 * session-files or governance-only descriptor, a quarantined release). Never
 * throws.
 */
export async function fetchBootRelease(input: {
  cfg: OpenCodeConfig
  api?: ConfigReleaseApi | null
  root?: string
  managedSkillsDir?: string
  prepare?: (dir: string) => Promise<void>
  mark?: (label: string) => void
  descriptorTimeoutMs?: number
  /** The desired release is quarantined on this box; boot reports it. */
  onQuarantined?: (releaseId: string, reason: string) => void
}): Promise<BootRelease | null> {
  const { cfg } = input
  const root = input.root ?? bootConfigRoot()
  const api =
    input.api === undefined
      ? configReleaseApiFrom({ apiUrl: cfg.apiUrl, projectId: cfg.projectId, sandboxToken: cfg.sandboxToken })
      : input.api
  if (!api) return null
  try {
    const descriptor = await fetchConfigReleaseDescriptor(api, null, { timeoutMs: input.descriptorTimeoutMs })
    input.mark?.('config-release-fetched')
    const releaseId = effectiveReleaseId(descriptor)
    if (descriptor.mode !== 'follow-base' || descriptor.archive === null || releaseId === null) return null
    const quarantined = (await readQuarantine(root))[releaseId]
    if (quarantined) {
      input.onQuarantined?.(releaseId, quarantined.reason)
      return null
    }
    const manifest = manifestFrom(descriptor, releaseId)
    const dir = releaseDir(root, releaseId)
    const intact =
      existsSync(dir) && (await verifyRelease({ dir, files: manifest.files, managedSkillsDir: input.managedSkillsDir }))
    if (intact) {
      await writeReleaseManifest(root, manifest)
    } else {
      const archive = await downloadConfigArchive(api, manifest.archive_url, { expectedBytes: manifest.archive_bytes })
      await materializeRelease({
        root,
        manifest,
        archive,
        managedSkillsDir: input.managedSkillsDir,
        prepare: input.prepare ?? ((staged) => prepareConfigDir(staged, input.managedSkillsDir)),
      })
    }
    input.mark?.('config-release-extracted')
    return { dir, releaseId, sourceCommit: manifest.source_commit, manifest }
  } catch (err) {
    if (isRepositoryChangedError(err)) {
      logger.info('[config-release] session belongs to a previous repository; no release at boot')
      return null
    }
    logger.warn('[config-release] no release at boot; the fallback chain applies', {
      err: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

/**
 * The last proven release, for a spawn before the repository exists, when it
 * still verifies against its manifest. Delivers the release's governance.
 */
export async function provenReleaseForEarlySpawn(
  root: string = bootConfigRoot(),
  managedSkillsDir?: string,
): Promise<{ dir: string; releaseId: string; sourceCommit: string } | null> {
  const pointer = await readBootConfigPointer(root)
  if (!pointer?.proven || !existsSync(pointer.dir)) return null
  const manifest = await readReleaseManifest(root, pointer.release_id)
  if (!manifest) return null
  if (!(await verifyRelease({ dir: pointer.dir, files: manifest.files, managedSkillsDir }))) return null
  deliverGovernance(manifest.compiled_governance, manifest.compiled_governance_etag)
  return { dir: pointer.dir, releaseId: pointer.release_id, sourceCommit: pointer.source_commit }
}

export interface BootConfigChoice {
  dir: string
  source: ConfigSource
  release_id: string | null
  source_commit: string | null
  fallback_reason: string | null
}

/**
 * The directory a starting daemon spawns OpenCode on: the fallback chain below
 * the desired release.
 *
 *   1. The last proven release named by the pointer, when it still verifies.
 *      A tampered copy is rebuilt from the API archive first.
 *   2. The workspace config dir, when it holds `opencode.json` or `opencode.jsonc`.
 *   3. The image default config dir.
 *
 * Each step down records `fallback_reason`. The release's compiled governance
 * is delivered to the spawn. Never throws.
 */
export async function resolveBootConfig(input: {
  cfg: OpenCodeConfig
  root?: string
  managedSkillsDir?: string
  api?: ConfigReleaseApi | null
  prepare?: (dir: string) => Promise<void>
}): Promise<BootConfigChoice> {
  const { cfg } = input
  const root = input.root ?? bootConfigRoot()
  const reasons: string[] = []
  try {
    const pointer = await readBootConfigPointer(root)
    if (pointer && !pointer.proven) reasons.push(`release ${pointer.release_id.slice(0, 12)} was never proven`)
    if (pointer?.proven) {
      const manifest = await readReleaseManifest(root, pointer.release_id)
      const intact =
        manifest !== null &&
        (await verifyRelease({ dir: pointer.dir, files: manifest.files, managedSkillsDir: input.managedSkillsDir }))
      let dir: string | null = intact ? pointer.dir : null
      if (!intact && manifest) {
        const api =
          input.api === undefined
            ? configReleaseApiFrom({ apiUrl: cfg.apiUrl, projectId: cfg.projectId, sandboxToken: cfg.sandboxToken })
            : input.api
        if (api) {
          logger.warn('[config-release] the proven release no longer verifies; rebuilding', {
            releaseId: pointer.release_id,
          })
          try {
            const archive = await downloadConfigArchive(api, manifest.archive_url, { expectedBytes: manifest.archive_bytes })
            dir = (
              await materializeRelease({
                root,
                manifest,
                archive,
                managedSkillsDir: input.managedSkillsDir,
                prepare: input.prepare ?? ((staged) => prepareConfigDir(staged, input.managedSkillsDir)),
              })
            ).dir
          } catch (err) {
            reasons.push(`release ${pointer.release_id.slice(0, 12)} could not be rebuilt: ${(err as Error).message}`)
          }
        } else {
          reasons.push(`release ${pointer.release_id.slice(0, 12)} no longer verifies and the API is not configured`)
        }
      } else if (!intact) {
        reasons.push(`release ${pointer.release_id.slice(0, 12)} has no manifest`)
      }
      if (dir && manifest) {
        deliverGovernance(manifest.compiled_governance, manifest.compiled_governance_etag)
        return {
          dir,
          source: 'release',
          release_id: pointer.release_id,
          source_commit: pointer.source_commit,
          fallback_reason: null,
        }
      }
    }
  } catch (err) {
    reasons.push(`the release store could not be read: ${(err as Error).message}`)
  }
  const fallbackReason = reasons.length > 0 ? reasons.join('; ') : null
  if (fallbackReason) logger.warn('[config-release] falling back below the proven release', { reason: fallbackReason })
  const dir = await resolveOpencodeConfigDir(cfg)
  return {
    dir,
    source: dir === cfg.defaultOpencodeConfigDir ? 'image-default' : 'workspace',
    release_id: null,
    source_commit: null,
    fallback_reason: fallbackReason,
  }
}
