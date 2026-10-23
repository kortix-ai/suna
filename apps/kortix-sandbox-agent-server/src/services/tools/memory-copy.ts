/**
 * The read-only copy of a thread's memory pages (`project_channels`):
 * `/opt/kortix/memory/<dir>/`, one folder per layer (`company`, `channel`,
 * `personal`). Postgres holds the pages; this copy lets an agent read them
 * with its file tools. Agents write through the `remember` tool.
 *
 * At every turn start apps/api names the thread's layers and their versions
 * (`memory_layers` on the Kortix prompt body). A layer whose `.version` file
 * differs is fetched from the API's layer export (session token) and its
 * folder is replaced: written whole beside it, then swapped in. A fetch that
 * fails or takes over 3 s leaves the old copy, and the turn runs with it.
 */
import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
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

const TYPE_FOLDERS: Record<string, string> = {
  people: 'people',
  decisions: 'decisions',
  workstreams: 'workstreams',
  playbooks: 'playbooks',
  note: 'notes',
}
const FILE_NAME_RE = /^[a-z0-9-]+\.md$/
const TIMEOUT_MS = 3_000

export interface MemoryCopyOptions {
  /** Default `MEMORY_COPY_DIR`. */
  root?: string
  fetch?: typeof fetch
  /** Per layer; default 3 s. */
  timeoutMs?: number
}

// replica-local: one daemon per box; serializes the folder swap per layer folder.
const running = new Map<string, Promise<void>>()

/**
 * Bring each layer's folder to its version, all layers at once. Never throws:
 * a layer that fails is logged and keeps its old copy.
 */
export async function syncMemoryCopy(layers: readonly MemoryLayerRef[], env: Record<string, string | undefined>, options: MemoryCopyOptions = {}): Promise<void> {
  const root = options.root ?? MEMORY_COPY_DIR
  await Promise.all(
    layers.map((layer) => {
      const target = join(root, layer.dir)
      const next = (running.get(target) ?? Promise.resolve())
        .then(() => syncLayer(target, layer, env, options))
        .catch((err) => logger.warn('[memory-copy] layer not synced; the old copy stays', { dir: layer.dir, layer_id: layer.layer_id, error: err instanceof Error ? err.message : String(err) }))
      running.set(target, next)
      return next.finally(() => {
        if (running.get(target) === next) running.delete(target)
      })
    }),
  )
}

async function syncLayer(target: string, layer: MemoryLayerRef, env: Record<string, string | undefined>, options: MemoryCopyOptions): Promise<void> {
  if (!(MEMORY_COPY_DIRS as readonly string[]).includes(layer.dir)) throw new Error(`unknown memory folder ${JSON.stringify(layer.dir)}`)
  const current = await readFile(join(target, '.version'), 'utf8').catch(() => null)
  if (current === layer.version) return
  const api = env.KORTIX_API_URL?.trim().replace(/\/+$/, '')
  const project = env.KORTIX_PROJECT_ID?.trim()
  const token = env.KORTIX_TOKEN?.trim()
  if (!api || !project || !token) throw new Error('KORTIX_API_URL, KORTIX_PROJECT_ID or KORTIX_TOKEN is unset')
  const base = api.endsWith('/v1') ? api : `${api}/v1`
  const url = `${base}/projects/${encodeURIComponent(project)}/memory/layers/${encodeURIComponent(layer.layer_id)}/export`
  const response = await (options.fetch ?? fetch)(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`the layer export answered ${response.status}`)
  const data = (await response.json()) as LayerExport
  await replaceFolder(target, exportFiles(data), String(data.version))
}

/** Relative path → text. Throws on a page whose folder or file name is not one the copy writes. */
function exportFiles(data: LayerExport): Map<string, string> {
  if (!data || typeof data.index !== 'string' || !Array.isArray(data.pages)) throw new Error('the layer export is malformed')
  const files = new Map([['INDEX.md', data.index]])
  for (const page of data.pages) {
    const folder = TYPE_FOLDERS[page?.type]
    const name = `${page?.slug}.md`
    if (!folder || !FILE_NAME_RE.test(name) || typeof page.markdown !== 'string') {
      throw new Error(`the layer export names an unsafe file: ${JSON.stringify(page?.type)}/${JSON.stringify(page?.slug)}`)
    }
    const path = `${folder}/${name}`
    if (files.has(path)) throw new Error(`the layer export names ${path} twice`)
    files.set(path, page.markdown)
  }
  return files
}

/** Write the folder whole beside `target`, read-only, then swap it in. */
async function replaceFolder(target: string, files: Map<string, string>, version: string): Promise<void> {
  const suffix = randomBytes(4).toString('hex')
  const fresh = `${target}.tmp-${suffix}`
  const old = `${target}.old-${suffix}`
  try {
    await mkdir(fresh, { recursive: true })
    for (const [path, text] of [...files, ['.version', version] as const]) {
      await mkdir(dirname(join(fresh, path)), { recursive: true })
      await writeFile(join(fresh, path), text, { mode: 0o444, flag: 'wx' })
    }
    await setDirModes(fresh, 0o555)
    let moved = true
    await rename(target, old).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') throw err
      moved = false
    })
    try {
      await rename(fresh, target)
    } catch (err) {
      if (moved) await rename(old, target)
      throw err
    }
  } finally {
    await removeTree(fresh)
    await removeTree(old)
  }
}

/** Set `mode` on `dir` and every folder under it, deepest first. */
async function setDirModes(dir: string, mode: number): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) await setDirModes(join(dir, entry.name), mode)
  }
  await chmod(dir, mode)
}

/** Remove a read-only tree: a folder without write permission keeps its files. */
async function removeTree(dir: string): Promise<void> {
  const unlock = async (path: string): Promise<void> => {
    await chmod(path, 0o755)
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.isDirectory()) await unlock(join(path, entry.name))
    }
  }
  try {
    await unlock(dir)
  } catch {
    return // gone already
  }
  await rm(dir, { recursive: true, force: true })
}
