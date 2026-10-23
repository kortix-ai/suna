/**
 * The read-only copy of a thread's memory pages (`project_channels`):
 * `/opt/kortix/memory/<dir>/`, one folder per layer (`company`, `channel`,
 * `personal`). Postgres holds the pages; this copy lets an agent read them
 * with its file tools. Agents write through the `remember` tool.
 *
 * At every turn start apps/api names the thread's layers and their versions
 * (`memory_layers` on the Kortix prompt body). `.version` holds the layer
 * version and a hash of every other file in the folder. A layer whose version
 * differs, or whose files no longer match the hash (the agent shares the
 * daemon's user and can unlock and edit them), is fetched from the API's
 * layer export (session token) and its folder is replaced: written whole
 * beside it, then swapped in. A fetch that fails or takes over 3 s leaves the
 * old copy, and the turn runs with it.
 */
import { createHash, randomBytes } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, readdir, readlink, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { MEMORY_COPY_DIR } from '@kortix/api-contract/sandbox-layout'
import { logger } from '@/lib/log/logger'

export const MEMORY_COPY_DIRS = ['company', 'channel', 'personal'] as const
export type MemoryCopyDir = (typeof MEMORY_COPY_DIRS)[number]

/** One `memory_layers` entry of the prompt body. */
export interface MemoryLayerRef {
  layer_id: string
  /** `memory_layers.version`, as text (a bigint). */
  version: string
  dir: MemoryCopyDir
}

/**
 * What `GET /v1/projects/:projectId/memory/layers/:layerId/export` answers, as
 * far as the copy reads it. The API renders every file: `index` is INDEX.md,
 * each page's `markdown` is its whole file (YAML header and body, source
 * tokens resolved), written to `<type folder>/<slug>.md`.
 */
interface LayerExport {
  version: number | string
  index: string
  pages: Array<{ type: string; slug: string; markdown: string }>
}

/** A page type → its folder in a layer's copy. */
export const TYPE_FOLDERS: Record<string, string> = {
  people: 'people',
  decisions: 'decisions',
  workstreams: 'workstreams',
  playbooks: 'playbooks',
  note: 'notes',
}
const FILE_NAME_RE = /^[a-z0-9-]+\.md$/
const TIMEOUT_MS = 3_000
/** Above the API's caps (200 pages of 8 KiB, an index of 8,000 characters per layer). */
const MAX_EXPORT_BYTES = 4 * 1024 * 1024
const MAX_PAGES = 250

export interface MemoryCopyOptions {
  /** Default `MEMORY_COPY_DIR`. */
  root?: string
  fetch?: typeof fetch
  /** Per layer, the wait for an earlier sync of the folder included; default 3 s. */
  timeoutMs?: number
  /**
   * `layers` is the turn's whole list: remove every copy folder it does not
   * name (a thread that became shared loses the owner's `personal` copy).
   * Off for `remember`, which names only the layer it wrote.
   */
  prune?: boolean
}

// replica-local: one daemon per box; serializes the folder swap per layer folder.
const running = new Map<string, Promise<unknown>>()
// replica-local: the `.version` text this daemon last wrote per folder, so an edited `.version` is caught too.
const written = new Map<string, string>()

/**
 * Bring each layer's folder to its version, all layers at once, and with
 * `prune` remove the folders the list does not name. Never throws: a layer
 * that fails is logged and keeps its old copy.
 */
export async function syncMemoryCopy(layers: readonly MemoryLayerRef[], env: Record<string, string | undefined>, options: MemoryCopyOptions = {}): Promise<void> {
  const root = options.root ?? MEMORY_COPY_DIR
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS
  const listed = new Set<string>(layers.map((layer) => layer.dir))
  const unlisted = options.prune ? MEMORY_COPY_DIRS.filter((dir) => !listed.has(dir)) : []
  await Promise.all([
    ...layers.map((layer) =>
      queued(join(root, layer.dir), async (before) => {
        if (before && !(await settlesWithin(before, timeoutMs))) throw new Error('an earlier sync of this folder is still running')
        await syncLayer(root, join(root, layer.dir), layer, env, options.fetch ?? fetch, timeoutMs)
      }).catch((err) =>
        logger.warn('[memory-copy] layer not synced; the old copy stays', { dir: layer.dir, layer_id: layer.layer_id, error: err instanceof Error ? err.message : String(err) }),
      ),
    ),
    // Waits for an earlier sync of the folder with no cap (each is capped): a folder this thread may no longer read must go.
    ...unlisted.map((dir) =>
      queued(join(root, dir), async (before) => {
        await before
        await removeFolder(root, join(root, dir))
      }).catch((err) => logger.error('[memory-copy] a memory folder this thread no longer reads was not removed', { dir, error: err instanceof Error ? err.message : String(err) })),
    ),
  ])
}

/** Run `work` after the folder's earlier work (`before`, which `work` awaits as it sees fit); the next one waits for both. */
function queued(target: string, work: (before: Promise<unknown> | undefined) => Promise<void>): Promise<void> {
  const before = running.get(target)
  const mine = work(before)
  // One that gave up waiting must not let a third swap beside the first.
  const chain = Promise.allSettled([before, mine])
  running.set(target, chain)
  void chain.finally(() => {
    if (running.get(target) === chain) running.delete(target)
  })
  return mine
}

/** Remove a copy folder: renamed away in one step, then deleted. A link or a file there is removed, never followed. */
async function removeFolder(root: string, target: string): Promise<void> {
  written.delete(target)
  const rootStat = await lstat(root).catch(() => null)
  if (!rootStat) return
  if (rootStat.isSymbolicLink()) throw new Error(`${root} is a symbolic link`)
  const existing = await lstat(target).catch(() => null)
  if (!existing) return
  if (!existing.isDirectory()) return rm(target, { force: true })
  const old = `${target}.old-${randomBytes(4).toString('hex')}`
  await rename(target, old)
  await removeTree(old)
}

async function syncLayer(root: string, target: string, layer: MemoryLayerRef, env: Record<string, string | undefined>, fetchImpl: typeof fetch, timeoutMs: number): Promise<void> {
  if (!(MEMORY_COPY_DIRS as readonly string[]).includes(layer.dir)) throw new Error(`unknown memory folder ${JSON.stringify(layer.dir)}`)
  await mkdir(root, { recursive: true })
  if ((await lstat(root)).isSymbolicLink()) throw new Error(`${root} is a symbolic link`)
  if (await isCurrent(target, layer.version)) return
  const api = env.KORTIX_API_URL?.trim().replace(/\/+$/, '')
  const project = env.KORTIX_PROJECT_ID?.trim()
  const token = env.KORTIX_TOKEN?.trim()
  if (!api || !project || !token) throw new Error('KORTIX_API_URL, KORTIX_PROJECT_ID or KORTIX_TOKEN is unset')
  const base = api.endsWith('/v1') ? api : `${api}/v1`
  const url = `${base}/projects/${encodeURIComponent(project)}/memory/layers/${encodeURIComponent(layer.layer_id)}/export`
  const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) throw new Error(`the layer export answered ${response.status}`)
  if (Number(response.headers.get('content-length')) > MAX_EXPORT_BYTES) throw new Error('the layer export is too large')
  const text = await response.text()
  if (Buffer.byteLength(text) > MAX_EXPORT_BYTES) throw new Error('the layer export is too large')
  const data = JSON.parse(text) as LayerExport
  await removeStale(root, layer.dir)
  await replaceFolder(target, exportFiles(data, layer), String(data.version))
}

/** The folder is a real folder, its `.version` is the one this daemon wrote (when it wrote one), and its files hash to it. */
async function isCurrent(target: string, version: string): Promise<boolean> {
  const stamp = await readFile(join(target, '.version'), 'utf8').catch(() => null)
  if (stamp === null || stamp !== (written.get(target) ?? stamp) || !stamp.startsWith(`${version}\n`)) return false
  if (!(await lstat(target)).isDirectory()) return false
  return stamp === `${version}\n${await treeHash(target)}\n`
}

/** Relative path → text. A page whose folder or file name the copy does not write is skipped and logged; the rest are written. */
function exportFiles(data: LayerExport, layer: MemoryLayerRef): Map<string, string> {
  if (!data || typeof data.index !== 'string' || !Array.isArray(data.pages)) throw new Error('the layer export is malformed')
  if (data.pages.length > MAX_PAGES) throw new Error(`the layer export has ${data.pages.length} pages`)
  const files = new Map([['INDEX.md', data.index]])
  const skipped: string[] = []
  for (const page of data.pages) {
    const folder = TYPE_FOLDERS[page?.type]
    const path = `${folder}/${page?.slug}.md`
    if (!folder || !FILE_NAME_RE.test(`${page?.slug}.md`) || typeof page.markdown !== 'string' || files.has(path)) skipped.push(`${JSON.stringify(page?.type)}/${JSON.stringify(page?.slug)}`)
    else files.set(path, page.markdown)
  }
  if (skipped.length > 0) logger.warn('[memory-copy] pages with an unsafe or repeated file name are not in the copy', { dir: layer.dir, layer_id: layer.layer_id, skipped })
  return files
}

/**
 * The hash `.version` holds: every entry under `dir` but `.version`, by path
 * and kind, with each file's bytes and each link's target.
 */
async function treeHash(dir: string): Promise<string> {
  const hash = createHash('sha256')
  const walk = async (prefix: string): Promise<void> => {
    const entries = (await readdir(join(dir, prefix), { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name
      if (path === '.version') continue
      if (entry.isDirectory()) {
        hash.update(`d\0${path}\0`)
        await walk(path)
      } else if (entry.isFile()) {
        const bytes = await readFile(join(dir, path))
        hash.update(`f\0${path}\0${bytes.length}\0`).update(bytes)
      } else if (entry.isSymbolicLink()) hash.update(`l\0${path}\0${await readlink(join(dir, path))}\0`)
      else hash.update(`o\0${path}\0`)
    }
  }
  await walk('')
  return hash.digest('hex')
}

/** Folders a crashed sync left beside `<dir>`. Runs inside the folder's queue, so none is in use. */
async function removeStale(root: string, dir: string): Promise<void> {
  for (const name of await readdir(root)) {
    if (name.startsWith(`${dir}.tmp-`) || name.startsWith(`${dir}.old-`)) await removeTree(join(root, name))
  }
}

/** Write the folder whole beside `target`, read-only, then swap it in. */
async function replaceFolder(target: string, files: Map<string, string>, version: string): Promise<void> {
  const suffix = randomBytes(4).toString('hex')
  const fresh = `${target}.tmp-${suffix}`
  const old = `${target}.old-${suffix}`
  try {
    await mkdir(fresh)
    for (const [path, text] of files) {
      await mkdir(dirname(join(fresh, path)), { recursive: true })
      await writeFile(join(fresh, path), text, { mode: 0o444, flag: 'wx' })
    }
    const stamp = `${version}\n${await treeHash(fresh)}\n`
    await writeFile(join(fresh, '.version'), stamp, { mode: 0o444, flag: 'wx' })
    await setDirModes(fresh, 0o555)
    // A link or a file where the folder belongs is removed, never followed.
    const existing = await lstat(target).catch(() => null)
    if (existing && !existing.isDirectory()) await rm(target, { force: true })
    let moved = false
    if (existing?.isDirectory()) {
      await rename(target, old)
      moved = true
    }
    try {
      await rename(fresh, target)
    } catch (err) {
      if (moved) await rename(old, target)
      throw err
    }
    written.set(target, stamp)
  } finally {
    await removeTree(fresh)
    await removeTree(old)
  }
}

/** Resolves true when `promise` settles within `ms`, false when the time runs out first. */
function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise.then(() => true, () => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

/** Set `mode` on `dir` and every folder under it, deepest first. */
async function setDirModes(dir: string, mode: number): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) await setDirModes(join(dir, entry.name), mode)
  }
  await chmod(dir, mode)
}

/** Remove a read-only tree: a folder without write permission keeps its files. Never follows a link. */
async function removeTree(dir: string): Promise<void> {
  const unlock = async (path: string): Promise<void> => {
    await chmod(path, 0o755)
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.isDirectory()) await unlock(join(path, entry.name))
    }
  }
  const stat = await lstat(dir).catch(() => null)
  if (!stat) return
  if (stat.isDirectory()) await unlock(dir).catch(() => {})
  await rm(dir, { recursive: true, force: true })
}
