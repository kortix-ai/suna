/**
 * The tool host: the Kortix tools and the project's tools (kortix.yaml
 * `tools`), loaded when a runtime starts and run the same way on every
 * harness. pi runs them in this process. OpenCode reaches them through
 * `POST /kortix/tools/:name`, called by the bridge plugin its adapter writes.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { AGENT_ENV_FILE } from '@kortix/api-contract/sandbox-layout'
import { resolveKortixRuntimeStateDirectory } from '@/lib/config/runtime-state-dir'
import { logger } from '@/lib/log/logger'
import { memory } from './memory'
import { show } from './show'
import { asTool, toolText, type KortixTool, type ToolContext } from './tool'
import { imageSearch, scrapeWebpage, webSearch } from './web'

export type { KortixTool, ToolContext } from './tool'

/** The tools every session has. A project tool of the same name replaces one. */
export const KORTIX_TOOLS: Readonly<Record<string, KortixTool>> = {
  web_search: webSearch,
  image_search: imageSearch,
  scrape_webpage: scrapeWebpage,
  memory,
  show,
}

export interface HostedTool extends KortixTool {
  name: string
  /** `kortix` for a Kortix tool, else the project module's repo-relative path. */
  source: string
}

export interface ToolLoad {
  tools: HostedTool[]
  /** Declared project tools that did not load, and why. */
  failed: Array<{ name: string; error: string }>
}

let loaded = new Map<string, HostedTool>()

/**
 * Load the Kortix tools and the declared project tools: tool name → module
 * path, relative to `root` (the checkout the runtime reads its config from).
 * A module is imported again when its file changed since the last load. A
 * module that fails to load is reported and skipped; the rest still load.
 */
export async function loadTools(root: string | null, declared: Record<string, string> | undefined): Promise<ToolLoad> {
  const tools = new Map<string, HostedTool>(Object.entries(KORTIX_TOOLS).map(([name, tool]) => [name, { ...tool, name, source: 'kortix' }]))
  const failed: ToolLoad['failed'] = []
  for (const [name, path] of Object.entries(declared ?? {})) {
    const tool = await importTool(root, path)
    if (typeof tool === 'string') failed.push({ name, error: tool })
    else tools.set(name, { ...tool, name, source: path })
  }
  if (failed.length > 0) logger.warn('[tools] project tools that did not load', { failed })
  loaded = tools
  return { tools: [...tools.values()], failed }
}

async function importTool(root: string | null, path: string): Promise<KortixTool | string> {
  if (!root) return 'this session has no project checkout to load it from'
  const file = resolve(root, path)
  if (!file.startsWith(`${root}${sep}`)) return `${path} leaves the project checkout`
  let mtime: number
  try {
    mtime = statSync(file).mtimeMs
  } catch {
    return `${path} does not exist`
  }
  try {
    const tool = asTool((await import(`${file}?v=${mtime}`)).default)
    return typeof tool === 'string' ? `${path}: ${tool}` : tool
  } catch (err) {
    return `${path}: ${err instanceof Error ? err.message : String(err)}`
  }
}

/**
 * The environment a tool reads (`ToolContext.env`): this process's env with
 * the live project secrets over it. A running box receives secrets through
 * the agent env file (harness/shared/agent-env-file.ts: `export NAME='…'`,
 * `unset NAME`), rewritten on every push; the process env holds only what the
 * box booted with.
 */
export function sessionEnv(file: string = AGENT_ENV_FILE): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env }
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return env
  }
  for (const [, name] of text.matchAll(/^unset ([A-Z_][A-Z0-9_]*)$/gm)) delete env[name!]
  for (const [, name, value] of text.matchAll(/^export ([A-Z_][A-Z0-9_]*)='((?:[^']|'\\'')*)'$/gm)) {
    env[name!] = value!.replaceAll(`'\\''`, `'`)
  }
  return env
}

/** A tool of the last load. */
export function hostedTool(name: string): HostedTool | undefined {
  return loaded.get(name)
}

/** Run a tool: its text, bounded. A thrown error is the tool's error. */
export async function runTool(tool: KortixTool & { name: string }, args: Record<string, unknown> | undefined, context: ToolContext): Promise<string> {
  return bounded(tool.name, toolText(await tool.execute(args ?? {}, context)))
}

/** OpenCode cuts a tool output past 50 KB or 2000 lines; stay under both, with room for the note. */
const MAX_BYTES = 49 * 1024
const MAX_LINES = 1990

/**
 * A long output is saved whole to a file outside the project, and the model
 * reads its head, its size and the file path. Never rely on a harness to cut
 * an output (learning 2026-09-28: bound every agent tool output).
 */
function bounded(name: string, text: string): string {
  const bytes = Buffer.byteLength(text)
  const lines = text.split('\n')
  if (bytes <= MAX_BYTES && lines.length <= MAX_LINES) return text
  const dir = join(tmpdir(), 'kortix-tool-output')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${name}-${Date.now()}-${randomUUID().slice(0, 8)}.txt`)
  writeFileSync(file, text)
  const head = Buffer.from(lines.slice(0, MAX_LINES).join('\n')).subarray(0, MAX_BYTES).toString('utf8')
  return `${head}\n\n[Output truncated: ${bytes} bytes, ${lines.length} lines. The whole output is in ${file}; read it in parts or search it.]`
}

/**
 * The credential an out-of-process harness presents to `POST /kortix/tools/:name`.
 * Created once per box and kept in the runtime state dir, so a daemon restart
 * that keeps the harness process keeps its key valid. A box whose state dir
 * cannot be written keeps a key for the life of this process.
 */
let processKey: string | null = null

export function toolBridgeKey(env: Record<string, string | undefined> = process.env): string {
  const file = join(resolveKortixRuntimeStateDirectory(env), 'tool-bridge.key')
  const read = () => {
    try {
      return readFileSync(file, 'utf8').trim()
    } catch {
      return ''
    }
  }
  const existing = read()
  if (existing) return existing
  const key = randomBytes(32).toString('hex')
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    // `wx`: a concurrent first call that wrote its key first wins.
    writeFileSync(file, key, { mode: 0o600, flag: 'wx' })
    return key
  } catch {
    return read() || (processKey ??= key)
  }
}
