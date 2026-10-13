#!/usr/bin/env bun
/**
 * kortixd on your own machine: a local LLM gateway, the daemon, and a chat REPL
 * in this terminal. No Kortix API, no sandbox provider. The only network call
 * is the model request to ChatGPT (your Plus/Pro subscription).
 *
 *   bun scripts/local.ts login                 sign in with ChatGPT once
 *   bun scripts/local.ts [options]             start a session in the current directory
 *
 *   --harness pi|opencode   the session harness (default: pi)
 *   --model <id>            gateway model id (default: codex/gpt-5.5)
 *   --workspace <dir>       the directory the agent works in (default: the current directory)
 *   --fresh                 forget this workspace's previous conversation
 *
 * The gateway is `packages/llm-gateway` with local hooks: every request goes to
 * ChatGPT's Codex backend with the token `login` stored. The daemon runs with
 * HOME set to ~/.kortix/local/home, so it never writes your own git or OpenCode
 * config. Its tools still run as you, inside the workspace: this is not a sandbox.
 */
import { spawn } from 'node:child_process'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { parseArgs } from 'node:util'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import { createGateway } from '../../../packages/llm-gateway/src/index.ts'
import type { UpstreamDescriptor } from '../../../packages/llm-gateway/src/index.ts'
import { OPENCODE_USER_AGENT } from '../../../packages/shared/src/runtime-versions.ts'
import CODEX_MODELS from '../../api/src/llm-gateway/models/codex-models.seed.json'
import { ensureOpencodeBin } from '../../cli/src/opencode-bin.ts'

const ROOT = join(homedir(), '.kortix', 'local')
const AUTH_FILE = join(ROOT, 'codex-auth.json')
const PACKAGE_DIR = resolve(import.meta.dir, '..')
const oauth = openaiCodexProvider().auth.oauth!

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`
const red = (s: string) => `\x1b[31m${s}\x1b[0m`
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    harness: { type: 'string', default: 'pi' },
    model: { type: 'string', default: 'codex/gpt-5.5' },
    workspace: { type: 'string', default: process.cwd() },
    fresh: { type: 'boolean', default: false },
  },
})

const rl = createInterface({ input: process.stdin, output: process.stdout })

// ── ChatGPT sign-in ────────────────────────────────────────────────────────

async function login() {
  const credential = await oauth.login({
    signal: new AbortController().signal,
    notify(event) {
      if (event.type === 'auth_url') {
        console.log(`Opening ${event.url}`)
        Bun.spawn(['open', event.url])
      } else if (event.type === 'progress') console.log(dim(event.message))
    },
    async prompt(p) {
      if (p.type === 'select') return 'browser'
      // The browser redirect normally completes the login; pasting the redirect URL is the fallback.
      return rl.question(`${p.message} `, { signal: p.signal }).catch(() => '')
    },
  })
  mkdirSync(ROOT, { recursive: true })
  writeFileSync(AUTH_FILE, JSON.stringify(credential, null, 2), { mode: 0o600 })
  console.log(`Signed in. Token stored in ${AUTH_FILE}`)
  rl.close()
}

type CodexCredential = { access: string; refresh: string; expires: number; accountId: string }
let refreshing: Promise<CodexCredential> | null = null

/** The stored ChatGPT token, refreshed when it expires within 5 min. One refresh at a time: OpenAI rotates the refresh token. */
async function codexCredential(force = false): Promise<CodexCredential> {
  const stored = JSON.parse(readFileSync(AUTH_FILE, 'utf8')) as CodexCredential
  if (!force && stored.expires - Date.now() > 5 * 60_000) return stored
  refreshing ??= (async () => {
    const next = (await oauth.refresh(stored as never, AbortSignal.timeout(30_000))) as unknown as CodexCredential
    writeFileSync(AUTH_FILE, JSON.stringify(next, null, 2), { mode: 0o600 })
    return next
  })().finally(() => (refreshing = null))
  return refreshing
}

// ── Local gateway ──────────────────────────────────────────────────────────

/** Same descriptor apps/api builds for a ChatGPT login (`codexDescriptor`). */
function codexDescriptor(credential: CodexCredential, model: string): UpstreamDescriptor {
  return {
    provider: 'openai-codex',
    kind: 'openai-responses',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    apiKey: credential.access,
    billingMode: 'none',
    markup: 0,
    resolvedModel: model.replace(/^codex\//, ''),
    refreshableCredential: true,
    headers: {
      originator: 'codex_cli_rs',
      'User-Agent': OPENCODE_USER_AGENT,
      'OpenAI-Beta': 'responses=experimental',
      'ChatGPT-Account-ID': credential.accountId,
    },
  }
}

function startGateway(token: string, logFile: string) {
  const log = (...args: unknown[]) =>
    writeFileSync(logFile, `${new Date().toISOString()} ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`, { flag: 'a' })
  const principal = { userId: 'local', accountId: 'local' }
  const gateway = createGateway(
    {
      authenticate: async (t) => (t === token ? principal : null),
      resolveUpstream: async (_p, model) => [codexDescriptor(await codexCredential(), model)],
      refreshCredential: async (_p, d) => codexDescriptor(await codexCredential(true), d.resolvedModel ?? ''),
      assertBillingActive: async () => {},
      recordUsage: async () => {},
      listModels: async () =>
        Object.fromEntries(CODEX_MODELS.map((id) => [`codex/${id}`, { name: id, provider: 'codex', reasoning: true, tool_call: true, attachment: true }])),
    },
    { logger: { info: log, warn: log, error: log, debug: log } },
  )
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    idleTimeout: 0, // a model stream can sit silent longer than Bun's 10 s default
    async fetch(req) {
      const url = new URL(req.url)
      const authorization = req.headers.get('authorization') ?? undefined
      if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
        return gateway.chatCompletions({ authorization, rawBody: await req.text(), signal: req.signal })
      }
      if (req.method === 'GET' && url.pathname === '/v1/models') {
        return gateway.listModels(authorization, { managedOnly: false, ...(url.searchParams.get('scope') === 'picker' ? { scope: 'picker' as const } : {}) })
      }
      return new Response('not found', { status: 404 })
    },
  })
  return `http://127.0.0.1:${server.port}/v1`
}

// ── Daemon ─────────────────────────────────────────────────────────────────

function freePort(): number {
  const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() })
  const port = probe.port!
  probe.stop(true)
  return port
}

async function startDaemon(token: string, gatewayUrl: string, workspace: string, state: string) {
  const port = freePort()
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: join(ROOT, 'home'),
    KORTIX_HARNESS: opts.harness,
    KORTIX_TOKEN: token,
    KORTIX_LLM_BASE_URL: gatewayUrl,
    KORTIX_LLM_PROXY_DISABLE: '1', // the gateway is already on localhost
    KORTIX_MODEL: opts.model,
    KORTIX_WORKSPACE: workspace,
    KORTIX_PROJECT_TARGET: workspace,
    KORTIX_SERVICE_PORT: String(port),
    KORTIX_STATIC_PORT: String(freePort()),
    KORTIX_OPENCODE_INTERNAL_PORT: String(freePort()),
    KORTIX_OPENCODE_STANDBY_PORT: String(freePort()),
    KORTIX_DEFAULT_OPENCODE_CONFIG_DIR: join(state, 'opencode-config'),
    KORTIX_BOOT_CONFIG_ROOT: join(state, 'config'), // default /opt/kortix/config: not writable on a Mac
    KORTIX_AGENT_STATE_DIR: join(state, 'agent'),
    KORTIX_RUNTIME_STATE_DIR: join(state, 'runtime'),
    KORTIX_PI_STATE_DIR: join(state, 'pi'),
    KORTIX_PI_AGENT_DIR: join(state, 'pi-agent'),
  }
  if (opts.harness === 'opencode') {
    // The OpenCode version the sandbox image pins, from the Kortix CLI's cache (downloaded on first use).
    const { bin } = await ensureOpencodeBin()
    env.PATH = `${dirname(bin)}:${env.PATH}`
  }
  mkdirSync(env.HOME!, { recursive: true })
  const logFile = join(state, 'daemon.log')
  const log = openSync(logFile, 'a')
  // Own process group: the terminal's Ctrl-C and hang-up reach this script, never the daemon directly.
  // ponytail: a SIGKILLed script leaves the daemon running; add a parent watchdog if that bites.
  const daemon = spawn('bun', ['run', join(PACKAGE_DIR, 'src/main.ts')], { cwd: PACKAGE_DIR, env, detached: true, stdio: ['ignore', log, log] })
  const base = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    if (daemon.exitCode !== null) fail(`kortixd exited with code ${daemon.exitCode}. Log: ${logFile}`)
    const health = (await fetch(`${base}/kortix/health`).then((r) => r.json()).catch(() => null)) as { runtimeReady?: boolean; boot_error?: string | null } | null
    if (health?.boot_error) fail(`kortixd boot failed: ${health.boot_error}. Log: ${logFile}`)
    if (health?.runtimeReady) return { daemon, base, logFile }
    await Bun.sleep(300)
  }
  daemon.kill()
  fail(`kortixd was not ready after 120 s. Log: ${logFile}`)
}

// ── REPL ───────────────────────────────────────────────────────────────────

type Frame = { type: string; payload: Record<string, any> }

/** The signed user context the daemon's OpenCode-compatible routes require (apps/api mints it in the cloud). */
function userContext(token: string): string {
  const now = Math.floor(Date.now() / 1000)
  const payload = Buffer.from(JSON.stringify({ userId: 'local', sandboxId: 'local', sandboxRole: 'owner', scopes: [], iat: now, exp: now + 86_400 })).toString('base64url')
  return `${payload}.${createHmac('sha256', token).update(payload).digest('base64url')}`
}

async function* events(base: string, token: string): AsyncGenerator<Frame> {
  const res = await fetch(`${base}/kortix/runtime/events`, { headers: { Authorization: `Bearer ${token}` } })
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of res.body!) {
    buffer += decoder.decode(chunk, { stream: true })
    let end: number
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const data = buffer.slice(0, end).split('\n').find((line) => line.startsWith('data: '))
      buffer = buffer.slice(end + 2)
      if (data) yield JSON.parse(data.slice(6)) as Frame
    }
  }
}

async function main() {
  const workspace = resolve(opts.workspace!)
  const state = join(ROOT, 'workspaces', `${opts.harness}-${createHash('sha256').update(workspace).digest('hex').slice(0, 12)}`)
  if (opts.fresh) rmSync(state, { recursive: true, force: true })
  mkdirSync(state, { recursive: true })

  const token = `kortix_local_${randomBytes(24).toString('hex')}`
  const gatewayUrl = startGateway(token, join(state, 'gateway.log'))
  console.log(dim(`starting kortixd (${opts.harness}) in ${workspace} …`))
  const { daemon, base, logFile } = await startDaemon(token, gatewayUrl, workspace, state)
  const stop = () => {
    daemon.kill('SIGTERM')
    process.exit(0)
  }
  process.on('SIGTERM', stop)
  process.on('SIGHUP', stop)

  const raw = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, { ...init, headers: { 'content-type': 'application/json', 'X-Kortix-User-Context': userContext(token), ...init.headers } })
  const runtime = (path: string, body: unknown) =>
    fetch(`${base}/kortix/runtime${path}`, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) })

  // Resume the workspace's last root session (pi always has exactly one), else create one.
  const sessions = (await raw('/session').then((r) => r.json())) as Array<{ id: string; parentID?: string; time?: { updated?: number } }>
  const root =
    sessions.filter((s) => !s.parentID).sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))[0]?.id ??
    ((await raw('/session', { method: 'POST', body: '{}' }).then((r) => r.json())) as { id: string }).id

  let model = opts.model!
  console.log(`${cyan('kortixd')} ${opts.harness} · ${model} · session ${root}`)
  console.log(dim(`log ${logFile}\n/model <id> switches model · /models lists them · Ctrl-C aborts a turn · Ctrl-D quits\n`))

  // ── live rendering of the root session's events ──
  const partType = new Map<string, string>()
  const role = new Map<string, string>()
  const toolShown = new Map<string, string>()
  let last: 'text' | 'reasoning' | 'tool' | null = null
  let turnDone = null as (() => void) | null
  const write = (kind: 'text' | 'reasoning' | 'tool', s: string) => {
    if (last && last !== kind) process.stdout.write('\n')
    last = kind
    process.stdout.write(s)
  }

  void (async () => {
    for await (const frame of events(base, token)) {
      const p = frame.payload ?? {}
      if (p.sessionID && p.sessionID !== root) continue // subagent sessions: their task tool line shows the result
      switch (frame.type) {
        case 'message.updated':
          role.set(p.info.id, p.info.role)
          break
        case 'message.part.updated': {
          const part = p.part
          partType.set(part.id, part.type)
          if (part.type !== 'tool') break
          const status = part.state?.status
          if (toolShown.get(part.id) === status) break
          if (status === 'running' || (!toolShown.has(part.id) && status !== 'pending')) {
            write('tool', `${cyan('●')} ${part.tool} ${dim(summary(part.state?.input))}\n`)
          }
          if (status === 'completed') write('tool', dim(`  ⎿ ${firstLine(part.state.output)}\n`))
          if (status === 'error') write('tool', red(`  ⎿ ${firstLine(part.state.error)}\n`))
          toolShown.set(part.id, status)
          break
        }
        case 'message.part.delta':
          if (role.get(p.messageID) !== 'assistant' || p.field !== 'text') break
          if (partType.get(p.partID) === 'reasoning') write('reasoning', dim(p.delta))
          else write('text', p.delta)
          break
        case 'session.error':
          write('tool', red(`✗ ${p.error?.data?.message ?? JSON.stringify(p.error)}\n`))
          break
        case 'question.asked':
          await answerQuestion(p, raw)
          break
        case 'permission.asked': {
          const answer = await rl.question(`\n${cyan('?')} allow ${p.permission} ${p.patterns?.join(' ') ?? ''} [y]es / [a]lways / [n]o `)
          const reply = answer.startsWith('a') ? 'always' : answer.startsWith('n') ? 'reject' : 'once'
          await raw(`/permission/${p.id}/reply`, { method: 'POST', body: JSON.stringify({ reply }) })
          break
        }
        case 'kortix.turn':
        case 'session.idle':
          if (last) process.stdout.write('\n')
          last = null
          turnDone?.()
          break
      }
    }
  })()

  let busy = false
  rl.on('SIGINT', () => {
    if (!busy) return stop()
    process.stdout.write(red('\n(aborting)\n'))
    void runtime(`/sessions/${root}/abort`, {})
  })
  rl.on('close', stop)

  for (;;) {
    const text = (await rl.question(`${cyan('›')} `)).trim()
    if (!text) continue
    if (text === '/exit') stop()
    if (text === '/models') {
      console.log(CODEX_MODELS.map((id) => `  codex/${id}`).join('\n'))
      continue
    }
    if (text.startsWith('/model ')) {
      model = text.slice(7).trim()
      console.log(dim(`model: ${model}`))
      continue
    }
    const done = new Promise<void>((r) => (turnDone = r))
    const res = await runtime(`/sessions/${root}/prompt`, { parts: [{ type: 'text', text }], model: `kortix/${model}` })
    if (!res.ok) {
      console.log(red(`prompt failed: ${res.status} ${await res.text()}`))
      continue
    }
    busy = true
    await done
    busy = false
  }
}

async function answerQuestion(p: Record<string, any>, raw: (path: string, init?: RequestInit) => Promise<Response>) {
  const answers: string[][] = []
  for (const q of p.questions as Array<{ question: string; options: Array<{ label: string; description: string }> }>) {
    console.log(`\n${cyan('?')} ${q.question}`)
    q.options.forEach((o, i) => console.log(`  ${i + 1}. ${o.label} ${dim(o.description)}`))
    const answer = (await rl.question('  answer (number or text): ')).trim()
    answers.push([q.options[Number(answer) - 1]?.label ?? answer])
  }
  await raw(`/question/${p.id}/reply`, { method: 'POST', body: JSON.stringify({ answers }) })
}

function summary(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const v = input as Record<string, unknown>
  const s = String(v.command ?? v.filePath ?? v.path ?? v.pattern ?? v.url ?? v.query ?? v.description ?? JSON.stringify(v))
  return s.length > 100 ? `${s.slice(0, 100)}…` : s
}

function firstLine(text: unknown): string {
  const lines = String(text ?? '').trim().split('\n')
  const head = (lines[0] ?? '').slice(0, 120)
  return lines.length > 1 ? `${head} ${dim(`(+${lines.length - 1} lines)`)}` : head
}

function fail(message: string): never {
  console.error(red(message))
  process.exit(1)
}

// Last, so every module-level binding above is initialized before main() reads it.
if (positionals[0] === 'login') {
  await login()
  process.exit(0)
}
if (!['pi', 'opencode'].includes(opts.harness!)) fail(`--harness must be pi or opencode, got "${opts.harness}"`)
if (!existsSync(AUTH_FILE)) fail(`not signed in. Run: bun ${import.meta.path} login`)
await main()
