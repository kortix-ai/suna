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
  releaseDir,
  verifyRelease,
  verifyReleaseDetail,
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
import { clearConfigReleaseNotice, writeConfigReleaseNotice } from '../../config-release/notice'
import { MAX_SWAP_DELAY_MS } from '../control'
import { logger } from '../../logger'
import { ensureInjectedManagedSkills } from '../../managed-skills'
import { managedOverlayRoot } from '../../project-layout'
import { serveConfigDir, servingConfigDir } from './boot-link'
import { resolveOpencodeConfigDir, type OpenCodeConfig } from './config'
import { type Opencode, type VerifiedReloadResult } from './lifecycle'
import { ensureOpencodeConfigDeps } from './opencode-config-deps'
import { pluginFilesFrom, provenCheck, toolNamesFromFiles } from './proven-check'

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

/**
 * Where OpenCode reads its config from, as this box reports it.
 *
 * Under config releases the chain is: the desired release, then the last
 * release this box proved, then the platform's image default. `/workspace` is
 * NOT a step in it — OpenCode never boots from the session's checkout while
 * the feature is on.
 *
 * `workspace` is reachable only when config releases are OFF for the project
 * (docs/specs/config-releases.md, "Feature flag"), which is the pre-release
 * behaviour: OpenCode reads `<workspace>/<config dir>`. The API emits no
 * release block for such a session, so `workspace` never reaches a client.
 */
export type ConfigSource = 'release' | 'workspace' | 'image-default'
/** The health `config` block. The converge response carries the same object. */
export interface ConfigReleaseReport {
  release_id: string | null
  desired_release_id: string | null
  source: ConfigSource
  /**
   * Always `follow-base`: a box runs the base branch's CURRENT config release.
   * `/workspace` stays the editable clone; an edit there reaches the box only
   * once it is pushed to the base branch. Null before the boot path ran.
   */
  mode: 'follow-base' | null
  proven: boolean
  fallback_reason: string | null
  failed_release_id: string | null
}

export type ConvergeOutcome = 'applied' | 'unchanged' | 'declined' | 'quarantined' | 'failed'

export interface ConvergeResponse {
  ok: boolean
  outcome: ConvergeOutcome
  config: ConfigReleaseReport
  reload: {
    how: 'restarted'
    turn_ended: boolean | null
    /**
     * The assistant message the RETIRED OpenCode left open, read off it before
     * it was killed. `null` when there was none, or when it could not be read.
     *
     * The API settles that row `runtime_gone` and redelivers its prompt. Left
     * unreported, the row stays `completed = null` for ever: the process that
     * owned it is gone, so it never emits `session.idle`/`session.error`, and
     * the replacement never held that turn's stream to finalize it.
     */
    orphaned_message_id: string | null
  } | null
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

/**
 * THE writer of the running config (PLAN-one-boot-path T4).
 *
 * `running` is what `/kortix/health`, `GET /config`, the CLI and the web all
 * read, so it is assigned in exactly one place. Everything that changes what
 * the box runs — the boot path, a convergence, the flag-off revert — states its
 * whole new answer here instead of patching a field from three call sites.
 */
export function setRunningConfig(next: Partial<RunningConfig>): void {
  running = { ...running, ...next }
}

/**
 * Record why the box keeps its running config instead of release `releaseId`.
 *
 * Rule: the step that chose the running config (the boot path) saw every step
 * down, so its reason is the most complete one. A later convergence that keeps
 * the same running config for the SAME failed release re-derives only its own
 * step ("is quarantined on this box", one candidate failure), so the existing
 * reason stays. A different failed release, or no reason yet, takes the new
 * reason. A proven release clears it.
 */
function recordKeptConfigFailure(releaseId: string, reason: string): void {
  if (running.failed_release_id === releaseId && running.fallback_reason) return
  setRunningConfig({ failed_release_id: releaseId, fallback_reason: reason })
}

/**
 * The box already runs the release the API wants, and the copy verifies.
 *
 * This is the only place a convergence ends with nothing to do, and it must
 * state the WHOLE answer — including that there is no failure any more. A
 * release is content-addressed by its config tree, so fixing a broken base
 * branch restores the release the box was already running: the convergence
 * that carries the fix answers `unchanged`, and any `fallback_reason` left
 * from the broken one now describes a release nobody wants.
 *
 * DEF-FLAGON-2, measured on a real Platinum box 2026-09-25: the fields
 * survived the fix and were still rendered — `/kortix/health`, `GET /config`
 * and the CLI's "! Fallback — the latest config failed to load…" — on a
 * session demonstrably running the desired, proven release. They cleared only
 * when a LATER, unrelated push produced a brand-new release ID. A project
 * whose config does not change again kept the false warning indefinitely.
 */
function noteDesiredReleaseMet(): void {
  setRunningConfig({ mode: 'follow-base', fallback_reason: null, failed_release_id: null })
}

export function resetConfigReleaseStateForTests(): void {
  setRunningConfig({ ...INITIAL })
  inFlight = null
}

export interface ConvergeDeps {
  cfg: OpenCodeConfig
  opencode: Pick<Opencode, 'reloadVerified' | 'getPid' | 'getInternalUrl'>
  root?: string
  /** Overlay source; defaults to the image-baked overlay. */
  managedSkillsDir?: string
  /** Defaults to the API settings in `cfg`. */
  api?: ConfigReleaseApi | null
  /** Dependencies + managed-skill overlay for a directory. Injectable for tests. */
  prepare?: (dir: string) => Promise<void>
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
  /**
   * FAULT INJECTION, in the same spirit as `verify_fail` on `POST
   * /kortix/refresh`: hold the convergence between the turn gate and the swap.
   *
   * The window this widens is the one DEF-DEV-1 lived in — the seconds a real
   * box spends downloading and extracting a release. Without it a test that
   * wants "a prompt arrives mid-convergence" has to win a race it cannot see;
   * with it the race is a schedule. It changes no decision: the same gate runs
   * before it and the same `mayPromote` runs after it.
   *
   * Bounded by `MAX_SWAP_DELAY_MS`. The route that accepts it is already
   * authorized, and a caller who can reach it can restart opencode outright.
   */
  delayBeforeSwapMs?: number
}

type ConfigDepsOptions = Omit<NonNullable<Parameters<typeof ensureOpencodeConfigDeps>[1]>, 'platformOwned'>

/** Dependencies and the managed-skill overlay, the preparation every config dir in the working tree gets. */
export async function prepareConfigDir(
  dir: string,
  managedSkillsDir?: string,
  depsOptions: ConfigDepsOptions = {},
  projectRoot?: string,
): Promise<void> {
  await ensureOpencodeConfigDeps(dir, depsOptions)
  await ensureInjectedManagedSkills(
    managedOverlayRoot(dir, projectRoot),
    managedSkillsDir ? { bakedDir: managedSkillsDir } : {},
  )
}

/**
 * The preparation of a config dir the PLATFORM owns: a release staging dir, or
 * the image default. Its dependencies are prepared until OpenCode's installer
 * has nothing to do: OpenCode runs on the boot link, a symlink, and npm's
 * Arborist re-extracts the whole node_modules tree through a symlinked root
 * (+5–7 s to opencode-ready on the old-starter shape, measured 2026-09-22;
 * ~10 s on a fresh scaffold, measured 2026-09-24).
 *
 * Never used on a working tree: its `package.json` is a tracked user file and
 * the plugin pin would dirty it.
 */
export async function preparePlatformConfigDir(
  dir: string,
  managedSkillsDir?: string,
  depsOptions: ConfigDepsOptions = {},
): Promise<void> {
  await ensureOpencodeConfigDeps(dir, { ...depsOptions, platformOwned: true })
  await ensureInjectedManagedSkills(dir, managedSkillsDir ? { bakedDir: managedSkillsDir } : {})
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
    ok: outcome === 'applied' || outcome === 'unchanged',
    outcome,
    config: configReleaseReport(),
    reload:
      reload && reload.outcome === 'swapped'
        ? {
            how: 'restarted',
            turn_ended: reload.turnEnded,
            orphaned_message_id: reload.orphanedMessageId,
          }
        : null,
    reason,
  }
}

/**
 * Write the session notice for the release a box is about to run. Never
 * throws: the notice is information, and a box that cannot write `/tmp` must
 * still converge.
 */
export function noteRunningConfig(
  descriptor: Pick<ConfigReleaseDescriptor, 'source_commit' | 'config_dir'> & { agent_repoint_reason?: string | null },
  releaseDirPath: string | null = null,
  sessionId: string | null = process.env.KORTIX_SESSION_ID ?? null,
): 'written' | 'unchanged' | 'failed' {
  try {
    return writeConfigReleaseNotice({
      sourceCommit: descriptor.source_commit,
      configDir: descriptor.config_dir,
      releaseDir: releaseDirPath,
      sessionId,
      agentRepoint: descriptor.agent_repoint_reason ?? null,
    })
  } catch (err) {
    logger.warn('[config-release] could not write the session config notice', { err: String(err) })
    return 'failed'
  }
}

/**
 * `config_releases` is OFF for this project — per project, or platform-wide
 * through the operator kill switch (docs/specs/config-releases.md, "Feature
 * flag"). The API answered `403 feature_disabled`.
 *
 * This is the transition, and it must not strand a box that already runs a
 * release:
 *
 * 1. OpenCode is pointed back at the session's workspace config dir, which is
 *    where it read its config before config releases existed. Its dependencies
 *    and the managed-skill overlay are prepared there first.
 * 2. The boot pointer is cleared, so a reboot does not come back on the
 *    release. The extracted release stays on disk; `pruneBootConfigs` removes
 *    it the next time a release is applied.
 * 3. Nothing is quarantined and no `fallback_reason` is set. The release did
 *    not fail; it no longer applies.
 *
 * A box that already reads the workspace config dir is answered `unchanged`
 * without a restart, so repeated convergences cost nothing. Governance is not
 * touched: with the flag off the API pushes `KORTIX_COMPILED_AGENT_CONFIG`
 * itself, as it did before releases.
 */
async function revertToPreReleaseConfig(
  deps: ConvergeDeps,
  root: string,
  apiMessage: string,
): Promise<ConvergeResponse> {
  const { cfg, opencode } = deps
  const dir = await resolveOpencodeConfigDir(cfg)
  const source: ConfigSource = dir === cfg.defaultOpencodeConfigDir ? 'image-default' : 'workspace'
  const reason = `config releases are disabled for this project; opencode reads ${dir} (${apiMessage})`
  const settled = () => ({
    release_id: null,
    desired_release_id: null,
    source,
    mode: null,
    proven: true,
    fallback_reason: null,
    failed_release_id: null,
    source_commit: null,
  })

  if (running.source !== 'release' && (await servingConfigDir(root)) === dir) {
    clearConfigReleaseNotice()
    await deactivateBootConfig(root)
    setRunningConfig(settled())
    // One clear line, then the daemon carries on.
    logger.info('[config-release] disabled for this project; opencode already reads the workspace config dir', { dir })
    return respond('unchanged', null, reason)
  }

  const idle = async (): Promise<boolean> =>
    !deps.turnInFlight || (await deps.turnInFlight().catch(() => null)) === false
  if (opencode.getPid() === null) return respond('failed', null, 'opencode is not running; nothing to replace')
  if (!(await idle())) {
    return respond('failed', null, 'a turn is running or its state is unknown; the revert waits for the next trigger')
  }

  // No release runs any more: the notice would be a false statement.
  clearConfigReleaseNotice()
  await (deps.prepare ?? ((target: string) => prepareConfigDir(target, deps.managedSkillsDir, {}, cfg.projectTarget)))(dir)
  const toolNames = await toolNamesInDir(dir)
  const pluginFiles = await pluginFilesInDir(dir)
  // The check above ran before `prepare`, which walks and rewrites a config
  // directory. Ask again now that the work is done, and ask once more inside
  // the reload — see `mayPromote`.
  if (!(await idle())) {
    return respond('failed', null, 'a turn is running or its state is unknown; the revert waits for the next trigger')
  }
  const previousDir = await servingConfigDir(root)
  await serveConfigDir(dir, 'config releases are disabled for this project', root)
  const result = await opencode.reloadVerified({
    prove: (baseUrl, deadline) =>
      (deps.prove ?? provenCheck)(baseUrl, deadline, {
        directory: cfg.projectTarget,
        toolNames,
        pluginFiles,
        configDir: dir,
        fetchImpl: deps.proveFetch,
      }),
    mayPromote: deps.turnInFlight ? idle : undefined,
  })
  if (result.outcome === 'kept-old') {
    if (previousDir) await serveConfigDir(previousDir, 'the workspace config dir did not start', root)
    if (result.promotionCalledOff) return respond('failed', null, result.reason)
    logger.warn('[config-release] disabled, but the workspace config dir did not start; keeping the release', {
      dir,
      reason: result.reason,
    })
    return respond('declined', null, result.reason)
  }

  await deactivateBootConfig(root)
  setRunningConfig(settled())
  logger.info('[config-release] disabled for this project; opencode reverted to the workspace config dir', { dir })
  return respond('applied', result, reason)
}

async function applyDesiredRelease(deps: ConvergeDeps): Promise<ConvergeResponse> {
  const { cfg, opencode } = deps
  const root = deps.root ?? bootConfigRoot()
  const api =
    deps.api === undefined
      ? configReleaseApiFrom({ apiUrl: cfg.apiUrl, projectId: cfg.projectId, sandboxToken: cfg.sandboxToken })
      : deps.api
  if (!api) return respond('failed', null, 'KORTIX_API_URL, KORTIX_PROJECT_ID, KORTIX_SESSION_ID or KORTIX_TOKEN is unset')

  // 1. The desired release. The request carries no inputs: the API always
  //    assigns the base branch's current release for this session's variant.
  let descriptor: ConfigReleaseDescriptor
  try {
    descriptor = await fetchConfigReleaseDescriptor(api)
  } catch (err) {
    // Config releases are switched off for this project (spec, "Feature
    // flag"). Not a failure: revert to the pre-release behaviour.
    if (isFeatureDisabledError(err)) return revertToPreReleaseConfig(deps, root, err.message)
    // API unreachable or older than the spec: the running config stays.
    return respond('failed', null, (err as Error).message)
  }
  const releaseId = effectiveReleaseId(descriptor)
  setRunningConfig({ desired_release_id: releaseId })
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
  //
  // It is asked THREE times on the download path, and that is the point: once
  // here, once again after the archive is built, and once more inside the
  // reload, after the candidate is proven and before the live port moves
  // (`mayPromote`). Dev measured 2.4-6.1 s for the fetch and extract and ~3.3 s
  // for the candidate boot, so a single check at the top is a TOCTOU: the
  // prompt that arrives inside that window starts a turn on the very process
  // the swap is about to kill.
  const idle = async (): Promise<boolean> =>
    !deps.turnInFlight || (await deps.turnInFlight().catch(() => null)) === false
  const requireRunning = async (): Promise<ConvergeResponse | null> => {
    if (opencode.getPid() === null) return respond('failed', null, 'opencode is not running; nothing to replace')
    if (!(await idle())) {
      return respond('failed', null, 'a turn is running or its state is unknown; the swap waits for the next trigger')
    }
    return null
  }

  const swap = async (dir: string, toolNames: readonly string[], pluginFiles: readonly string[] = []) => {
    // The boot link is the ONE thing that names OpenCode's config dir, so a
    // swap repoints it. The running process already holds its config in
    // memory, so the candidate on the standby port is the only reader of the
    // new target; a declined candidate puts the old target back.
    const previousDir = await servingConfigDir(root)
    await serveConfigDir(dir, 'a convergence is replacing opencode', root)
    // Tell the session which commit's config it is about to run, BEFORE the
    // replacement spawns: `writeComposedConfig` declares this file in
    // OpenCode's `instructions`, so the new process reads it (spec, "Telling
    // the session"). Only a convergence that actually replaces something
    // reaches `swap`, and the writer is a no-op when the text is unchanged.
    noteRunningConfig({ ...descriptor, agent_repoint_reason: agentRepointSentence(descriptor) }, dir)
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
      mayPromote: deps.turnInFlight ? idle : undefined,
    })
    if (result.outcome === 'kept-old') {
      if (previousDir) await serveConfigDir(previousDir, 'the candidate was declined', root)
      restoreGovernance()
    }
    return result
  }

  // Governance only: no repository access, or no config dir on the base branch.
  // The image default config dir runs with the compiled governance.
  if (descriptor.archive === null) {
    const dir = cfg.defaultOpencodeConfigDir
    if (running.release_id === releaseId && running.source === 'image-default' && (await servingConfigDir(root)) === dir) {
      noteDesiredReleaseMet()
      return respond('unchanged', null)
    }
    const notRunning = await requireRunning()
    if (notRunning) return notRunning
    const result = await swap(dir, [])
    if (result.outcome === 'kept-old') {
      if (result.promotionCalledOff) return respond('failed', null, result.reason)
      setRunningConfig({ fallback_reason: result.reason })
      return respond('declined', null, result.reason)
    }
    // A release this session may no longer read must not come back at boot.
    await deactivateBootConfig(root)
    setRunningConfig({
      release_id: releaseId,
      desired_release_id: releaseId,
      source: 'image-default',
      mode: 'follow-base',
      proven: true,
      fallback_reason: null,
      failed_release_id: null,
      source_commit: null,
    })
      logger.info('[config-release] opencode runs the image default config', { releaseId, reason: descriptor.reason })
    return respond('applied', result)
  }

  const manifest = manifestFromDescriptor(descriptor, releaseId)
  const dir = releaseDir(root, releaseId)
  const verifies = () =>
    verifyRelease({ dir, files: manifest.files, managedSkillsDir: deps.managedSkillsDir })

  // 3. Same release, intact copy: nothing to do. The boot path proves every
  //    release before the box is reportable as ready, so a running release is
  //    never unproven here.
  if (running.source === 'release' && running.release_id === releaseId && (await servingConfigDir(root)) === dir) {
    const check = await verifyReleaseDetail({ dir, files: manifest.files, managedSkillsDir: deps.managedSkillsDir })
    if (check.ok) {
      noteDesiredReleaseMet()
      return respond('unchanged', null)
    }
    logger.warn('[config-release] the running release no longer verifies; rebuilding', {
      releaseId,
      problem: check.problem,
    })
  }

  // 4. Quarantined on this box: keep the running config.
  const quarantined = (await readQuarantine(root))[releaseId]
  if (quarantined) {
    recordKeptConfigFailure(releaseId, `release ${releaseId.slice(0, 12)} is quarantined on this box: ${quarantined.reason}`)
    return respond('quarantined', null, running.fallback_reason)
  }

  const notRunning = await requireRunning()
  if (notRunning) return notRunning

  // Fault injection only; zero in production. Stands in for the seconds the
  // download and extract below cost on a real box — see `delayBeforeSwapMs`.
  const injectedDelay = Math.min(Math.max(deps.delayBeforeSwapMs ?? 0, 0), MAX_SWAP_DELAY_MS)
  if (injectedDelay > 0) {
    logger.warn('[config-release] holding the convergence before the swap (fault injection)', {
      ms: injectedDelay,
    })
    await new Promise((resolve) => setTimeout(resolve, injectedDelay))
  }

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
        prepare: deps.prepare ?? ((staged) => preparePlatformConfigDir(staged, deps.managedSkillsDir)),
      })
    }
  } catch (err) {
    // The archive route gates on the feature flag too, and it can be turned
    // off between the two calls.
    if (isFeatureDisabledError(err)) return revertToPreReleaseConfig(deps, root, err.message)
    // Transport, disk or verification failure: nothing is wrong with the
    // release itself, so it is not quarantined. The next trigger retries.
    const reason = `could not build release ${releaseId.slice(0, 12)}: ${(err as Error).message}`
    logger.warn('[config-release] release build failed; keeping the running config', { releaseId, reason })
    return respond('failed', null, reason)
  }

  // 7–9. Governance, replacement on the standby port, proven check, promotion.
  // The download and extract above took seconds. Ask again before paying the
  // ~3.3 s candidate boot, so a prompt that landed meanwhile costs nothing.
  const lateTurn = await requireRunning()
  if (lateTurn) return lateTurn
  const result = await swap(dir, toolNamesFromFiles(manifest.files), pluginFilesFrom(manifest.files))
  if (result.outcome === 'kept-old') {
    // A turn that started while the release was being built is not a release
    // failure: nothing is quarantined and nothing is recorded against it.
    if (result.promotionCalledOff) return respond('failed', null, result.reason)
    // 10. Keep the old process. Quarantine only a release whose candidate failed.
    if (result.candidateFailed) await quarantineRelease(root, releaseId, result.reason)
    recordKeptConfigFailure(releaseId, result.reason)
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
  setRunningConfig({
    release_id: releaseId,
    desired_release_id: releaseId,
    source: 'release',
    mode: 'follow-base',
    proven: true,
    fallback_reason: null,
    failed_release_id: null,
    source_commit: manifest.source_commit,
  })
  logger.info('[config-release] release applied', { releaseId, sourceCommit: manifest.source_commit, dir })
  return respond('applied', result)
}

