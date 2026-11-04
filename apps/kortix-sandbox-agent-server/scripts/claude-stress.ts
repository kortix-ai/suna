/**
 * Stress the Claude Code harness (src/harness/pi/claude) against the real, pinned `claude`
 * binary and a local mock of the Anthropic Messages API. No credential, no model cost.
 *
 *   bun scripts/claude-stress.ts [scenario...]
 *
 * Scenarios: memory, kill-streaming, kill-parked, abort, idle-resume, parallel (default: all).
 * Each prints PASS/FAIL with the numbers it judged; the exit code is the failure count.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { Message, Tool } from '@earendil-works/pi-ai'
import { ensureClaudeExecutable } from '../src/harness/pi/claude/install'
import { original } from '../src/harness/pi/claude/names'
import { ClaudeSessions, type ClaudeOutcome } from '../src/harness/pi/claude/sessions'
import { startLlmProxy, stopLlmProxy } from '../src/services/llm-proxy/llm-proxy'
import { claudeModelFor, claudeSessions, createClaudeProvider } from '../src/harness/pi/claude/provider'

// ── mock Anthropic API ─────────────────────────────────────────────────────

const mock = {
  /** Delay between streamed text deltas, ms. */
  delayMs: 0,
  deltas: 4,
  requests: 0,
  maxRequestBytes: 0,
}

function sse(events: Array<Record<string, unknown>>, delayMs: number): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream({
    async start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`))
        if (delayMs && event.type === 'content_block_delta') await Bun.sleep(delayMs)
      }
      controller.close()
    },
  })
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
}

function reply(body: { model?: string; tools?: Array<{ name: string }>; messages?: Array<{ role: string; content: unknown }> }): Response {
  const last = body.messages?.at(-1)
  const parts = Array.isArray(last?.content) ? (last!.content as Array<{ type: string; text?: string }>) : [{ type: 'text', text: String(last?.content ?? '') }]
  const answered = parts.some((part) => part.type === 'tool_result')
  // Claude Code sends the user's text, then its own context blocks: look at every message.
  const text = JSON.stringify(body.messages ?? [])
  const tool = body.tools?.find((candidate) => candidate.name.startsWith('mcp__kortix__'))
  // One tool call per turn: none once a result (`pong`) is in the conversation after the ask.
  const wantsTool = !answered && tool && /\bTOOL\b/.test(text.slice(text.lastIndexOf('TOOL') === -1 ? 0 : text.lastIndexOf('TOOL'))) && !text.slice(text.lastIndexOf('TOOL')).includes('pong')
  const id = `msg_${crypto.randomUUID().replace(/-/g, '')}`
  const events: Array<Record<string, unknown>> = [
    { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: body.model ?? 'claude-opus-4', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } },
  ]
  if (wantsTool) {
    events.push(
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `toolu_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`, name: tool!.name, input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"text":"ping"}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 } },
    )
  } else {
    events.push({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    for (let i = 0; i < mock.deltas; i++) events.push({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `chunk${i} ` } })
    events.push({ type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } })
  }
  events.push({ type: 'message_stop' })
  return sse(events, mock.delayMs)
}

const server = Bun.serve({
  port: 0,
  // STRESS_TLS=<dir with cert.pem, key.pem>: the upstream speaks TLS, like the real gateway.
  ...(process.env.STRESS_TLS ? { tls: { cert: Bun.file(`${process.env.STRESS_TLS}/cert.pem`), key: Bun.file(`${process.env.STRESS_TLS}/key.pem`) } } : {}),
  async fetch(request) {
    const url = new URL(request.url)
    if (request.method === 'POST' && url.pathname.endsWith('/v1/messages')) {
      const raw = await request.text()
      mock.requests++
      mock.maxRequestBytes = Math.max(mock.maxRequestBytes, raw.length)
      const parsed = JSON.parse(raw)
      if (process.env.STRESS_DEBUG) {
        const last = parsed.messages?.at(-1)
        console.error('[mock]', url.pathname + url.search, `${(raw.length / 1024).toFixed(0)}KB`, 'msgs', parsed.messages?.length, 'tools', (parsed.tools ?? []).map((t: { name: string }) => t.name).join(','), 'last', JSON.stringify(last?.content).slice(0, 300))
      }
      return reply(parsed)
    }
    if (url.pathname.endsWith('/v1/messages/count_tokens')) return Response.json({ input_tokens: 10 })
    return Response.json({}, { status: 404 })
  },
})

// ── driver ─────────────────────────────────────────────────────────────────

const stateDir = mkdtempSync(join(tmpdir(), 'claude-stress-'))
const cwd = mkdtempSync(join(tmpdir(), 'claude-stress-cwd-'))
const env: NodeJS.ProcessEnv = {
  ...process.env,
  KORTIX_LLM_PROXY_URL: '',
  KORTIX_LLM_BASE_URL: `http://127.0.0.1:${server.port}`,
  KORTIX_TOKEN: 'stress-test-token',
  HOME: cwd,
}
delete env.KORTIX_CLAUDE_PATH
// STRESS_PROXY=1: Claude Code's calls go through the daemon's localhost LLM proxy, as on a box.
if (process.env.STRESS_PROXY) env.KORTIX_LLM_PROXY_URL = startLlmProxy(0, `${process.env.STRESS_TLS ? 'https' : 'http'}://127.0.0.1:${server.port}`, 'stress-test-token') ?? ''
// The pinned binary, as on a box: no other `claude` on PATH.
env.PATH = (env.PATH ?? '').split(':').filter((dir) => !Bun.spawnSync(['test', '-x', `${dir}/claude`]).success).join(':')

const tools: Tool[] = [{ name: 'echo', description: 'Echo text back.', parameters: { type: 'object', properties: { text: { type: 'string' } } } as never }]
/** A real PNG of noise (incompressible): `side`² RGB pixels, as base64. 512 → ~1 MB, a large screenshot. */
function noisePng(side: number): string {
  const crc = (buf: Buffer) => {
    let c = ~0
    for (const byte of buf) {
      c ^= byte
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
    }
    return ~c >>> 0
  }
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(data.length, 0)
    head.write(type, 4, 'ascii')
    const tail = Buffer.alloc(4)
    tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), data])), 0)
    return Buffer.concat([head, data, tail])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(side, 0)
  ihdr.writeUInt32BE(side, 4)
  ihdr.set([8, 2, 0, 0, 0], 8)
  const raw = Buffer.alloc(side * (side * 3 + 1))
  for (let y = 0; y < side; y++) {
    const row = y * (side * 3 + 1)
    raw[row] = 0
    crypto.getRandomValues(raw.subarray(row + 1, row + 1 + side * 3))
  }
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
  return png.toString('base64')
}
const IMAGE = noisePng(Number(process.env.STRESS_IMAGE_SIDE) || 512)

let now = Date.now()
const user = (text: string, images = 0): Message => ({
  role: 'user',
  content: [{ type: 'text', text }, ...Array.from({ length: images }, () => ({ type: 'image' as const, data: IMAGE, mimeType: 'image/png' }))],
  timestamp: now++,
})

/** One pi thread: its context, stepped like pi steps a model. */
class Thread {
  readonly messages: Message[] = []
  constructor(readonly sessions: ClaudeSessions, readonly key: string) {}

  async step(signal?: AbortSignal): Promise<{ outcome: ClaudeOutcome; calls: Array<{ id: string; name: string }>; text: string }> {
    if (process.env.STRESS_PROVIDER) return this.providerStep(signal)
    const calls: Array<{ id: string; name: string }> = []
    let text = ''
    const outcome = await this.sessions.run({
      key: this.key,
      model: 'opus',
      system: 'stress',
      messages: this.messages,
      tools,
      signal,
      emit: (message: SDKMessage) => {
        if (message.type !== 'assistant' || message.parent_tool_use_id !== null) return
        for (const part of message.message.content) {
          if (part.type === 'text') text += part.text
          if (part.type === 'tool_use') {
            const name = original(part.name, tools)
            if (name) calls.push({ id: part.id, name })
          }
        }
      },
      reply: () => this.reply(text, calls),
    })
    return { outcome, calls, text }
  }

  /** The step as pi takes it: the real provider, every stream event consumed like pi's agent loop. */
  private async providerStep(signal?: AbortSignal): Promise<{ outcome: ClaudeOutcome; calls: Array<{ id: string; name: string }>; text: string }> {
    const provider = createClaudeProvider({ stateDir, cwd, env })
    const context = { messages: [{ role: 'system', content: 'stress', toolsAdded: tools, timestamp: 0 }, ...this.messages] } as never
    const stream = (provider as unknown as { stream: (...args: unknown[]) => unknown }).stream(claudeModelFor('opus'), context, { sessionId: this.key, signal } as never)
    let events = 0
    for await (const _ of stream as AsyncIterable<unknown>) events++
    const message = (await (stream as { result(): Promise<Message> }).result()) as Message & { stopReason?: string; errorMessage?: string }
    const content = message.role === 'assistant' ? message.content : []
    const calls = content.filter((part) => part.type === 'toolCall').map((part) => ({ id: (part as { id: string }).id, name: (part as { name: string }).name }))
    const text = content.filter((part) => part.type === 'text').map((part) => (part as { text: string }).text).join('')
    if (message.stopReason === 'error' || message.stopReason === 'aborted') {
      if (message.stopReason === 'aborted') return { outcome: { kind: 'aborted' }, calls, text }
      throw new Error(message.errorMessage ?? 'error')
    }
    return { outcome: calls.length ? { kind: 'tools' } : ({ kind: 'result' } as ClaudeOutcome), calls, text }
  }

  private reply(text: string, calls: Array<{ id: string; name: string }>): Message {
    return {
      role: 'assistant',
      content: [...(text ? [{ type: 'text' as const, text }] : []), ...calls.map((call) => ({ type: 'toolCall' as const, id: call.id, name: call.name, arguments: { text: 'ping' } }))],
      api: 'claude-agent',
      provider: 'claude-agent',
      model: 'opus',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: calls.length ? 'toolUse' : 'stop',
      timestamp: now++,
    } as Message
  }

  /** A whole pi turn: steps until a reply without tool calls, running each tool. */
  async turn(input: Message, signal?: AbortSignal): Promise<ClaudeOutcome> {
    this.messages.push(input)
    for (let i = 0; i < 8; i++) {
      const { outcome, calls, text } = await this.step(signal)
      this.messages.push(this.reply(text, calls))
      if (outcome.kind !== 'tools') return outcome
      for (const call of calls) {
        this.messages.push({ role: 'toolResult', toolCallId: call.id, toolName: call.name, content: [{ type: 'text', text: 'pong' }, ...(process.env.STRESS_TOOL_IMAGE ? [{ type: 'image' as const, data: IMAGE, mimeType: 'image/png' }] : [])], isError: false, timestamp: now++ } as Message)
      }
    }
    throw new Error('turn did not end in 8 steps')
  }
}

function claudePids(): number[] {
  const out = Bun.spawnSync(['pgrep', '-f', `${stateDir}.*claude|claude.*--resume|claude --output-format stream-json`]).stdout.toString()
  return out.split('\n').filter(Boolean).map(Number).filter((pid) => pid !== process.pid)
}

function rssMb(pid: number): number {
  try {
    const status = require('node:fs').readFileSync(`/proc/${pid}/status`, 'utf8') as string
    return Math.round(Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0) / 1024)
  } catch {
    return 0
  }
}

function heap(): { rss: number; heap: number } {
  // STRESS_NO_GC=1: measure as prod runs, with no forced collection.
  if (!process.env.STRESS_NO_GC) Bun.gc(true)
  const usage = process.memoryUsage()
  return { rss: Math.round(usage.rss / 2 ** 20), heap: Math.round(usage.heapUsed / 2 ** 20) }
}

const newSessions = () => (process.env.STRESS_PROVIDER ? (createClaudeProvider({ stateDir, cwd, env }), claudeSessions() ?? new ClaudeSessions({ stateDir, cwd, env })) : new ClaudeSessions({ stateDir, cwd, env }))

// ── scenarios ──────────────────────────────────────────────────────────────

type Result = { ok: boolean; detail: string }

const scenarios: Record<string, () => Promise<Result>> = {
  /** 40 turns, each with a screenshot and a tool round trip: the daemon's memory must not grow with turns. */
  async memory() {
    const sessions = newSessions()
    const thread = new Thread(sessions, 'memory')
    const samples: number[] = []
    const rss: number[] = []
    for (let i = 0; i < 40; i++) {
      const outcome = await thread.turn(user(`turn ${i} TOOL`, 1))
      if (outcome.kind !== 'result') return { ok: false, detail: `turn ${i} ended ${outcome.kind}` }
      if (i % 5 === 4) {
        const h = heap()
        samples.push(h.heap)
        rss.push(h.rss)
      }
    }
    const child = claudePids().map(rssMb).reduce((a, b) => a + b, 0)
    const before = heap()
    await sessions.stopAll()
    const after = heap()
    const growth = samples.at(-1)! - samples[0]!
    return {
      ok: growth < 120,
      detail: `heap MB every 5 turns: ${samples.join(' ')} (growth ${growth}); daemon RSS MB: ${rss.join(' ')}; claude RSS ${child} MB; heap ${before.heap}->${after.heap} MB after stop; biggest request ${(mock.maxRequestBytes / 2 ** 20).toFixed(1)} MB`,
    }
  },

  /** The prod shape (2026-11-04): one message with 39 screenshots, then a turn of many tool steps. */
  async burst() {
    const sessions = newSessions()
    const thread = new Thread(sessions, 'burst')
    const steps = Number(process.env.STRESS_BURST_STEPS) || 30
    const rss: number[] = []
    let peak = 0
    const sampler = setInterval(() => (peak = Math.max(peak, Math.round(process.memoryUsage().rss / 2 ** 20))), 50)
    mock.delayMs = Number(process.env.STRESS_DELAY_MS) || 0
    mock.deltas = Number(process.env.STRESS_DELTAS) || 4
    thread.messages.push(user('here are the screenshots', 39))
    // STRESS_TURN_IMAGES=n: every turn's prompt carries n new screenshots, as in the daemon e2e.
    const turnImages = Number(process.env.STRESS_TURN_IMAGES) || 0
    for (let i = 0; i < steps; i++) {
      thread.messages.push(user(process.env.BISECT_NO_TOOLS ? `step ${i}` : `step ${i} TOOL`))
      const outcome = await thread.turn(user(`go ${i}`, turnImages))
      if (outcome.kind !== 'result') return { ok: false, detail: `step ${i} ended ${outcome.kind}` }
      if (i % 5 === 4) rss.push(heap().rss)
    }
    clearInterval(sampler)
    const child = claudePids().map(rssMb).reduce((a, b) => a + b, 0)
    Bun.gc(true)
    const live = process.memoryUsage()
    await Bun.sleep(3000)
    Bun.gc(true)
    const settled = Math.round(process.memoryUsage().rss / 2 ** 20)
    console.log(`settled with claude alive (GC + 3 s): ${settled} MB`)
    if (process.env.STRESS_HEAPSTATS) {
      const stats = require('bun:jsc').heapStats()
      const top = (o: Record<string, number>) => Object.entries(o).sort((x, y) => y[1] - x[1]).slice(0, 8)
      console.log('heapStats', JSON.stringify({ heapMb: Math.round(stats.heapSize / 2 ** 20), extraMb: Math.round(stats.extraMemorySize / 2 ** 20), objects: stats.objectCount, protected: stats.protectedObjectCount, protectedTop: top(stats.protectedObjectTypeCounts), top: top(stats.objectTypeCounts) }))
    }
    if (process.env.STRESS_SNAPSHOT) require('node:fs').writeFileSync(process.env.STRESS_SNAPSHOT, Bun.generateHeapSnapshot('v8'))
    await sessions.stopAll()
    await Bun.sleep(3000)
    Bun.gc(true)
    const after = heap().rss
    return { ok: peak < 1200, detail: `with claude alive (after GC): rss ${Math.round(live.rss / 2 ** 20)} heap ${Math.round(live.heapUsed / 2 ** 20)}; daemon RSS MB every 5 steps: ${rss.join(' ')}; peak ${peak}; after stop ${after}; claude RSS ${child} MB; biggest request ${(mock.maxRequestBytes / 2 ** 20).toFixed(1)} MB; ${mock.requests} requests` }
  },

  /** Memory pressure while Claude waits for a tool result: recycling must not hang or spend a model call. */
  async 'recycle-parked'() {
    const sessions = newSessions()
    const thread = new Thread(sessions, 'recycle-parked')
    thread.messages.push(user('call a tool TOOL'))
    const { outcome, calls, text } = await thread.step()
    if (outcome.kind !== 'tools') return { ok: false, detail: `expected a tool step, got ${outcome.kind}` }
    const before = mock.requests
    const started = Date.now()
    const released = await Promise.race([sessions.recycleIdle(), Bun.sleep(30_000).then(() => -1)])
    const recycleMs = Date.now() - started
    await Bun.sleep(500)
    const spent = mock.requests - before
    const left = claudePids().length
    thread.messages.push({ role: 'assistant', content: [...(text ? [{ type: 'text', text }] : []), ...calls.map((c) => ({ type: 'toolCall', id: c.id, name: c.name, arguments: { text: 'ping' } }))], stopReason: 'toolUse', timestamp: now++ } as never)
    for (const call of calls) thread.messages.push({ role: 'toolResult', toolCallId: call.id, toolName: call.name, content: [{ type: 'text', text: 'pong' }], isError: false, timestamp: now++ } as Message)
    const next = await Promise.race([thread.step().then((r) => r.outcome.kind, (e: Error) => `threw: ${e.message.slice(0, 160)}`), Bun.sleep(60_000).then(() => 'hung 60 s')])
    await sessions.stopAll()
    return { ok: released === 1 && spent === 0 && left === 0 && next === 'result' && recycleMs < 15_000, detail: `released ${released} in ${recycleMs} ms; model calls during recycle ${spent}; processes left ${left}; continuation: ${next}` }
  },

  /** Recycle between turns: the next turn resumes the same Claude session. */
  async 'recycle-idle'() {
    const sessions = newSessions()
    const thread = new Thread(sessions, 'recycle-idle')
    await thread.turn(user('first TOOL'))
    const released = await sessions.recycleIdle()
    const next = await thread.turn(user('second')).then((o) => o.kind, (e: Error) => `threw: ${e.message}`)
    await sessions.stopAll()
    return { ok: released === 1 && next === 'result', detail: `released ${released}; next turn: ${next}` }
  },

  /** SIGKILL the claude process mid-stream: the step fails with a clear error and the next turn recovers. */
  async 'kill-streaming'() {
    const sessions = newSessions()
    const thread = new Thread(sessions, 'kill-streaming')
    await thread.turn(user('warm up'))
    mock.delayMs = 200
    mock.deltas = 30
    const running = thread.turn(user('stream slowly')).then((o) => o, (e: Error) => e)
    await Bun.sleep(1500)
    const pids = claudePids()
    for (const pid of pids) process.kill(pid, 'SIGKILL')
    const first = await running
    mock.delayMs = 0
    mock.deltas = 4
    const second = await thread.turn(user('after the kill')).then((o) => o.kind, (e: Error) => `threw: ${e.message}`)
    await sessions.stopAll()
    return { ok: pids.length > 0 && second === 'result', detail: `killed ${pids.length}; first: ${first instanceof Error ? `threw: ${first.message.slice(0, 120)}` : first.kind}; next turn: ${second}` }
  },

  /** SIGKILL while Claude waits for pi's tool result: the continuation must recover, not hang. */
  async 'kill-parked'() {
    const sessions = newSessions()
    const thread = new Thread(sessions, 'kill-parked')
    thread.messages.push(user('call a tool TOOL'))
    const { outcome, calls } = await thread.step()
    if (outcome.kind !== 'tools') return { ok: false, detail: `expected a tool step, got ${outcome.kind}` }
    const pids = claudePids()
    for (const pid of pids) process.kill(pid, 'SIGKILL')
    await Bun.sleep(300)
    thread.messages.push({ role: 'assistant', content: calls.map((c) => ({ type: 'toolCall', id: c.id, name: c.name, arguments: { text: 'ping' } })), stopReason: 'toolUse', timestamp: now++ } as never)
    for (const call of calls) thread.messages.push({ role: 'toolResult', toolCallId: call.id, toolName: call.name, content: [{ type: 'text', text: 'pong' }], isError: false, timestamp: now++ } as Message)
    const next = await Promise.race([
      thread.step().then((r) => r.outcome.kind, (e: Error) => `threw: ${e.message.slice(0, 160)}`),
      Bun.sleep(60_000).then(() => 'hung 60 s'),
    ])
    await sessions.stopAll()
    return { ok: next === 'result', detail: `killed ${pids.length} while parked; continuation: ${next}` }
  },

  /** Abort mid-stream: the step ends 'aborted' fast and the thread keeps working. */
  async abort() {
    const sessions = newSessions()
    const thread = new Thread(sessions, 'abort')
    mock.delayMs = 200
    mock.deltas = 30
    const controller = new AbortController()
    const started = Date.now()
    const running = thread.turn(user('stream slowly'), controller.signal)
    await Bun.sleep(1500)
    controller.abort()
    const first = await running.then((o) => o.kind, (e: Error) => `threw: ${e.message}`)
    const abortMs = Date.now() - started - 1500
    mock.delayMs = 0
    mock.deltas = 4
    const second = await thread.turn(user('after abort')).then((o) => o.kind, (e: Error) => `threw: ${e.message}`)
    await sessions.stopAll()
    return { ok: first === 'aborted' && second === 'result' && abortMs < 10_000, detail: `aborted in ${abortMs} ms -> ${first}; next turn: ${second}` }
  },

  /** A stopped process (idle, daemon restart) resumes its Claude session on the next turn. */
  async 'idle-resume'() {
    const sessions = newSessions()
    const thread = new Thread(sessions, 'idle-resume')
    await thread.turn(user('first'))
    await sessions.stopAll()
    const outcome = await thread.turn(user('second'))
    const fresh = newSessions() // a daemon restart: same state dir, no live process
    const restarted = new Thread(fresh, 'idle-resume')
    restarted.messages.push(...thread.messages)
    const third = await restarted.turn(user('third'))
    await sessions.stopAll()
    await fresh.stopAll()
    return { ok: outcome.kind === 'result' && third.kind === 'result', detail: `after stop: ${outcome.kind}; after restart: ${third.kind}` }
  },

  /** Several threads at once (root + subagents): no cross-talk, every process stops. */
  async parallel() {
    const sessions = newSessions()
    const threads = Array.from({ length: 6 }, (_, i) => new Thread(sessions, `parallel-${i}`))
    const outcomes = await Promise.all(threads.map((thread) => thread.turn(user('parallel TOOL'))))
    const live = claudePids().length
    await sessions.stopAll()
    await Bun.sleep(500)
    const left = claudePids().length
    const ok = outcomes.every((o) => o.kind === 'result') && left === 0
    return { ok, detail: `${outcomes.map((o) => o.kind).join(',')}; ${live} processes live, ${left} left after stopAll` }
  },
}

// ── run ────────────────────────────────────────────────────────────────────

const executable = await ensureClaudeExecutable(stateDir, env)
env.KORTIX_CLAUDE_PATH = executable
console.log(`claude: ${executable}; mock API :${server.port}`)
const wanted = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(scenarios)
let failures = 0
for (const name of wanted) {
  const run = scenarios[name]
  if (!run) throw new Error(`no scenario ${name}`)
  const started = Date.now()
  const result = await run().catch((err: Error): Result => ({ ok: false, detail: `threw: ${err.stack ?? err.message}` }))
  if (!result.ok) failures++
  console.log(`${result.ok ? 'PASS' : 'FAIL'} ${name} (${Date.now() - started} ms): ${result.detail}`)
}
server.stop(true)
stopLlmProxy()
rmSync(stateDir, { recursive: true, force: true })
rmSync(cwd, { recursive: true, force: true })
process.exit(failures)
