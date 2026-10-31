/**
 * What a workflow keeps between calls (`workflow.ts`):
 *
 *  - Run records, for `resume_run_id`: one JSON file per run under
 *    `<state>/runs/<runId>.json` (`<state>` is `$KORTIX_RUNTIME_STATE_DIR/workflows`).
 *    Each agent's entry is written when it settles: the key of its prompt and
 *    options, its status, its result and its session. A relaunch replays the
 *    record ({@link Replay}).
 *  - The session's "don't ask again" answer: `<state>/consent.json`. One box
 *    is one session, so the file is the session's.
 *  - Saved workflows: `.kortix/workflows/<name>.js` in the project repository,
 *    read only. A box with a project checkout reads the working tree. A box
 *    without one (My Kortix) reads the default branch through the Kortix API
 *    with the session token (`GET /v1/projects/:id/files/content?path=…`).
 *    Nothing here writes one: an agent with the project files commits it
 *    through a change request when the person asks.
 */
import { createHash } from 'node:crypto'
import type { WorkflowRunMetadata } from '@kortix/api-contract/kortix-tool-card'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** The repository folder of saved workflows. */
export const SAVED_WORKFLOWS_DIR = '.kortix/workflows'
/** A saved workflow's name: its file is `<name>.js`. */
export const SAVED_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/
const RUN_ID = /^[A-Za-z0-9_-]{8,64}$/

/**
 * `stopped`: the agent alone was stopped (its session stopped from outside),
 * which counts as a failure. `interrupted`: it was still running when the run
 * ended (the turn stopped, the box restarted); it starts over on a relaunch,
 * and the agents after it may still reuse their results.
 */
export type RecordedStatus = 'done' | 'failed' | 'stopped' | 'interrupted'

export interface RecordedAgent {
  /** sha256 of the prompt and the options that change the answer (agent, model, schema). */
  key: string
  label: string
  status: RecordedStatus
  /** The answer: a string, or the parsed JSON of a structured agent. */
  result?: unknown
  sessionId?: string
}

export interface RunRecord {
  runId: string
  title: string
  name?: string
  script: string
  args?: unknown
  maxAgents: number
  startedAt: number
  resumedFrom?: string
  /** A background run: its runner session holds the agents' records. */
  background?: { sessionId: string }
  agents: RecordedAgent[]
  /** The run's card document as last written: what `GET /kortix/runtime/workflows` lists. */
  doc?: WorkflowRunMetadata
}

/** The key that decides whether a relaunched agent may reuse a saved result. */
export function agentKey(input: { prompt: string; agent?: string; model?: string; schema?: unknown }): string {
  return createHash('sha256')
    .update(JSON.stringify([input.prompt, input.agent ?? null, input.model ?? null, input.schema ?? null]))
    .digest('hex')
}

/** One file per run, written whole after every change (write, then rename). */
export class RunStore {
  constructor(private readonly dir: string) {}

  private path(runId: string): string {
    if (!RUN_ID.test(runId)) throw new Error(`"${runId}" is not a workflow run id.`)
    return join(this.dir, 'runs', `${runId}.json`)
  }

  load(runId: string): RunRecord | null {
    const path = this.path(runId)
    if (!existsSync(path)) return null
    try {
      const record = JSON.parse(readFileSync(path, 'utf8')) as RunRecord
      return record && Array.isArray(record.agents) && typeof record.script === 'string' ? record : null
    } catch {
      return null
    }
  }

  save(record: RunRecord): void {
    const path = this.path(record.runId)
    mkdirSync(join(this.dir, 'runs'), { recursive: true, mode: 0o700 })
    const temp = `${path}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify(record), { mode: 0o600 })
    renameSync(temp, path)
  }

  /** Every saved run, newest first. A file that does not parse is skipped. */
  list(): RunRecord[] {
    let files: string[]
    try {
      files = readdirSync(join(this.dir, 'runs')).filter((file) => file.endsWith('.json'))
    } catch {
      return []
    }
    const records: RunRecord[] = []
    for (const file of files) {
      const record = RUN_ID.test(file.slice(0, -5)) ? this.load(file.slice(0, -5)) : null
      if (record) records.push(record)
    }
    return records.sort((a, b) => b.startedAt - a.startedAt)
  }

  /** The person chose "don't ask again" in this session. */
  consented(): boolean {
    try {
      return (JSON.parse(readFileSync(join(this.dir, 'consent.json'), 'utf8')) as { dontAsk?: unknown }).dontAsk === true
    } catch {
      return false
    }
  }

  consent(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    writeFileSync(join(this.dir, 'consent.json'), JSON.stringify({ dontAsk: true, at: new Date().toISOString() }), { mode: 0o600 })
  }
}

/**
 * The replay of an earlier run, as Claude Code relaunches one. Each new
 * `agent()` call takes the earlier run's first unused entry with the same key
 * (the same prompt and options). While the replay has not diverged, a
 * completed entry returns its saved result, and an interrupted one runs
 * again alone. The first call with no such entry, or whose entry started at or
 * after the earlier run's first failed or stopped agent, diverges the replay:
 * it and every later call run again. Matching by key, not by start position,
 * keeps an unedited `pipeline()` whose stages finished in another order cached.
 */
export class Replay {
  private readonly used = new Set<number>()
  private readonly firstBreak: number
  private diverged = false

  constructor(private readonly previous: RecordedAgent[]) {
    const broken = previous.findIndex((entry) => entry.status === 'failed' || entry.status === 'stopped')
    this.firstBreak = broken < 0 ? previous.length : broken
  }

  /** The saved entry this call reuses, or null: it runs. */
  take(key: string): RecordedAgent | null {
    if (this.diverged) return null
    const index = this.previous.findIndex((entry, i) => !this.used.has(i) && entry.key === key)
    if (index < 0 || index >= this.firstBreak) {
      this.diverged = true
      return null
    }
    this.used.add(index)
    const entry = this.previous[index]!
    return entry.status === 'done' ? entry : null
  }
}

// ── saved workflows ───────────────────────────────────────────────────────

export interface SavedWorkflows {
  /** Where the files live, for the tool text. */
  where: string
  /** The script, or null when no such workflow exists. */
  read(name: string): Promise<string | null>
}

export function checkSavedName(name: string): string {
  const trimmed = name.trim()
  if (!SAVED_NAME.test(trimmed)) throw new Error(`"${name}" is not a workflow name: use 1-64 lower-case letters, digits, "-" or "_", starting with a letter or digit.`)
  return trimmed
}

/** Saved workflows in a project checkout's working tree. */
export function checkoutWorkflows(root: string): SavedWorkflows {
  const dir = join(root, SAVED_WORKFLOWS_DIR)
  return {
    where: `${SAVED_WORKFLOWS_DIR}/ in this session's project checkout`,
    read: async (name) => {
      const path = join(dir, `${checkSavedName(name)}.js`)
      return existsSync(path) ? readFileSync(path, 'utf8') : null
    },
  }
}

/** The names in a checkout, for the tool description; never throws. */
export function listCheckout(root: string): string[] {
  try {
    return readdirSync(join(root, SAVED_WORKFLOWS_DIR))
      .filter((file) => file.endsWith('.js') && SAVED_NAME.test(file.slice(0, -3)))
      .map((file) => file.slice(0, -3))
      .sort()
  } catch {
    return []
  }
}

export interface ProjectApi {
  apiUrl: string
  projectId: string
  token: string
}

/** Saved workflows on the project's default branch, read through the Kortix API. */
export function apiWorkflows(api: ProjectApi): SavedWorkflows {
  const origin = api.apiUrl.trim().replace(/\/+$/, '').replace(/\/v1$/, '')
  const base = `${origin}/v1/projects/${encodeURIComponent(api.projectId)}/files`
  const headers = { authorization: `Bearer ${api.token}` }
  return {
    where: `${SAVED_WORKFLOWS_DIR}/ on the project's default branch`,
    read: async (name) => {
      const path = `${SAVED_WORKFLOWS_DIR}/${checkSavedName(name)}.js`
      const res = await fetch(`${base}/content?path=${encodeURIComponent(path)}`, { headers })
      if (res.status === 404) return null
      if (res.status !== 200) throw new Error(`${path} could not be read: the API answered ${res.status}`)
      const body = (await res.json().catch(() => null)) as { content?: unknown } | null
      return typeof body?.content === 'string' ? body.content : null
    },
  }
}
