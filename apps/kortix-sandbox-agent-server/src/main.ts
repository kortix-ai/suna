import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { loadConfig, resolveOpencodeConfigDir } from './config'
import { materializeRepo } from './git'
import { logger } from './logger'
import { createOpencodeSupervisor, waitForOpencodeReady } from './opencode'
import { startProxy } from './proxy'
import type { SandboxBootState } from './routes/health'
import { installShutdownHandlers } from './shutdown'

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
    autoClone: cfg.autoClone,
  })

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

  const opencode = createOpencodeSupervisor(cfg, opencodeConfigDir)

  // Start opencode in the background. It's non-fatal if it never becomes ready:
  // /kortix/health will report `opencode: starting` and the reverse proxy will
  // return 503 instead of crashing the daemon. This is what lets us boot
  // locally (where the opencode binary may be missing) for smoke tests.
  if (bootState.repoMaterializationError) {
    logger.warn('[boot] skipping opencode start because repo materialization failed')
  } else {
    await opencode.start()
  }

  const server = startProxy(cfg, opencode, bootTime, bootState)
  installShutdownHandlers(opencode, server)

  logger.info('[boot] proxy up; waiting for opencode readiness in background', {
    servicePort: cfg.servicePort,
  })

  if (bootState.repoMaterializationError) return

  void (async () => {
    const ready = await waitForOpencodeReady(opencode)
    if (ready) {
      logger.info('[boot] opencode ready', { opencodePid: opencode.getPid() })
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
