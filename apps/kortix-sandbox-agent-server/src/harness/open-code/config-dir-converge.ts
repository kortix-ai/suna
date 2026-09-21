import {
  activateBootConfig,
  bootConfigRoot,
  deactivateBootConfig,
  materializeBootConfig,
  pruneBootConfigs,
  readBootConfigPointer,
  verifyBootConfig,
} from '../../boot-config-git'
import type { Config } from '../../config'
import { inspectSessionConfigWork, type ConfigDirSyncResult } from '../../git'
import { logger } from '../../logger'
import { ensureInjectedManagedSkills } from '../../managed-skills'
import type { Opencode } from './lifecycle'
import { ensureOpencodeConfigDeps } from './opencode-config-deps'

/**
 * Put opencode on the base branch's CURRENT config — without writing `/workspace`.
 *
 * One switch decides which directory opencode reads:
 *
 *   - the session has config work of its own  → `/workspace/<config dir>`. Its
 *     edits take effect, exactly as they always have. Reported `local changes` /
 *     `local commits`, which the API renders as "kept yours".
 *   - otherwise → a read-only copy of the config dir at the base tip
 *     (boot-config.ts). A merge to the base branch reaches the session on its
 *     next reload or wake, however the session's own branch has diverged in the
 *     rest of the repository.
 *
 * The switch is re-evaluated on every call and goes both ways: a session that
 * starts editing its agent is moved back onto its working tree, so the edit is
 * not silently shadowed by the copy.
 *
 * `/workspace` is the floor. No pointer means the working-tree config dir, which
 * is what every box ran before this existed, and every failure path below ends
 * there or leaves the running opencode untouched.
 */

export interface ConfigDirConvergeInput {
  cfg: Config
  opencode: Pick<Opencode, 'useConfigDir' | 'reloadVerified'>
  /** Repo-relative config dir, or null when the project tracks none. */
  relConfigDir: string | null
  /** Absolute working-tree config dir — the floor. */
  workspaceConfigDir: string
  baseSha?: string
  /**
   * Respawn opencode when the directory it reads changed. `OPENCODE_CONFIG_DIR`
   * is process env, so a dispose cannot move it; this is the verified swap that
   * keeps the running process if the replacement does not come up.
   */
  reload: boolean
  root?: string
  managedSkillsDir?: string
  /** Dependencies + managed-skill overlay for a fresh copy. Injectable for tests. */
  prepare?: (stagedDir: string) => Promise<void>
}

export type ConfigDirConvergeResult = ConfigDirSyncResult & {
  /** Present when opencode was respawned for the change. */
  reload?: { how: 'restarted' | 'kept-old'; turnEnded: boolean | null }
  /** The base commit the box now runs from the copy; null on the workspace floor. */
  sha?: string | null
}

async function defaultPrepare(managedSkillsDir: string | undefined, stagedDir: string): Promise<void> {
  await ensureOpencodeConfigDeps(stagedDir)
  await ensureInjectedManagedSkills(stagedDir, managedSkillsDir ? { bakedDir: managedSkillsDir } : {})
}

export async function convergeOpencodeConfigDir(input: ConfigDirConvergeInput): Promise<ConfigDirConvergeResult> {
  const root = input.root ?? bootConfigRoot()
  const inspected = await inspectSessionConfigWork(input.cfg, input.relConfigDir, input.baseSha, {
    managedSkillsDir: input.managedSkillsDir,
  })
  if (!inspected.ok) return { synced: false, skipped: inspected.skipped }
  const { tipSha, inBase, ownWork, headMatchesTip } = inspected.inspection
  const relConfigDir = input.relConfigDir as string
  const pointer = await readBootConfigPointer(root)

  /** Respawn onto `dir`; on a declined swap, put the previous directory back. */
  const switchTo = async (dir: string): Promise<ConfigDirConvergeResult['reload'] | 'declined'> => {
    const previous = input.opencode.useConfigDir(dir)
    if (!input.reload || previous === dir) return undefined
    const result = await input.opencode.reloadVerified()
    if (result.outcome === 'kept-old') {
      input.opencode.useConfigDir(previous)
      logger.warn('[config-dir] opencode kept its previous config dir', { wanted: dir, reason: result.reason })
      return 'declined'
    }
    return { how: 'restarted', turnEnded: result.turnEnded }
  }

  if (ownWork) {
    // The session edits its own agent. If it was running the copy, move it back
    // onto its working tree, or those edits are shadowed and never take effect.
    if (pointer) {
      const reload = await switchTo(input.workspaceConfigDir)
      if (reload !== 'declined') await deactivateBootConfig(root)
      return { synced: false, skipped: ownWork, sha: null, ...(reload && reload !== 'declined' ? { reload } : {}) }
    }
    return { synced: false, skipped: ownWork, sha: null }
  }
  if (!inBase) return { synced: false, skipped: 'not in base' }

  const copy = { repo: input.cfg.projectTarget, sha: tipSha, relConfigDir, root, managedSkillsDir: input.managedSkillsDir }
  if (pointer?.sha === tipSha && (await verifyBootConfig({ ...copy, dir: pointer.dir }))) {
    return { synced: false, skipped: 'already matches base', sha: tipSha }
  }
  // Never converged, and the branch already carries the tip's config: the
  // working tree IS the current config. Nothing to extract.
  if (!pointer && headMatchesTip) return { synced: false, skipped: 'already matches base', sha: null }

  let dir: string
  try {
    ;({ dir } = await materializeBootConfig({
      ...copy,
      prepare: input.prepare ?? ((staged) => defaultPrepare(input.managedSkillsDir, staged)),
    }))
  } catch (err) {
    logger.warn('[config-dir] could not materialize the base config', { sha: tipSha, err: String(err) })
    return { synced: false, skipped: 'checkout failed' }
  }

  const reload = await switchTo(dir)
  if (reload === 'declined') return { synced: false, skipped: 'reload declined', sha: pointer?.sha ?? null }

  await activateBootConfig(root, { sha: tipSha, relConfigDir, dir })
  await pruneBootConfigs(root, pointer ? [dir, pointer.dir] : [dir])
  logger.info('[config-dir] opencode reads the base config', { sha: tipSha, dir })
  return { synced: true, sha: tipSha, ...(reload ? { reload } : {}) }
}

/**
 * The directory opencode should be spawned against at daemon start.
 *
 * A resume restarts this process, so the choice has to survive on disk: the
 * pointer. It is honoured only when the copy still verifies against its commit;
 * a copy that was tampered with or half-deleted is rebuilt, and if that fails
 * the box is back on its working tree. Never throws.
 */
export async function resolveActiveOpencodeConfigDir(input: {
  cfg: Config
  workspaceConfigDir: string
  root?: string
  managedSkillsDir?: string
  prepare?: (stagedDir: string) => Promise<void>
}): Promise<{ dir: string; sha: string | null }> {
  const root = input.root ?? bootConfigRoot()
  const floor = { dir: input.workspaceConfigDir, sha: null }
  try {
    const pointer = await readBootConfigPointer(root)
    if (!pointer) return floor
    const copy = {
      repo: input.cfg.projectTarget,
      sha: pointer.sha,
      relConfigDir: pointer.relConfigDir,
      root,
      managedSkillsDir: input.managedSkillsDir,
    }
    if (await verifyBootConfig({ ...copy, dir: pointer.dir })) return { dir: pointer.dir, sha: pointer.sha }
    logger.warn('[config-dir] the config copy no longer matches its commit; rebuilding', { sha: pointer.sha })
    const { dir } = await materializeBootConfig({
      ...copy,
      prepare: input.prepare ?? ((staged) => defaultPrepare(input.managedSkillsDir, staged)),
    })
    return { dir, sha: pointer.sha }
  } catch (err) {
    logger.warn('[config-dir] falling back to the working-tree config dir', { err: String(err) })
    await deactivateBootConfig(root).catch(() => undefined)
    return floor
  }
}
