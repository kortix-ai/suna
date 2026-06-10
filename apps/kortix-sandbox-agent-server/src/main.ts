import { writeFileSync, readFileSync, existsSync, mkdirSync, openSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname } from 'node:path'
import { writeAgentEnvFile } from './agent-env-file'
import { loadConfig, resolveOpencodeConfigDir, resolveSandboxOnBoot, type Config } from './config'
import {
  configureGitCredentialHelper,
  configureGlobalGitIdentity,
  configureRepoCredentialHelper,
  materializeRepo,
  runGitCredentialHelper,
} from './git'
import { logger } from './logger'
import { createOpencodeSupervisor, OPENCODE_HOME, waitForOpencodeReady } from './opencode'
import { ensureOpencodeConfigDeps } from './opencode-config-deps'
import { startOpencodeEventLoop, type QuestionRequest } from './opencode-events'
import { createProjectEnvStore } from './project-env'
import { startProxy } from './proxy'
import type { SandboxBootState } from './routes/health'
import { installShutdownHandlers } from './shutdown'
import { startStaticWebServer } from './static-web'

// Pin file for the opencode session created from KORTIX_INITIAL_PROMPT.
// Webhook follow-ups (e.g. Slack thread replies) read this to deliver new
// prompts into the same opencode conversation instead of opening a fresh
// session with no context.
export const OPENCODE_SESSION_PIN_PATH = '/var/run/kortix/opencode-session-id'

async function main() {
  const bootTime = Date.now()
  const cfg = loadConfig()
  const prompt = (process.env.KORTIX_INITIAL_PROMPT ?? '').trim()
  const bootstrapSession = (process.env.KORTIX_BOOTSTRAP_OPENCODE_SESSION ?? '').trim() === '1'
  const bootState: SandboxBootState = {
    repoMaterializationError: null,
    timeline: [],
    initialOpenCodeSessionRequired: prompt.length > 0 || bootstrapSession,
    initialOpenCodeSessionId: null,
    initialOpenCodeSessionError: null,
  }
  // In-container boot timeline (ms since process start). Surfaced via
  // /kortix/health so the dashboard can attribute post-create boot latency.
  const bootMark = (label: string) => {
    bootState.timeline.push({ label, atMs: Date.now() - bootTime })
  }
  logger.info('[boot] kortix-sandbox-agent-server starting', {
    servicePort: cfg.servicePort,
    opencodeInternalPort: cfg.opencodeInternalPort,
    staticPort: cfg.staticPort,
    autoClone: cfg.autoClone,
  })

  // Bring the static web server up first. It only serves files off disk, so it
  // has no dependency on repo materialization or opencode — starting it early
  // means previews work even while the agent is still booting, and a repo/
  // opencode failure never takes it down. Reachable via /proxy/<staticPort>.
  const staticWeb = startStaticWebServer(cfg.staticPort)
  bootMark('static-web')

  // Warm-pool spare (KORTIX_WARM_POOL=1 — set only by the pool builder): boot a
  // generic, session-less runtime, then adopt a claimant's session on claim.
  // Opt-in early-return; the normal boot path below is byte-identical.
  if ((process.env.KORTIX_WARM_POOL ?? '').trim() === '1') {
    await runPoolMode(cfg, bootTime, bootState, bootMark, staticWeb)
    return
  }

  try {
    await configureGlobalGitIdentity(cfg, OPENCODE_HOME)
  } catch (err) {
    logger.warn('[boot] default git identity setup failed', {
      err: err instanceof Error ? err.message : String(err),
    })
  }
  // Make `git push`/`git fetch` against the project remote authenticate
  // transparently from any shell the agent uses — no token juggling, no
  // askpass. Best-effort: a sandbox with no managed remote just skips it.
  try {
    await configureGitCredentialHelper(cfg, OPENCODE_HOME)
  } catch (err) {
    logger.warn('[boot] git credential helper setup failed', {
      err: err instanceof Error ? err.message : String(err),
    })
  }
  bootMark('git-identity')

  // The opencode config dir lives INSIDE the repo (`<workspace>/.kortix/
  // opencode`), so the repo MUST be materialized before we can resolve which
  // config dir opencode should launch with. Resolving before the clone always
  // missed the project's opencode.jsonc and silently fell back to the baked
  // default dir — so the session ran with NO custom agents/plugins/commands
  // and not even the project's `default_agent`. Clone first, then resolve.
  //
  // opencode is spawned AFTER the clone (not in parallel): OPENCODE_CONFIG_DIR
  // is fixed at spawn time, so the dir has to be known up front. The clone is
  // the boot long-pole; the opencode spawn (binary launch + port bind) is fast
  // and opencode doesn't touch the workspace until its first request anyway.
  const projectEnv = createProjectEnvStore()
  writeAgentEnvFile(projectEnv)
  const repoMaterializePromise: Promise<void> = cfg.autoClone
    ? materializeRepo(cfg).catch((err) => {
        bootState.repoMaterializationError = err instanceof Error ? err.message : String(err)
        logger.error('[boot] repo materialization failed', err)
      })
    : Promise.resolve()

  // Wait for the clone to finish before we let downstream code (config-dir
  // resolution, readiness probe, initial session creation) think the workspace
  // is ready.
  await repoMaterializePromise
  bootMark('repo-materialized')

  const opencodeConfigDir = await resolveOpencodeConfigDir(cfg)
  logger.info('[boot] resolved opencode config dir', {
    opencodeConfigDir,
    usingProjectConfig: opencodeConfigDir !== cfg.defaultOpencodeConfigDir,
  })

  // Satisfy the config dir's npm deps offline before opencode boots, so its
  // first-session `bun install` doesn't re-resolve `^` ranges over the network
  // (a 1.5–6s — sometimes minutes — stall that otherwise gates runtimeReady).
  await ensureOpencodeConfigDeps(opencodeConfigDir)
  bootMark('config-deps')

  const opencode = createOpencodeSupervisor(cfg, opencodeConfigDir, projectEnv)

  if (bootState.repoMaterializationError) {
    logger.warn('[boot] skipping opencode readiness because repo materialization failed')
  } else {
    // Now that the repo exists, pin the credential helper repo-locally too, so
    // `git push` authenticates regardless of the invoking shell's HOME (the
    // global config above only applies under HOME=<opencode home>).
    await configureRepoCredentialHelper(cfg, cfg.projectTarget).catch((err) => {
      logger.warn('[boot] repo-local git credential helper setup failed', {
        err: err instanceof Error ? err.message : String(err),
      })
    })
    await opencode.start().catch((err) => {
      // opencode.start() throws only on a hard spawn failure; the supervisor
      // self-retries on transient issues. Log + continue: the proxy will 503
      // until the supervisor reports ready.
      logger.warn('[boot] opencode.start() rejected', {
        err: err instanceof Error ? err.message : String(err),
      })
    })
  }
  bootMark('opencode-spawned')

  const server = startProxy(cfg, opencode, bootTime, bootState, projectEnv, staticWeb.port)
  installShutdownHandlers(opencode, server, staticWeb)
  bootMark('proxy-up')

  logger.info('[boot] proxy up; waiting for opencode readiness in background', {
    servicePort: cfg.servicePort,
  })

  if (bootState.repoMaterializationError) return

  // Project-declared boot command (`[sandbox] on_boot` in kortix.toml), e.g.
  // `pnpm dev` — run it backgrounded once the repo is materialized + the proxy
  // is up, so a session auto-starts its dev stack with zero manual steps. Best
  // effort: a failure here never affects the agent runtime. Output → a log file
  // the agent/user can tail.
  void resolveSandboxOnBoot(cfg)
    .then((onBoot) => {
      if (!onBoot) return
      const logPath = '/var/log/kortix-on-boot.log'
      logger.info('[boot] running [sandbox] on_boot command', { onBoot, logPath })
      try {
        mkdirSync(dirname(logPath), { recursive: true })
      } catch {}
      const out = openSync(logPath, 'a')
      const child = spawn('bash', ['-lc', onBoot], {
        cwd: cfg.projectTarget,
        env: process.env,
        detached: true,
        stdio: ['ignore', out, out],
      })
      child.on('error', (err) =>
        logger.warn('[boot] on_boot command failed to spawn', { err: (err as Error).message }),
      )
      child.unref()
    })
    .catch((err) => logger.warn('[boot] on_boot resolution failed', { err: (err as Error).message }))

  void startSessionRuntime(opencode, cfg, bootState, bootMark)
}

// Post-opencode session runtime: create the initial opencode session (when a
// prompt/bootstrap was requested) and start the question-relay event loop.
// Extracted verbatim from the former inline block so the warm-pool claim path
// reuses the EXACT same logic after a pooled spare adopts a claimant's session.
async function startSessionRuntime(
  opencode: ReturnType<typeof createOpencodeSupervisor>,
  cfg: Config,
  bootState: SandboxBootState,
  bootMark: (label: string) => void,
): Promise<void> {
  const onQuestionAsked = (req: QuestionRequest) => {
    void relayQuestionToApi(req, cfg).catch((err) =>
      logger.warn('[opencode-events] question relay failed', { err: (err as Error).message }),
    )
  }
  if (bootState.initialOpenCodeSessionRequired) {
    await maybeCreateInitialOpencodeSession(cfg.opencodeInternalPort, bootState, bootMark).catch((err) => {
      bootState.initialOpenCodeSessionError = err instanceof Error ? err.message : String(err)
      logger.warn('[boot] initial opencode session setup failed', err)
    })
    if (bootState.initialOpenCodeSessionId) {
      opencode.markReady()
      bootMark('opencode-ready')
      logger.info('[boot] opencode ready via initial session', { opencodePid: opencode.getPid(), timeline: bootState.timeline })
      startOpencodeEventLoop(opencode, cfg, { onQuestionAsked })
      return
    }
  }
  const ready = await waitForOpencodeReady(opencode, cfg.projectTarget)
  if (ready) {
    bootMark('opencode-ready')
    logger.info('[boot] opencode ready', { opencodePid: opencode.getPid(), timeline: bootState.timeline })
    startOpencodeEventLoop(opencode, cfg, { onQuestionAsked })
  } else {
    logger.warn('[boot] opencode did not become ready within deadline; supervisor still retrying', { opencodePid: opencode.getPid() })
  }
}

// Read KEY=VALUE lines from the per-session env file into process.env. The warm
// pool stages the claimant's session env there on claim (proven: PUT /files →
// writeFile lands), so a fresh loadConfig() resolves the claimant's KORTIX_*.
function reloadSessionEnv(path = '/etc/dnah-env'): void {
  let txt: string
  try { txt = readFileSync(path, 'utf8') } catch { return }
  for (const line of txt.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq <= 0) continue
    const k = t.slice(0, eq)
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) process.env[k] = t.slice(eq + 1)
  }
}

// Warm-pool spare runtime (opt-in via KORTIX_WARM_POOL=1, set only by the pool
// builder). Boot opencode generic (no repo) + the proxy so the VM is
// snapshottable + health-green, then idle until claimed. On claim the control
// plane writes the claimant's env to the session-env file; we DETECT it by
// polling (robust to a snapshot-restored process missing a signal), then reload
// env, re-read config, clone the claimant's repo, and start the session runtime.
async function runPoolMode(
  cfg: Config,
  bootTime: number,
  bootState: SandboxBootState,
  bootMark: (label: string) => void,
  staticWeb: ReturnType<typeof startStaticWebServer>,
): Promise<void> {
  const projectEnv = createProjectEnvStore()
  writeAgentEnvFile(projectEnv)
  await ensureOpencodeConfigDeps(cfg.defaultOpencodeConfigDir).catch(() => {})
  const opencode = createOpencodeSupervisor(cfg, cfg.defaultOpencodeConfigDir, projectEnv)
  await opencode.start().catch((err) => logger.warn('[pool] opencode.start() rejected', { err: err instanceof Error ? err.message : String(err) }))
  bootMark('pool-opencode-spawned')
  const server = startProxy(cfg, opencode, bootTime, bootState, projectEnv, staticWeb.port)
  installShutdownHandlers(opencode, server, staticWeb)
  bootMark('pool-ready')
  logger.info('[pool] warm spare ready; awaiting claim', { timeline: bootState.timeline })

  let claimed = false
  const claim = (trigger: string) => {
    if (claimed) return
    claimed = true
    void (async () => {
      const t0 = Date.now()
      reloadSessionEnv()
      writeAgentEnvFile(createProjectEnvStore())
      const cfg2 = loadConfig()
      // Rebuild the proxy/control surface with the claimant's cfg — the spare
      // booted tokenless, so the auth gate would 503 every request otherwise.
      server.reload(cfg2)
      bootState.initialOpenCodeSessionRequired =
        (process.env.KORTIX_INITIAL_PROMPT ?? '').trim().length > 0 ||
        (process.env.KORTIX_BOOTSTRAP_OPENCODE_SESSION ?? '').trim() === '1'
      logger.info('[pool] claim — initializing session', { trigger, projectId: cfg2.projectId, autoClone: cfg2.autoClone })
      try { await configureGlobalGitIdentity(cfg2, OPENCODE_HOME) } catch {}
      try { await configureGitCredentialHelper(cfg2, OPENCODE_HOME) } catch {}
      if (cfg2.autoClone) {
        await materializeRepo(cfg2).catch((err) => {
          bootState.repoMaterializationError = err instanceof Error ? err.message : String(err)
          logger.error('[pool] repo materialization failed', err)
        })
        bootMark('claim-repo-materialized')
        if (!bootState.repoMaterializationError) await configureRepoCredentialHelper(cfg2, cfg2.projectTarget).catch(() => {})
      }
      await startSessionRuntime(opencode, cfg2, bootState, bootMark)
      logger.info('[pool] claim complete', { claimMs: Date.now() - t0, timeline: bootState.timeline })
    })()
  }
  process.on('SIGHUP', () => claim('sighup'))
  const poll = setInterval(() => {
    let txt = ''
    try { txt = readFileSync('/etc/dnah-env', 'utf8') } catch { return }
    if (/^KORTIX_API_URL=\S/m.test(txt)) { clearInterval(poll); claim('env-poll') }
  }, 1000)
}

async function maybeCreateInitialOpencodeSession(
  opencodePort: number,
  bootState: SandboxBootState,
  bootMark: (label: string) => void,
): Promise<void> {
  const prompt = (process.env.KORTIX_INITIAL_PROMPT ?? '').trim()
  const bootstrapSession = (process.env.KORTIX_BOOTSTRAP_OPENCODE_SESSION ?? '').trim() === '1'
  if (!prompt && !bootstrapSession) return

  const baseUrl = `http://127.0.0.1:${opencodePort}`
  const workspace = process.env.KORTIX_WORKSPACE || '/workspace'

  logger.info('[boot] creating initial opencode session', {
    bytes: prompt.length,
    hasPrompt: prompt.length > 0,
    workspace,
  })

  const sessionRes = await waitForInitialSessionCreate(baseUrl, workspace)
  const session = (await sessionRes.json()) as { id?: string }
  if (!session.id) throw new Error('opencode session create returned no id')

  if (!prompt) {
    try {
      mkdirSync(dirname(OPENCODE_SESSION_PIN_PATH), { recursive: true })
      writeFileSync(OPENCODE_SESSION_PIN_PATH, session.id, 'utf8')
    } catch (err) {
      logger.warn('[boot] failed to pin opencode session id', err)
    }
    bootState.initialOpenCodeSessionId = session.id
    bootMark('opencode-session-created')
    logger.info('[boot] initial opencode session created', { sessionId: session.id })
    return
  }

  const model = resolveOpencodeModel()
  const promptRes = await fetch(
    `${baseUrl}/session/${session.id}/prompt_async?directory=${encodeURIComponent(workspace)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        parts: [{ type: 'text', text: prompt }],
        ...(model ? { model } : {}),
      }),
      signal: AbortSignal.timeout(15_000),
    },
  )
  if (!promptRes.ok) {
    throw new Error(`opencode prompt failed: ${promptRes.status} ${await promptRes.text()}`)
  }
  try {
    mkdirSync(dirname(OPENCODE_SESSION_PIN_PATH), { recursive: true })
    writeFileSync(OPENCODE_SESSION_PIN_PATH, session.id, 'utf8')
  } catch (err) {
    logger.warn('[boot] failed to pin opencode session id', err)
  }
  bootState.initialOpenCodeSessionId = session.id
  bootMark('opencode-session-created')
  logger.info('[boot] initial prompt delivered', { sessionId: session.id })
}

async function waitForInitialSessionCreate(baseUrl: string, workspace: string): Promise<Response> {
  const url = `${baseUrl}/session?directory=${encodeURIComponent(workspace)}`
  const deadline = Date.now() + 20_000
  let lastError = 'opencode session create timed out'
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(1_000),
      })
      if (res.ok) return res
      const body = await res.text().catch(() => '')
      lastError = `opencode session create failed: ${res.status} ${body}`
      if (res.status >= 400 && res.status < 500 && res.status !== 404) break
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
    }
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(lastError)
}

// Relay an opencode question.asked event to apps/api. apps/api blocks until
// the user submits the Slack form, returns the captured `answers: string[][]`.
// We then POST those answers to opencode's /question/{id}/reply so the agent
// resumes naturally — same flow the dashboard uses, just over Slack.
async function relayQuestionToApi(req: QuestionRequest, cfg: Config): Promise<void> {
  const projectId = process.env.KORTIX_PROJECT_ID?.trim()
  const sessionId = process.env.KORTIX_SESSION_ID?.trim()
  const token = (process.env.KORTIX_CLI_TOKEN || process.env.KORTIX_TOKEN || '').trim()
  const apiUrl = process.env.KORTIX_API_URL?.replace(/\/$/, '')
  if (!projectId || !sessionId || !token || !apiUrl) {
    logger.warn('[opencode-events] missing env to relay question', {
      hasProject: !!projectId, hasSession: !!sessionId, hasToken: !!token, hasApi: !!apiUrl,
    })
    return
  }
  const apiRoot = apiUrl.endsWith('/v1') ? apiUrl : `${apiUrl}/v1`
  const url = `${apiRoot}/projects/${encodeURIComponent(projectId)}/turn-question`
  logger.info('[opencode-events] relaying question.asked', {
    requestId: req.id, questions: req.questions.length,
  })
  let answers: string[][] | null = null
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        session_id: sessionId,
        request_id: req.id,
        opencode_session_id: req.sessionID,
        questions: req.questions,
      }),
      signal: AbortSignal.timeout(15 * 60_000),
    })
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300)
      logger.warn('[opencode-events] turn-question relay non-ok', { status: res.status, body })
      return
    }
    const data = (await res.json()) as { ok?: boolean; answers?: string[][] }
    if (!data.ok || !Array.isArray(data.answers)) {
      logger.warn('[opencode-events] turn-question malformed response', data)
      return
    }
    answers = data.answers
  } catch (err) {
    logger.warn('[opencode-events] turn-question fetch failed', { err: (err as Error).message })
    return
  }

  // Post the answers back into opencode so the question tool resumes.
  const replyUrl = `http://127.0.0.1:${cfg.opencodeInternalPort}/question/${encodeURIComponent(req.id)}/reply?directory=${encodeURIComponent(cfg.workspace)}`
  try {
    const r = await fetch(replyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!r.ok) {
      logger.warn('[opencode-events] opencode question.reply non-ok', {
        status: r.status, body: (await r.text()).slice(0, 300),
      })
      return
    }
    logger.info('[opencode-events] question replied to opencode', { requestId: req.id })
  } catch (err) {
    logger.warn('[opencode-events] opencode question.reply failed', { err: (err as Error).message })
  }
}

/** Per-session model override from KORTIX_OPENCODE_MODEL (provider/model form,
 *  e.g. `anthropic/claude-sonnet-4-6`). Returned in opencode's
 *  `{ providerID, modelID }` shape, or undefined when unset/malformed so
 *  opencode falls back to its configured default. */
export function resolveOpencodeModel(): { providerID: string; modelID: string } | undefined {
  const raw = (process.env.KORTIX_OPENCODE_MODEL ?? '').trim()
  const slash = raw.indexOf('/')
  if (slash <= 0 || slash === raw.length - 1) return undefined
  return { providerID: raw.slice(0, slash), modelID: raw.slice(slash + 1) }
}

/** Read the pinned opencode session id (set at boot when KORTIX_INITIAL_PROMPT
 *  was delivered). Returns null if no session was pinned — caller decides
 *  whether to fail or fall back to creating a fresh session. */
export function readPinnedOpencodeSessionId(): string | null {
  try {
    if (!existsSync(OPENCODE_SESSION_PIN_PATH)) return null
    const id = readFileSync(OPENCODE_SESSION_PIN_PATH, 'utf8').trim()
    return id.length > 0 ? id : null
  } catch {
    return null
  }
}

// Subcommand dispatch. The compiled binary is reused as a git credential
// helper (`kortix-agent git-credential get`) — git execs it when it needs a
// push/clone credential for the managed remote. Detect that mode before the
// daemon boot path so we don't spin up opencode/proxy just to print a token.
const subcommand = process.argv[2]
if (subcommand === 'git-credential') {
  runGitCredentialHelper(loadConfig(), process.argv[3])
    .then((code) => process.exit(code))
    .catch(() => process.exit(0))
} else {
  main().catch((err) => {
    logger.error('[boot] fatal', err)
    process.exit(1)
  })
}
