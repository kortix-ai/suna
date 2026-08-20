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
  writeFile,
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
export const OPENCODE_CONFIG_DEPS_DIR = '/opt/kortix/opencode-config-deps'
const BAKED_DEPS_DIR = OPENCODE_CONFIG_DEPS_DIR
const BUN_CACHE_DIR = `${OPENCODE_HOME}/.bun/install/cache`
const LOCAL_TOOL_ABI = 1
const INSTALL_SENTINEL_VERSION = 1

type ConfigPackageJson = {
  name?: unknown
  version?: unknown
  kortixToolAbi?: unknown
  dependencies?: unknown
}

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

function isLocalToolAbiPackage(value: ConfigPackageJson): value is ConfigPackageJson & {
  dependencies: { zod: '4.1.8' }
} {
  if (value.kortixToolAbi !== LOCAL_TOOL_ABI) return false
  if (!value.dependencies || typeof value.dependencies !== 'object') return false
  const dependencies = value.dependencies as Record<string, unknown>
  return Object.keys(dependencies).length === 1 && dependencies.zod === '4.1.8'
}

async function writeInstallSentinel(configDir: string): Promise<boolean> {
  const packagePath = join(configDir, 'package.json')
  const packageLockPath = join(configDir, 'package-lock.json')
  const packageJson = JSON.parse(await readFile(packagePath, 'utf8')) as ConfigPackageJson
  if (!isLocalToolAbiPackage(packageJson)) return false

  if (await pathExists(packageLockPath)) {
    try {
      const existing = JSON.parse(await readFile(packageLockPath, 'utf8')) as {
        kortixOpenCodeInstallSentinel?: unknown
      }
      if (existing.kortixOpenCodeInstallSentinel !== INSTALL_SENTINEL_VERSION) return false
    } catch {
      return false
    }
  }

  // OpenCode 1.18.19 adds @opencode-ai/plugin through npm's Arborist before
  // loading config. Arborist skips the reify when every declared name exists
  // in packages[""].dependencies. The local ABI does not import the plugin, so
  // this runtime-only lock prevents a redundant 55 MB install without claiming
  // that the plugin exists in node_modules.
  const dependencies = {
    '@opencode-ai/plugin': '*',
    zod: '4.1.8',
  }
  const sentinel = {
    name: typeof packageJson.name === 'string' ? packageJson.name : 'kortix-opencode-config',
    version: typeof packageJson.version === 'string' ? packageJson.version : '0.0.0',
    lockfileVersion: 3,
    requires: true,
    kortixOpenCodeInstallSentinel: INSTALL_SENTINEL_VERSION,
    packages: {
      '': {
        dependencies,
      },
    },
  }
  const temporaryPath = `${packageLockPath}.${randomUUID()}.tmp`
  try {
    await writeFile(temporaryPath, `${JSON.stringify(sentinel, null, 2)}\n`)
    await rename(temporaryPath, packageLockPath)
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
  }
  return true
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
 * OpenCode verifies dependencies inside the resolved config dir the first time
 * a session opens. Its installer also adds @opencode-ai/plugin even when local
 * tools do not import that SDK. This can re-resolve packages against the npm
 * registry and expand the lean 5.7 MB tree to about 61 MB. The work sits on the
 * session boot hot path because it gates `runtimeReady`.
 *
 * Pre-satisfy it deterministically and offline before OpenCode starts:
 *   1. link image-baked modules only when both lock files match;
 *   2. otherwise install in a staging directory from the warm Bun cache;
 *   3. atomically replace node_modules only after installation completes;
 *   4. remove stale modules after installation failure so OpenCode performs a
 *      clean online install.
 *
 * A matching, versioned local tool ABI also receives a runtime-only npm lock
 * sentinel. OpenCode sees its optional SDK name as resolved and skips the
 * redundant install. Customized configs keep the normal installer.
 *
 * Never throws: a failure here means OpenCode falls back to its self-install.
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
      const installSentinel = await writeInstallSentinel(configDir)
      logger.info('[boot] linked baked opencode config deps', {
        configDir,
        from: bakedModules,
        installSentinel,
      })
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
