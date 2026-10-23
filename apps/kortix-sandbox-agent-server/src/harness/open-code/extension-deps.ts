/**
 * A kortix.yaml v3 OpenCode extension with npm dependencies.
 *
 * The extension's package folder is the nearest directory with a
 * `package.json` between the module and the config root (the root's own
 * `package.json` is the repository's, never an extension's). OpenCode loads
 * the plugin by file URL and Bun resolves a bare import from the module's
 * directory upward, so the folder is copied to a staged directory OUTSIDE
 * the repository, beside a `node_modules`:
 *
 *   1. the image-baked tree (`OPENCODE_CONFIG_DEPS_DIR`), linked, when every
 *      declared dependency is in it at a version the declared range accepts;
 *   2. else an install by `ensureOpencodeConfigDeps` (offline from the warm
 *      cache, then the declared ranges, then the registry).
 *
 * The working tree and a sealed release never receive a `node_modules`. The
 * staged directory is keyed by the folder's content, so an unchanged
 * extension reuses it and a changed one gets a new one. Any failure returns
 * null: the caller logs and skips that plugin, and the boot goes on.
 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, cp, mkdir, readFile, readdir, rename, rm, symlink } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { logger } from '@/lib/log/logger'
import { ensureOpencodeConfigDeps, OPENCODE_CONFIG_DEPS_DIR } from './opencode-config-deps'

/** @deprecated OpenCode is sunset: no new code. See harness/README.md "OpenCode sunset". */
export interface ExtensionDepsOptions {
  /** Where staged extensions live, outside the repository. */
  cacheRoot: string
  /** The image-baked dependency tree. Default: `OPENCODE_CONFIG_DEPS_DIR`. */
  bakedDir?: string
  /** The installer `ensureOpencodeConfigDeps` runs. Default: `bun install`. */
  install?: (stagingDir: string, opts: { offline: boolean }) => Promise<void>
}

const SKIPPED = new Set(['node_modules', '.git'])

/** The nearest dir holding a `package.json`, from the module's dir up to (not including) the config root. */
function packageFolder(configRoot: string, file: string): string | null {
  const top = resolve(configRoot)
  for (let dir = dirname(file); dir.startsWith(`${top}${sep}`); dir = dirname(dir)) {
    if (existsSync(join(dir, 'package.json'))) return dir
  }
  return null
}

/** sha256 over every file of `dir` (path and bytes), `node_modules` and `.git` excluded. */
async function contentHash(dir: string): Promise<string> {
  const hash = createHash('sha256').update(dir)
  const walk = async (rel: string): Promise<void> => {
    const entries = (await readdir(join(dir, rel), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (SKIPPED.has(entry.name)) continue
      const path = join(rel, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) hash.update(`\0${path}\0`).update(await readFile(join(dir, path)))
    }
  }
  await walk('')
  return hash.digest('hex').slice(0, 32)
}

/** Every declared dependency is in `modules` at a version its range accepts. */
async function satisfiedBy(modules: string, folder: string): Promise<boolean> {
  try {
    const declared = (JSON.parse(await readFile(join(folder, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> })
      .dependencies ?? {}
    for (const [name, range] of Object.entries(declared)) {
      const { version } = JSON.parse(await readFile(join(modules, name, 'package.json'), 'utf8')) as { version?: string }
      if (typeof version !== 'string' || !Bun.semver.satisfies(version, range)) return false
    }
    return true
  } catch {
    return false
  }
}

/**
 * The plugin spec for `module` (a config-root-relative path): its file URL in
 * the repository when it has no package folder, else in its staged copy. Null
 * when the dependencies could not be provided.
 * @deprecated OpenCode is sunset: no new code. See harness/README.md "OpenCode sunset".
 */
export async function stageExtensionModule(configRoot: string, module: string, opts: ExtensionDepsOptions): Promise<string | null> {
  const file = resolve(configRoot, module)
  const folder = packageFolder(configRoot, file)
  if (!folder) return pathToFileURL(file).href
  const bakedDir = opts.bakedDir ?? OPENCODE_CONFIG_DEPS_DIR
  const { cacheRoot } = opts
  let temp: string | null = null
  try {
    const staged = join(cacheRoot, await contentHash(folder))
    const spec = pathToFileURL(join(staged, relative(folder, file))).href
    if (existsSync(join(staged, 'node_modules'))) return spec

    temp = join(cacheRoot, `.stage-${randomUUID()}`)
    await mkdir(cacheRoot, { recursive: true })
    await cp(folder, temp, { recursive: true, filter: (source) => !SKIPPED.has(source.split(sep).at(-1) ?? '') })
    // A config release is sealed read-only and `cp` keeps its modes: the copy
    // could take no node_modules, and the cleanup could not delete it.
    await makeDirsWritable(temp)
    const bakedModules = join(bakedDir, 'node_modules')
    if (await satisfiedBy(bakedModules, temp)) {
      await symlink(bakedModules, join(temp, 'node_modules'))
    } else {
      await ensureOpencodeConfigDeps(temp, { bakedDir, install: opts.install, platformOwned: true })
      if (!(await satisfiedBy(join(temp, 'node_modules'), temp))) throw new Error('its dependencies could not be installed')
    }
    await rename(temp, staged).catch(async (err) => {
      // A concurrent compose staged the same content first.
      if (!existsSync(join(staged, 'node_modules'))) throw err
    })
    return spec
  } catch (err) {
    logger.warn('[opencode] kortix.yaml extension dependencies are not available; the plugin is skipped', {
      module,
      err: err instanceof Error ? err.message : String(err),
    })
    return null
  } finally {
    if (temp) await rm(temp, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** Give the owner write access to `dir` and every directory below it. */
async function makeDirsWritable(dir: string): Promise<void> {
  await chmod(dir, 0o755)
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) await makeDirsWritable(join(dir, entry.name))
  }
}
