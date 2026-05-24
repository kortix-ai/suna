import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { loadConfig, resolveOpencodeConfigDir, type Config } from './config'
import { configureGlobalGitIdentity, materializeRepo } from './git'
import { logger } from './logger'
import { createOpencodeSupervisor, OPENCODE_HOME, waitForOpencodeReady } from './opencode'
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
  const bootState: SandboxBootState = { repoMaterializationError: null }
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

  try {
    await configureGlobalGitIdentity(cfg, OPENCODE_HOME)
  } catch (err) {
    logger.warn('[boot] default git identity setup failed', {
      err: err instanceof Error ? err.message : String(err),
    })
  }

  if (cfg.autoClone) {
    try {
      await materializeRepo(cfg)
    } catch (err) {
      // Keep the daemon up so /kortix/health can explain the boot failure,
      // but do not present OpenCode as usable against an empty workspace.
      bootState.repoMaterializationError = err instanceof Error ? err.message : String(err)
      logger.error('[boot] repo materialization failed', err)
    }
  }

  const opencodeConfigDir = await resolveOpencodeConfigDir(cfg)
  logger.info('[boot] resolved opencode config dir', { opencodeConfigDir })

  const projectEnv = createProjectEnvStore()
  const opencode = createOpencodeSupervisor(cfg, opencodeConfigDir, projectEnv)

  // Start opencode in the background. It's non-fatal if it never becomes ready:
  // /kortix/health will report `opencode: starting` and the reverse proxy will
  // return 503 instead of crashing the daemon. This is what lets us boot
  // locally (where the opencode binary may be missing) for smoke tests.
  if (bootState.repoMaterializationError) {
    logger.warn('[boot] skipping opencode start because repo materialization failed')
  } else {
    await opencode.start()
  }

  const server = startProxy(cfg, opencode, bootTime, bootState, projectEnv, staticWeb.port)
  installShutdownHandlers(opencode, server, staticWeb)

  logger.info('[boot] proxy up; waiting for opencode readiness in background', {
    servicePort: cfg.servicePort,
  })

  if (bootState.repoMaterializationError) return

  void (async () => {
    const ready = await waitForOpencodeReady(opencode)
    if (ready) {
      logger.info('[boot] opencode ready', { opencodePid: opencode.getPid() })
      startOpencodeEventLoop(opencode, cfg, {
        onQuestionAsked: (req) => {
          void relayQuestionToApi(req, cfg).catch((err) =>
            logger.warn('[opencode-events] question relay failed', { err: (err as Error).message }),
          )
        },
      })
      await maybeDeliverInitialPrompt(cfg.opencodeInternalPort).catch((err) => {
        logger.warn('[boot] initial prompt delivery failed', err)
      })
    } else {
      logger.warn('[boot] opencode did not become ready within deadline; supervisor still retrying', {
        opencodePid: opencode.getPid(),
      })
    }
  })()
}

async function maybeDeliverInitialPrompt(opencodePort: number): Promise<void> {
  const prompt = (process.env.KORTIX_INITIAL_PROMPT ?? '').trim()
  if (!prompt) return

  const baseUrl = `http://127.0.0.1:${opencodePort}`
  const workspace = process.env.KORTIX_WORKSPACE || '/workspace'

  logger.info('[boot] delivering KORTIX_INITIAL_PROMPT to opencode', {
    bytes: prompt.length,
    workspace,
  })

  const sessionRes = await fetch(`${baseUrl}/session?directory=${encodeURIComponent(workspace)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(15_000),
  })
  if (!sessionRes.ok) {
    throw new Error(`opencode session create failed: ${sessionRes.status} ${await sessionRes.text()}`)
  }
  const session = (await sessionRes.json()) as { id?: string }
  if (!session.id) throw new Error('opencode session create returned no id')

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
  logger.info('[boot] initial prompt delivered', { sessionId: session.id })
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

main().catch((err) => {
  logger.error('[boot] fatal', err)
  process.exit(1)
})
