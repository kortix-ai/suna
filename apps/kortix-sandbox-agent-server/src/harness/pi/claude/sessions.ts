/**
 * One `claude` process per pi thread (the root, each subagent child), and the record that
 * keeps its Claude session in step with pi's context (`sync.ts`).
 *
 * A pi model step is one `run`. A step that ends at Kortix tool calls parks the Claude turn:
 * Claude Code waits for the results, pi runs the tools, and the next step hands them over
 * (`continuation`). A process stops after 5 minutes idle, and the next step resumes its saved
 * Claude session. While Claude waits for tool results the process is not idle, however long the
 * tools take: subagents, permission prompts and questions can take longer than 5 minutes.
 *
 * A step with no tools is a side call (pi's compaction summary): it runs in a process of its
 * own that saves no Claude session, with the request's system prompt instead of Claude Code's.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { Message, Tool } from '@earendil-works/pi-ai'
import { logger } from '@/lib/log/logger'
import { content as toClaude, toolOutcome, type ContentBlock } from './messages'
import { original } from './names'
import { PendingTools, type ToolOutcome } from './pending'
import { claudeConfigDir, claudeEnv, claudeLoginKey } from './sdk'
import { ensureClaudeExecutable } from './install'
import { startClaudeSession, type ClaudeInit, type ClaudeSession } from './session'
import { catchUp, checkpoints, collectResults, decide, type SessionRecord } from './sync'
import { createToolServer } from './server'

export const IDLE_MS = 5 * 60_000
const READY_MS = 30_000

export type Effort = NonNullable<Options['effort']>

export interface ClaudeRequest {
  /** The pi thread; absent for a side call. */
  readonly key?: string
  readonly model: string
  readonly effort?: Effort
  /** Kortix's system prompt; Claude Code's own leads it on a thread. */
  readonly system: string
  readonly messages: readonly Message[]
  readonly tools: readonly Tool[]
  readonly emit: (message: SDKMessage) => void
  /** The reply as pi will store it, read when the step ends: the record's last group. */
  readonly reply?: () => Message
  readonly signal?: AbortSignal
}

export type ClaudeOutcome = { kind: 'tools' } | { kind: 'result'; result: Extract<SDKMessage, { type: 'result' }> } | { kind: 'aborted' }

interface LiveProcess {
  readonly session: ClaudeSession
  readonly pending: PendingTools
  model: string
  effort?: Effort
  /** What needs a new process to change. Model and effort change on the running one. */
  readonly launch: string
  /** Tool calls the parked turn waits for. */
  waiting?: string[]
}

interface Entry {
  lock: Promise<unknown>
  process?: LiveProcess
  record?: SessionRecord
  idle?: ReturnType<typeof setTimeout>
  active: boolean
}

export interface ClaudeSessionsOptions {
  /** Where Claude's state and the records live (the runtime state dir). */
  readonly stateDir: string
  readonly cwd: string
  readonly env?: NodeJS.ProcessEnv
  /** A started process reports its version, login and models. */
  readonly onReady?: (init: ClaudeInit) => void
}

const RUNTIME_NOTE = '<runtime_info>You are running in a Kortix session through Claude Code. Your tools are the Kortix tools listed to you. Mention this only when asked.</runtime_info>'

function systemPrompt(request: ClaudeRequest): NonNullable<Options['systemPrompt']> {
  if (!request.key) return request.system || 'You are a text generation helper. Return only the requested output.'
  // `snapshot: false`: an agent or prompt change applies when a process resumes the same Claude session.
  return { type: 'preset', preset: 'claude_code', append: [RUNTIME_NOTE, request.system].filter(Boolean).join('\n\n'), snapshot: false } as never
}

const launchKey = (request: ClaudeRequest) =>
  JSON.stringify([claudeLoginKey(), request.system, request.tools.map((tool) => [tool.name, tool.description, tool.parameters])])

export class ClaudeSessions {
  private readonly entries = new Map<string, Entry>()
  private readonly recordDir: string

  constructor(private readonly opts: ClaudeSessionsOptions) {
    this.recordDir = join(opts.stateDir, 'claude-records')
  }

  // ── records ──────────────────────────────────────────────────────────────

  private recordPath(key: string): string {
    return join(this.recordDir, `${key.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`)
  }

  private readRecord(key: string): SessionRecord | undefined {
    try {
      const parsed = JSON.parse(readFileSync(this.recordPath(key), 'utf8')) as SessionRecord
      return typeof parsed?.claudeSessionID === 'string' ? parsed : undefined
    } catch {
      return undefined
    }
  }

  private writeRecord(key: string, record: SessionRecord | undefined): void {
    mkdirSync(this.recordDir, { recursive: true, mode: 0o700 })
    const file = this.recordPath(key)
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(record ?? null), { mode: 0o600 })
    renameSync(tmp, file)
  }

  /** Whether Claude Code still has the session's transcript (a new box has none). */
  private sessionExists(id: string): boolean {
    const projects = join(claudeConfigDir(this.opts.stateDir), 'projects')
    if (!existsSync(projects)) return false
    try {
      return readdirSync(projects).some((dir) => existsSync(join(projects, dir, `${id}.jsonl`)))
    } catch {
      return false
    }
  }

  // ── processes ────────────────────────────────────────────────────────────

  private async stop(entry: Entry): Promise<void> {
    const live = entry.process
    if (!live) return
    entry.process = undefined
    try {
      await live.session.stop()
    } catch (err) {
      logger.warn('[claude] process stop failed', { err: String(err) })
    } finally {
      live.pending.clear()
    }
  }

  private async interrupt(entry: Entry): Promise<void> {
    const live = entry.process
    if (!live) return
    await live.session.interrupt().catch((err) => logger.warn('[claude] interrupt failed', { err: String(err) }))
    live.pending.clear()
    live.waiting = undefined
  }

  private armIdle(entry: Entry): void {
    if (entry.idle) clearTimeout(entry.idle)
    entry.idle = setTimeout(() => {
      entry.idle = undefined
      void this.locked(entry, () => this.stop(entry))
    }, IDLE_MS)
    entry.idle.unref?.()
  }

  private locked<T>(entry: Entry, run: () => Promise<T>): Promise<T> {
    const next = entry.lock.then(run, run)
    entry.lock = next.catch(() => {})
    return next
  }

  private async open(entry: Entry, request: ClaudeRequest): Promise<LiveProcess> {
    const starting = !entry.process
    if (!entry.process) {
      // The image's Claude Code, else the pinned binary installed into the state dir (install.ts).
      const executable = await ensureClaudeExecutable(this.opts.stateDir, this.opts.env)
      const pending = new PendingTools()
      const options: Options = {
        pathToClaudeCodeExecutable: executable,
        cwd: this.opts.cwd,
        env: claudeEnv(this.opts.stateDir, this.opts.env),
        model: request.model,
        effort: request.effort,
        systemPrompt: systemPrompt(request),
        // Claude Code reads none of the box's Claude settings, hooks, skills or CLAUDE.md: Kortix supplies its own.
        settingSources: [],
        settings: { disableAllHooks: true } as never,
        strictMcpConfig: true,
        skills: [],
        tools: [],
        permissionMode: 'dontAsk',
        allowedTools: ['mcp__kortix__*'],
        // Kortix already expanded commands and attachments; Claude Code adds nothing to the prompt.
        verbatimPrompts: true,
        // Without summaries there is no reasoning text to show.
        thinking: { type: 'adaptive', display: 'summarized' } as never,
        includePartialMessages: true,
        persistSession: request.key !== undefined,
        hooks: {
          PreToolUse: [{ hooks: [async (input) => (input.hook_event_name === 'PreToolUse' && pending.before(input.tool_use_id, input.tool_name), {})] }],
          PostToolUse: [
            {
              hooks: [
                async (input) => {
                  if (input.hook_event_name !== 'PostToolUse') return {}
                  const replacement = pending.after(input.tool_use_id)
                  return replacement ? { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedMCPToolOutput: replacement } } : {}
                },
              ],
            },
          ],
        },
        mcpServers: request.tools.length > 0 ? { kortix: await createToolServer(request.tools, pending) } : {},
        stderr: (line: string) => logger.debug('[claude] stderr', { line: line.slice(0, 500) }),
      }
      if (entry.record?.claudeSessionID) options.resume = entry.record.claudeSessionID
      else options.sessionId = crypto.randomUUID()
      const session = await startClaudeSession(options)
      entry.process = { session, pending, model: request.model, effort: request.effort, launch: launchKey(request) }
    }
    const live = entry.process
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const init = await Promise.race([
        live.session.ready,
        new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`Claude Code did not start within ${READY_MS / 1000} seconds`)), READY_MS))),
      ])
      if (starting) this.opts.onReady?.(init)
    } catch (err) {
      await this.stop(entry)
      throw err
    } finally {
      if (timer) clearTimeout(timer)
    }
    if (live.model !== request.model) {
      await live.session.setModel(request.model)
      live.model = request.model
    }
    if (live.effort !== request.effort) {
      await live.session.setEffort(request.effort)
      live.effort = request.effort
    }
    return live
  }

  /** Bring the process and the record in step with pi's context; returns where Claude's input starts. */
  private async prepare(entry: Entry, request: ClaudeRequest): Promise<{ start: number; continuation?: { end: number; results: Array<{ id: string; result: ToolOutcome }> } }> {
    if (entry.process && (entry.process.session.ended || entry.process.launch !== launchKey(request))) await this.stop(entry)
    if (!request.key) return { start: 0 }
    entry.record ??= this.readRecord(request.key)
    const decision = decide(request.messages, entry.record)
    let start = decision.start
    if (decision.kind === 'fresh' || decision.kind === 'changed') {
      await this.stop(entry)
      entry.record = undefined
      start = 0
    } else if (!entry.process && entry.record && !this.sessionExists(entry.record.claudeSessionID)) {
      // The box lost Claude's transcript (a new box): Claude starts over with the whole history.
      entry.record = undefined
      start = 0
    }
    const live = entry.process
    if (!live || !live.session.running || !live.waiting) return { start }
    const collected = collectResults(request.messages, start)
    const results: Array<{ id: string; result: ToolOutcome }> = []
    for (const id of live.waiting) {
      const result = collected.results.get(id)
      if (!result) {
        // pi moved on without these results (a stop mid-tool): rebuild from pi's context.
        await this.stop(entry)
        entry.record = undefined
        return { start: 0 }
      }
      results.push({ id, result: toolOutcome(result) })
    }
    return { start, continuation: { end: collected.end, results } }
  }

  /** One pi model step. */
  run(request: ClaudeRequest): Promise<ClaudeOutcome> {
    const key = request.key
    const entry: Entry = (key && this.entries.get(key)) || { lock: Promise.resolve(), active: false }
    if (key) this.entries.set(key, entry)
    return this.locked(entry, async () => {
      if (entry.idle) clearTimeout(entry.idle)
      entry.idle = undefined
      entry.active = true
      try {
        const prepared = await this.prepare(entry, request)
        return await this.step(entry, request, prepared.start, prepared.continuation)
      } finally {
        entry.active = false
        await this.release(entry, request)
      }
    })
  }

  private async step(
    entry: Entry,
    request: ClaudeRequest,
    start: number,
    continuation?: { end: number; results: Array<{ id: string; result: ToolOutcome }> },
  ): Promise<ClaudeOutcome> {
    const input: ContentBlock[] = request.key || entry.record ? catchUp(request.messages, continuation?.end ?? start) : toClaude(request.messages)
    const live = await this.open(entry, request)
    const addsUser = !continuation || input.length > 0
    const userID = addsUser ? crypto.randomUUID() : undefined
    const toolMessages = new Map<string, string>()
    const seen = new Set<string>()
    const waiting: string[] = []
    let replyID: string | undefined
    const emit = (message: SDKMessage) => {
      if (message.type === 'system' && message.subtype === 'init' && request.tools.length > 0) {
        const connected = message.mcp_servers.some((server) => server.name === 'kortix' && server.status === 'connected')
        if (!connected) throw new Error('The Kortix tool server did not connect to Claude Code')
      }
      if (message.type === 'assistant' && message.parent_tool_use_id === null && !message.error && !seen.has(message.uuid)) {
        seen.add(message.uuid)
        replyID = message.uuid
        for (const part of message.message.content) {
          if (part.type !== 'tool_use' || !original(part.name, request.tools)) continue
          live.pending.expect(part.id, part.name)
          waiting.push(part.id)
        }
      }
      if (message.type === 'user' && message.uuid && Array.isArray(message.message.content)) {
        for (const part of message.message.content as Array<{ type: string; tool_use_id?: string }>) {
          if (part.type === 'tool_result' && part.tool_use_id) toolMessages.set(part.tool_use_id, message.uuid)
        }
      }
      request.emit(message)
    }

    let completed = false
    let interrupted = false
    let parked = false
    let outcome: ClaudeOutcome = { kind: 'aborted' }
    try {
      if (!continuation) live.session.begin(input, userID)
      else {
        if (userID) live.session.addUser(input, userID)
        for (const item of continuation.results) live.pending.resolve(item.id, item.result)
      }
      const read = live.session.readStep(emit, request.tools)
      const aborted = new Promise<'aborted'>((resolve) => {
        if (request.signal?.aborted) resolve('aborted')
        request.signal?.addEventListener('abort', () => resolve('aborted'), { once: true })
      })
      const result = await Promise.race([read, aborted])
      if (result === 'aborted') {
        interrupted = true
        read.catch(() => {})
      } else {
        completed = true
        parked = result === 'tools'
        live.waiting = parked ? waiting : undefined
        outcome = result === 'tools' ? { kind: 'tools' } : { kind: 'result', result }
      }
    } finally {
      // A tool boundary ends only pi's step: the Claude turn waits for the results. Anything else ends the Claude turn.
      if (!parked) await this.interrupt(entry)
      if (request.key && live.session.persisted) {
        const history = completed || interrupted
          ? checkpoints({ messages: request.messages, previous: entry.record, userID, toolMessages, ...(completed && request.reply ? { reply: request.reply(), replyID } : {}) })
          : undefined
        entry.record = { claudeSessionID: live.session.id, history, interrupted: interrupted && !completed }
        this.writeRecord(request.key, entry.record)
      }
    }
    return outcome
  }

  private async release(entry: Entry, request: ClaudeRequest): Promise<void> {
    if (!request.key) {
      await this.stop(entry)
      return
    }
    // A turn waiting for tool results is busy; `settle` starts its idle timer once pi's turn ended.
    if (entry.process?.waiting) return
    this.armIdle(entry)
  }

  /** pi's turn on `key` ended. A Claude turn still waiting for tool results will not get them from this turn. */
  settle(key: string): void {
    const entry = this.entries.get(key)
    if (!entry?.process?.waiting || entry.active) return
    this.armIdle(entry)
  }

  /** Stop every process (daemon stop, login change). */
  async stopAll(): Promise<void> {
    await Promise.all([...this.entries.values()].map((entry) => {
      if (entry.idle) clearTimeout(entry.idle)
      return this.locked(entry, () => this.stop(entry))
    }))
  }
}
