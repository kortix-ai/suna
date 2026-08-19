import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  constants,
  access,
  copyFile,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
} from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { logger } from './logger'
import { OPENCODE_HOME } from './opencode'

const execFileAsync = promisify(execFile)

/**
 * Image-baked, fully-installed copy of the OpenCode config-dir dependencies.
 * Produced by the snapshot Dockerfile (see `dockerfile-layer.ts`) so we can
 * satisfy the config dir's node_modules at boot with zero network work.
 */
const BAKED_DEPS_DIR = '/opt/kortix/opencode-config-deps'
const BUN_CACHE_DIR = `${OPENCODE_HOME}/.bun/install/cache`

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p, constants.F_OK)
    return true
  } catch {
    return false
  }
}

async function pathEntryExists(p: string): Promise<boolean> {
  try {
    await lstat(p)
    return true
  } catch {
    return false
  }
}

async function filesMatch(left: string, right: string): Promise<boolean> {
  try {
    const [leftBytes, rightBytes] = await Promise.all([readFile(left), readFile(right)])
    return leftBytes.equals(rightBytes)
  } catch {
    return false
  }
}

async function replaceNodeModules(configDir: string, replacement: string): Promise<void> {
  const target = join(configDir, 'node_modules')
  const backup = join(configDir, `.node_modules-backup-${randomUUID()}`)
  const hadTarget = await pathEntryExists(target)

  try {
    if (hadTarget) await rename(target, backup)
    await rename(replacement, target)
  } catch (err) {
    if (hadTarget && (await pathEntryExists(backup))) {
      await rename(backup, target).catch(() => undefined)
    }
    throw err
  } finally {
    // A failed rename can leave the staged link/tree at its temporary path.
    await rm(replacement, { recursive: true, force: true }).catch(() => undefined)
  }
  if (hadTarget) await rm(backup, { recursive: true, force: true }).catch(() => undefined)
}

type InstallDeps = (stagingDir: string) => Promise<void>

async function offlineInstall(stagingDir: string): Promise<void> {
  await execFileAsync('bun', ['install', '--offline'], {
    cwd: stagingDir,
    env: { ...process.env, HOME: OPENCODE_HOME, BUN_INSTALL_CACHE_DIR: BUN_CACHE_DIR },
  })
}

/**
 * Make OpenCode's boot-time dependency install free.
 *
 * OpenCode runs `bun install` inside the resolved config dir the first time a
 * session opens, because that dir's `package.json` declares the deps its custom
 * tools (web_search / scrape_webpage / …) import. `node_modules`, `bun.lock`
 * and `package.json` are all gitignored in the starter, so after the per-session
 * clone they're absent — and that install then RE-RESOLVES the package.json's
 * `^` ranges against the npm registry over the network. Measured at 1.5–6s
 * normally, and minutes when the registry is contended; it sits squarely on the
 * session boot hot path (it gates `runtimeReady`).
 *
 * Pre-satisfy it deterministically and offline before OpenCode starts:
 *   1. link image-baked modules only when both lock files match;
 *   2. otherwise install in a staging directory from the warm Bun cache;
 *   3. atomically replace node_modules only after installation completes;
 *   4. remove stale modules after installation failure so OpenCode performs a
 *      clean online install.
 *
 * Any path turns the network-bound resolve into <0.5s. Never throws: a failure
 * here just means OpenCode falls back to its slower self-install.
 */
export async function ensureOpencodeConfigDeps(
  configDir: string,
  opts: { bakedDir?: string; install?: InstallDeps } = {},
): Promise<void> {
  const bakedDir = opts.bakedDir ?? BAKED_DEPS_DIR
  const install = opts.install ?? offlineInstall
  const targetModules = join(configDir, 'node_modules')
  let stagingDir: string | null = null
  try {
    if (!(await pathExists(join(configDir, 'package.json')))) return // no deps declared

    const bakedModules = join(bakedDir, 'node_modules')
    const bakedLock = join(bakedDir, 'bun.lock')
    const configLock = join(configDir, 'bun.lock')

    // A matching lock proves that the baked tree satisfies this project. Do
    // not retain an unverified real tree because OpenCode can update it in
    // place and leave partially-written package files after interruption.
    if ((await pathExists(bakedModules)) && (await filesMatch(configLock, bakedLock))) {
      const stagedLink = join(configDir, `.node_modules-link-${randomUUID()}`)
      await symlink(bakedModules, stagedLink)
      await replaceNodeModules(configDir, stagedLink)
      logger.info('[boot] linked baked opencode config deps', { configDir, from: bakedModules })
      return
    }

    // A project-specific lock needs a project-specific tree. Install away
    // from the live config so OpenCode never observes partial package writes.
    stagingDir = join(configDir, `.deps-stage-${randomUUID()}`)
    await mkdir(stagingDir, { recursive: true })
    await copyFile(join(configDir, 'package.json'), join(stagingDir, 'package.json'))
    if (await pathExists(configLock)) {
      await copyFile(configLock, join(stagingDir, 'bun.lock'))
    }
    await install(stagingDir)
    const stagedModules = join(stagingDir, 'node_modules')
    if (!(await pathEntryExists(stagedModules))) {
      throw new Error('dependency installation completed without node_modules')
    }
    await replaceNodeModules(configDir, stagedModules)
    const stagedLock = join(stagingDir, 'bun.lock')
    if (await pathExists(stagedLock)) await copyFile(stagedLock, configLock)
    logger.info('[boot] staged opencode config deps installed', { configDir })
  } catch (err) {
    // A stale tree is unsafe after a failed replacement. Remove it so
    // OpenCode starts from an empty path and performs its own clean install.
    await rm(targetModules, { recursive: true, force: true }).catch(() => undefined)
    logger.warn('[boot] ensureOpencodeConfigDeps failed; opencode will self-install', {
      configDir,
      err: err instanceof Error ? err.message : String(err),
    })
  } finally {
    if (stagingDir) {
      await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}
