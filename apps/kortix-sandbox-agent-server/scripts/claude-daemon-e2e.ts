/**
 * The whole daemon (pi runtime, session log, LLM proxy, Claude Code harness) on a Claude
 * subscription model, against a mock Anthropic API: the prod shape of 2026-11-04 (screenshots
 * attached to prompts, then long tool loops that read more screenshots). Samples the daemon's
 * RSS and prints it per turn. No credential, no model cost.
 *
 *   bun scripts/claude-daemon-e2e.ts [--turns 4] [--steps 15] [--images 13] [--proxy]
 *
 * E2E_SMOL=1 runs the daemon with `bun --smol`; E2E_CLAUDE_PATH picks the claude binary;
 * E2E_KILL_CLAUDE=1 idles, then kills claude, printing the daemon's RSS after each.
 */
import { spawn } from 'node:child_process'
import { createHmac, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { deflateSync } from 'node:zlib'

const { values: opts } = parseArgs({
  options: {
    turns: { type: 'string', default: '4' },
    steps: { type: 'string', default: '15' },
    images: { type: 'string', default: '13' },
    proxy: { type: 'boolean', default: false },
  },
})
const TURNS = Number(opts.turns)
const STEPS = Number(opts.steps)
const IMAGES = Math.min(16, Number(opts.images))
const PACKAGE_DIR = resolve(import.meta.dir, '..')

function noisePng(side: number): Buffer {
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
  for (let y = 0; y < side; y++) crypto.getRandomValues(raw.subarray(y * (side * 3 + 1) + 1, (y + 1) * (side * 3 + 1)))
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

// ── mock Anthropic API ─────────────────────────────────────────────────────

let requests = 0
let maxBytes = 0
let toolNames: string[] = []

function sse(events: Array<Record<string, unknown>>): Response {
  const body = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
}

function reply(body: { model?: string; tools?: Array<{ name: string }>; messages?: unknown[] }): Response {
  const tools = (body.tools ?? []).map((tool) => tool.name)
  if (tools.length) toolNames = tools
  const text = JSON.stringify(body.messages ?? [])
  // Tool results since this turn's prompt: the turn takes STEPS of them, then answers.
  const since = text.slice(text.lastIndexOf('GO-TURN'))
  const done = (since.match(/"tool_result"/g) ?? []).length
  const read = tools.find((name) => /__read$/.test(name))
  const bash = tools.find((name) => /__bash$/.test(name))
  const id = `msg_${randomBytes(12).toString('hex')}`
  const events: Array<Record<string, unknown>> = [
    { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: body.model ?? 'claude-opus-4', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } },
  ]
  if (tools.length && read && bash && done < STEPS) {
    const input = done % 2 === 0 ? { path: `shot_${done % 20}.png` } : { command: `echo step ${done}` }
    events.push(
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      ...Array.from({ length: 40 }, (_, i) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `looking ${i} ` } })),
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: `toolu_${randomBytes(12).toString('hex')}`, name: done % 2 === 0 ? read : bash, input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 50 } },
    )
  } else {
    events.push(
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      ...Array.from({ length: 200 }, (_, i) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `done ${i} ` } })),
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 200 } },
    )
  }
  events.push({ type: 'message_stop' })
  return sse(events)
}

const api = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(request) {
    const url = new URL(request.url)
    if (request.method === 'POST' && url.pathname.endsWith('/v1/messages')) {
      const raw = await request.text()
      requests++
      maxBytes = Math.max(maxBytes, raw.length)
      return reply(JSON.parse(raw))
    }
    if (url.pathname.endsWith('/v1/messages/count_tokens')) return Response.json({ input_tokens: 10 })
    return Response.json({ error: 'not found' }, { status: 404 })
  },
})

// ── daemon ─────────────────────────────────────────────────────────────────

const root = mkdtempSync(join(tmpdir(), 'claude-daemon-e2e-'))
const workspace = join(root, 'workspace')
const state = join(root, 'state')
mkdirSync(workspace, { recursive: true })
for (let i = 0; i < 20; i++) writeFileSync(join(workspace, `shot_${i}.png`), noisePng(512))
const freePort = () => {
  const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() })
  const port = probe.port!
  probe.stop(true)
  return port
}
const token = randomBytes(24).toString('hex')
const port = freePort()
const env: Record<string, string | undefined> = {
  ...process.env,
  HOME: join(root, 'home'),
  KORTIX_HARNESS: 'pi',
  KORTIX_TOKEN: token,
  KORTIX_LLM_BASE_URL: `http://127.0.0.1:${api.port}`,
  ...(opts.proxy ? {} : { KORTIX_LLM_PROXY_DISABLE: '1' }),
  KORTIX_MODEL: 'claude-agent/opus',
  KORTIX_WORKSPACE: workspace,
  KORTIX_PROJECT_TARGET: workspace,
  KORTIX_SERVICE_PORT: String(port),
  KORTIX_STATIC_PORT: String(freePort()),
  KORTIX_BOOT_CONFIG_ROOT: join(state, 'config'),
  KORTIX_AGENT_STATE_DIR: join(state, 'agent'),
  KORTIX_RUNTIME_STATE_DIR: join(state, 'runtime'),
  KORTIX_PI_STATE_DIR: join(state, 'pi'),
  KORTIX_PI_AGENT_DIR: join(state, 'pi-agent'),
}
if (!process.env.E2E_CLAUDE_PATH) delete env.KORTIX_CLAUDE_PATH
else env.KORTIX_CLAUDE_PATH = process.env.E2E_CLAUDE_PATH
mkdirSync(env.HOME!, { recursive: true })
const logFile = join(root, 'daemon.log')
const daemon = spawn('bun', [...(process.env.E2E_SMOL ? ['--smol'] : []), 'run', join(PACKAGE_DIR, 'src/main.ts')], { cwd: PACKAGE_DIR, env, stdio: ['ignore', openSync(logFile, 'a'), openSync(logFile, 'a')] })
const base = `http://127.0.0.1:${port}`
console.log(`daemon pid ${daemon.pid}, log ${logFile}, mock :${api.port}`)

const rssMb = (pid: number) => {
  try {
    return Math.round(Number(readFileSync(`/proc/${pid}/status`, 'utf8').match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0) / 1024)
  } catch {
    return 0
  }
}
let peak = 0
const sampler = setInterval(() => (peak = Math.max(peak, rssMb(daemon.pid!))), 250)

const shutdown = (code: number) => {
  clearInterval(sampler)
  daemon.kill('SIGTERM')
  api.stop(true)
  process.exit(code)
}

for (let i = 0; ; i++) {
  const health = (await fetch(`${base}/kortix/health`).then((r) => r.json()).catch(() => null)) as { runtimeReady?: boolean; boot_error?: string | null } | null
  if (health?.runtimeReady) break
  if (health?.boot_error || i > 240) {
    console.log(`boot failed: ${health?.boot_error ?? 'timeout'}`)
    shutdown(1)
  }
  await Bun.sleep(500)
}

const userContext = () => {
  const now = Math.floor(Date.now() / 1000)
  const payload = Buffer.from(JSON.stringify({ userId: 'local', sandboxId: 'local', sandboxRole: 'owner', scopes: [], iat: now, exp: now + 86_400 })).toString('base64url')
  return `${payload}.${createHmac('sha256', token).update(payload).digest('base64url')}`
}
const raw = (path: string, init: RequestInit = {}) =>
  fetch(`${base}${path}`, { ...init, headers: { 'content-type': 'application/json', 'X-Kortix-User-Context': userContext(), ...init.headers } })
const session = ((await raw('/session', { method: 'POST', body: '{}' }).then((r) => r.json())) as { id: string }).id

/** Whether the session's turn is still running, from the daemon's health probe. */
const busy = async () => {
  const health = (await fetch(`${base}/kortix/health?turn=1`).then((r) => r.json()).catch(() => null)) as { turn_in_flight?: boolean } | null
  return health?.turn_in_flight === true
}

const shot = readFileSync(join(workspace, 'shot_0.png')).toString('base64')
const started = Date.now()
for (let turn = 0; turn < TURNS; turn++) {
  const before = requests
  const parts = [
    { type: 'text', text: `GO-TURN ${turn}: look at these screenshots` },
    ...Array.from({ length: IMAGES }, (_, i) => ({ type: 'file', mime: 'image/png', url: `data:image/png;base64,${shot}`, filename: `s${turn}_${i}.png` })),
  ]
  const res = await fetch(`${base}/kortix/runtime/sessions/${session}/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ parts, model: 'claude-agent/opus' }),
  })
  if (!res.ok) {
    console.log(`prompt ${turn} failed: ${res.status} ${await res.text()}`)
    shutdown(1)
  }
  await Bun.sleep(1000)
  const deadline = Date.now() + 10 * 60_000
  while ((await busy()) && Date.now() < deadline) await Bun.sleep(500)
  console.log(`turn ${turn}: ${requests - before} model calls, daemon RSS ${rssMb(daemon.pid!)} MB (peak ${peak}), biggest request ${(maxBytes / 2 ** 20).toFixed(1)} MB, ${Math.round((Date.now() - started) / 1000)} s`)
}
if (process.env.E2E_KILL_CLAUDE) {
  for (const wait of [5, 10, 15]) {
    await Bun.sleep(wait * 1000)
    console.log(`idle, claude alive +${wait}s: daemon RSS ${rssMb(daemon.pid!)} MB`)
  }
  const kids = Bun.spawnSync(['pgrep', '-P', String(daemon.pid)]).stdout.toString().split('\n').filter(Boolean)
  const claude = kids.filter((pid) => /claude/.test(readFileSync(`/proc/${pid}/cmdline`, 'utf8')))
  console.log(`before killing ${claude.length} claude: daemon RSS ${rssMb(daemon.pid!)} MB`)
  for (const pid of claude) process.kill(Number(pid), 'SIGKILL')
  for (const wait of [2, 5, 10, 20]) {
    await Bun.sleep(wait * 1000)
    console.log(`  +${wait}s: daemon RSS ${rssMb(daemon.pid!)} MB`)
  }
}
console.log(`tools offered: ${toolNames.slice(0, 8).join(', ')}${toolNames.length > 8 ? ', …' : ''}`)
const errors = readFileSync(logFile, 'utf8').split('\n').filter((line) => /"level":"(error|warn)"/.test(line) && !/skill diagnostic/.test(line)).slice(-8)
if (errors.length) console.log(`last daemon warnings:\n${errors.map((line) => line.slice(0, 300)).join('\n')}`)
shutdown(0)
