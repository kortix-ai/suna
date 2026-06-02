import { execFile } from 'node:child_process'
import { access, constants, copyFile, symlink } from 'node:fs/promises'
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
 * Pre-satisfy it deterministically and offline *before* OpenCode starts:
 *   1. fastest — symlink the image-baked, pre-installed node_modules in (+ copy
 *      the matching bun.lock so OpenCode's own install verifies as a no-op);
 *   2. fallback — `bun install --offline` from the pre-warmed Bun cache;
 *   3. last resort — do nothing; OpenCode's own (online) install still works.
 *
 * Any path turns the network-bound resolve into <0.5s. Never throws: a failure
 * here just means OpenCode falls back to its slower self-install.
 */
export async function ensureOpencodeConfigDeps(
  configDir: string,
  opts: { bakedDir?: string } = {},
): Promise<void> {
  const bakedDir = opts.bakedDir ?? BAKED_DEPS_DIR
  try {
    if (!(await pathExists(join(configDir, 'package.json')))) return // no deps declared
    if (await pathExists(join(configDir, 'node_modules'))) return // already satisfied

    // 1. Restore the image-baked tree (instant, offline, deterministic).
    const bakedModules = join(bakedDir, 'node_modules')
    if (await pathExists(bakedModules)) {
      await symlink(bakedModules, join(configDir, 'node_modules'))
      const bakedLock = join(bakedDir, 'bun.lock')
      if ((await pathExists(bakedLock)) && !(await pathExists(join(configDir, 'bun.lock')))) {
        await copyFile(bakedLock, join(configDir, 'bun.lock'))
      }
      logger.info('[boot] linked baked opencode config deps', { configDir, from: bakedModules })
      return
    }

    // 2. No baked tree (pre-bake image) → offline install from the warm cache.
    await execFileAsync('bun', ['install', '--offline'], {
      cwd: configDir,
      env: { ...process.env, HOME: OPENCODE_HOME, BUN_INSTALL_CACHE_DIR: BUN_CACHE_DIR },
    })
    logger.info('[boot] offline-installed opencode config deps', { configDir })
  } catch (err) {
    logger.warn('[boot] ensureOpencodeConfigDeps failed; opencode will self-install', {
      configDir,
      err: err instanceof Error ? err.message : String(err),
    })
  }
}
