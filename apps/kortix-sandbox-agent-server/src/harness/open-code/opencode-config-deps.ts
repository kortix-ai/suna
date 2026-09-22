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
import { logger } from '../../logger'
import { OPENCODE_HOME } from './paths'

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

const OPENCODE_PLUGIN_PACKAGE = '@opencode-ai/plugin'
const PLUGIN_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const

function dependencyMap(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

/** May the sentinel be written? Only when no user-owned npm lock is there. */
async function lockIsReplaceable(packageLockPath: string): Promise<boolean> {
  if (!(await pathExists(packageLockPath))) return true
  try {
    const existing = JSON.parse(await readFile(packageLockPath, 'utf8')) as {
      kortixOpenCodeInstallSentinel?: unknown
    }
    return existing.kortixOpenCodeInstallSentinel === INSTALL_SENTINEL_VERSION
  } catch {
    return false
  }
}

async function writeSentinelLock(
  configDir: string,
  packageJson: ConfigPackageJson,
  dependencies: Record<string, string>,
): Promise<void> {
  const packageLockPath = join(configDir, 'package-lock.json')
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
}

/**
 * A config release is the platform's own copy, so its `package.json` may carry
 * the plugin pin OpenCode would write at spawn anyway: the binary's version,
 * which the baked dependency dir records (runtime-assets keeps it current).
 * Rewriting it BEFORE the install gets the matching plugin from the warm Bun
 * cache instead of from npm inside OpenCode. Returns the pin it wrote, or null.
 */
async function normalizeReleasePluginPin(configDir: string, bakedDir: string): Promise<string | null> {
  try {
    const baked = JSON.parse(await readFile(join(bakedDir, 'package.json'), 'utf8')) as ConfigPackageJson
    const pin = dependencyMap(baked.dependencies)[OPENCODE_PLUGIN_PACKAGE]
    if (typeof pin !== 'string' || !PLUGIN_VERSION.test(pin)) return null
    const packagePath = join(configDir, 'package.json')
    const packageJson = JSON.parse(await readFile(packagePath, 'utf8')) as ConfigPackageJson
    const dependencies = dependencyMap(packageJson.dependencies)
    const declared = dependencies[OPENCODE_PLUGIN_PACKAGE]
    if (typeof declared !== 'string' || declared === pin) return null
    dependencies[OPENCODE_PLUGIN_PACKAGE] = pin
    await writeFile(packagePath, `${JSON.stringify({ ...packageJson, dependencies }, null, 2)}\n`)
    return pin
  } catch {
    return null
  }
}

/**
 * The sentinel for a release copy whose dependency set is not the local tool
 * ABI. OpenCode's installer runs Arborist whenever a declared name, or the
 * plugin it adds, is missing from `package-lock.json`. The release was just
 * installed offline, so the sentinel names every declared dependency plus the
 * plugin, and only when each one is really in node_modules. Anything missing
 * leaves OpenCode's installer in charge.
 */
async function writeReleaseInstallSentinel(configDir: string): Promise<boolean> {
  const packageJson = JSON.parse(await readFile(join(configDir, 'package.json'), 'utf8')) as ConfigPackageJson &
    Record<string, unknown>
  if (!(await lockIsReplaceable(join(configDir, 'package-lock.json')))) return false
  const dependencies: Record<string, string> = {}
  for (const field of DEPENDENCY_FIELDS) {
    for (const [name, spec] of Object.entries(dependencyMap(packageJson[field]))) {
      dependencies[name] = typeof spec === 'string' ? spec : '*'
    }
  }
  dependencies[OPENCODE_PLUGIN_PACKAGE] ??= '*'
  for (const name of Object.keys(dependencies)) {
    if (!(await pathExists(join(configDir, 'node_modules', name, 'package.json')))) return false
  }
  await writeSentinelLock(configDir, packageJson, dependencies)
  return true
}

async function writeInstallSentinel(configDir: string, platformOwned = false): Promise<boolean> {
  const packagePath = join(configDir, 'package.json')
  const packageLockPath = join(configDir, 'package-lock.json')
  const packageJson = JSON.parse(await readFile(packagePath, 'utf8')) as ConfigPackageJson
  if (!isLocalToolAbiPackage(packageJson)) return platformOwned ? writeReleaseInstallSentinel(configDir) : false

  if (!(await lockIsReplaceable(packageLockPath))) return false

  // OpenCode 1.18.19 adds @opencode-ai/plugin through npm's Arborist before
  // loading config. Arborist skips the reify when every declared name exists
  // in packages[""].dependencies. The local ABI does not import the plugin, so
  // this runtime-only lock prevents a redundant 55 MB install without claiming
  // that the plugin exists in node_modules.
  await writeSentinelLock(configDir, packageJson, {
    '@opencode-ai/plugin': '*',
    zod: '4.1.8',
  })
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
 * sentinel on BOTH paths. OpenCode sees its optional SDK name as resolved and
 * skips the redundant install, which also stops its `save: true` reify from
 * writing @opencode-ai/plugin into the tracked config-dir package.json.
 * Customized configs keep the normal installer.
 *
 * Never throws: a failure here means OpenCode falls back to its self-install.
 */
export async function ensureOpencodeConfigDeps(
  configDir: string,
  opts: {
    bakedDir?: string
    install?: InstallDeps
    /**
     * `configDir` is a config release, the platform's own copy: the plugin pin
     * is normalized and any fully installed dependency set gets the sentinel.
     * Never set for a working tree: its package.json is a tracked user file.
     */
    platformOwned?: boolean
  } = {},
): Promise<void> {
  const bakedDir = opts.bakedDir ?? BAKED_DEPS_DIR
  const install = opts.install ?? offlineInstall
  const platformOwned = opts.platformOwned === true
  const targetModules = join(configDir, 'node_modules')
  let stagingDir: string | null = null
  try {
    if (!(await pathExists(join(configDir, 'package.json')))) return // no deps declared
    const pluginPin = platformOwned ? await normalizeReleasePluginPin(configDir, bakedDir) : null
    if (pluginPin) logger.info('[boot] release plugin pin set to the binary version', { configDir, pin: pluginPin })

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
      const installSentinel = await writeInstallSentinel(configDir, platformOwned)
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
    // The sentinel belongs to BOTH paths, not just the linked one. The baked
    // dependency set (dockerfile-layer.ts) is a superset of the lean local tool
    // ABI, so their bun.lock files never match and the standard image always
    // lands here. Without the sentinel OpenCode reifies with `save: true` and
    // writes @opencode-ai/plugin into the config dir's package.json — a TRACKED
    // file in the user's repository. Convergence must never dirty a working
    // tree (see runtime-assets.ts `readPluginPin`).
    const installSentinel = await writeInstallSentinel(configDir, platformOwned)
    logger.info('[boot] staged opencode config deps installed', { configDir, installSentinel })
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
