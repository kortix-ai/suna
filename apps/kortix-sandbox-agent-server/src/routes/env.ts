import { Hono } from 'hono'

import { writeAgentEnvFile } from '../agent-env-file'
import type { Config } from '../config'
import { KORTIX_USER_CONTEXT_HEADER } from '../kortix-user-context'
import { logger } from '../logger'
import type { Opencode } from '../opencode'
import type { ProjectEnvStore } from '../project-env'

const OPENCODE_RUNTIME_ENV_NAMES = new Set([
  'KORTIX_LLM_API_KEY',
  'KORTIX_LLM_BASE_URL',
  'KORTIX_YOLO_API_KEY',
  'KORTIX_YOLO_URL',
])

// opencode's config-default model. A change is model-affecting: the respawned
// opencode bakes it as its config `model`/`small_model` default (see
// buildOpencodeConfigContent in opencode.ts), so changing it triggers a reload.
const OPENCODE_DEFAULT_MODEL_ENV = 'KORTIX_DEFAULT_MODEL'

// BYOK provider-key env name → opencode (models.dev) provider id. A provider
// apiKey delivered via config (`provider.<id>.options.apiKey`) is mergeDeep'd
// onto the models.dev catalog, lighting up that provider + its full model list —
// so we can apply an ADDED/CHANGED key to the RUNNING opencode via PATCH /config
// with no restart. Google's one provider has three accepted key names (the API
// aliases the value across all three), all mapping to `google`.
const PROVIDER_KEY_ENV_TO_ID: Record<string, string> = {
  ANTHROPIC_API_KEY: 'anthropic',
  OPENAI_API_KEY: 'openai',
  OPENROUTER_API_KEY: 'openrouter',
  GEMINI_API_KEY: 'google',
  GOOGLE_GENERATIVE_AI_API_KEY: 'google',
  GOOGLE_API_KEY: 'google',
  GROQ_API_KEY: 'groq',
  XAI_API_KEY: 'xai',
  DEEPSEEK_API_KEY: 'deepseek',
}

// Subscription auth blobs (materialized into opencode's auth.json at spawn, not
// expressible as a config provider apiKey). A change to one needs a respawn.
const AUTH_BLOB_ENV_NAMES = ['CODEX_AUTH_JSON', 'OPENCODE_AUTH_JSON'] as const

// Build the `provider.<id>.options.apiKey` config delta for every known BYOK key
// PRESENT (non-empty) in the env snapshot. PATCH mergeDeep is additive, so this
// applies an added/changed key inflight; the managed `kortix` provider block is
// omitted (left intact by the merge). A removed key can't be expressed here (see
// the restart fallback in the handler).
function buildProviderApiKeyDelta(env: Record<string, string>): Record<string, unknown> {
  const providers: Record<string, { options: { apiKey: string } }> = {}
  for (const [name, id] of Object.entries(PROVIDER_KEY_ENV_TO_ID)) {
    const value = env[name]
    if (typeof value === 'string' && value.length > 0) {
      providers[id] = { options: { apiKey: value } }
    }
  }
  return providers
}

function bearerToken(header: string | undefined): string | null {
  if (!header?.startsWith('Bearer ')) return null
  return header.slice('Bearer '.length).trim() || null
}

function applyOpencodeRuntimeEnv(input: unknown): { changed: boolean; names: string[] } {
  if (input === undefined) return { changed: false, names: [] }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('opencodeEnv must be an object')
  }

  const changedNames: string[] = []
  for (const [rawName, rawValue] of Object.entries(input as Record<string, unknown>)) {
    const name = rawName.trim().toUpperCase()
    if (!OPENCODE_RUNTIME_ENV_NAMES.has(name)) continue
    if (rawValue === null) {
      if (process.env[name] !== undefined) {
        delete process.env[name]
        changedNames.push(name)
      }
      continue
    }
    if (typeof rawValue !== 'string') continue
    if (process.env[name] !== rawValue) {
      process.env[name] = rawValue
      changedNames.push(name)
    }
  }

  return { changed: changedNames.length > 0, names: changedNames.sort() }
}

function setOpencodeRuntimeEnv(next: Record<string, string | null>): { changed: boolean; names: string[] } {
  const changedNames: string[] = []
  for (const [name, value] of Object.entries(next)) {
    if (!OPENCODE_RUNTIME_ENV_NAMES.has(name)) continue
    if (value === null) {
      if (process.env[name] !== undefined) {
        delete process.env[name]
        changedNames.push(name)
      }
      continue
    }
    if (process.env[name] !== value) {
      process.env[name] = value
      changedNames.push(name)
    }
  }
  return { changed: changedNames.length > 0, names: changedNames.sort() }
}

function applyLlmGatewayMode(enabled: unknown, baseUrl: unknown): { changed: boolean; names: string[] } {
  if (enabled === undefined) return { changed: false, names: [] }
  if (typeof enabled !== 'boolean') throw new Error('llmGatewayEnabled must be a boolean')
  if (!enabled) {
    return setOpencodeRuntimeEnv({
      KORTIX_LLM_API_KEY: null,
      KORTIX_LLM_BASE_URL: null,
      KORTIX_YOLO_API_KEY: null,
      KORTIX_YOLO_URL: null,
    })
  }
  if (typeof baseUrl !== 'string' || !baseUrl.trim()) {
    throw new Error('llmGatewayBaseUrl is required when llmGatewayEnabled is true')
  }
  const token = process.env.KORTIX_EXECUTOR_TOKEN || process.env.KORTIX_CLI_TOKEN
  if (!token) {
    throw new Error('KORTIX_EXECUTOR_TOKEN is unavailable; cannot enable LLM gateway in this running sandbox')
  }
  return setOpencodeRuntimeEnv({
    KORTIX_LLM_API_KEY: token,
    KORTIX_LLM_BASE_URL: baseUrl,
    KORTIX_YOLO_API_KEY: token,
    KORTIX_YOLO_URL: baseUrl,
  })
}

// Apply an optional default-model override onto the daemon's own env so the next
// opencode (re)spawn bakes it as opencode's config `model`/`small_model` default.
// `null`/empty clears the override (opencode falls back to its baked default).
function applyDefaultModel(input: unknown): { changed: boolean } {
  if (input === undefined) return { changed: false }
  if (input === null || (typeof input === 'string' && input.trim() === '')) {
    if (process.env[OPENCODE_DEFAULT_MODEL_ENV] !== undefined) {
      delete process.env[OPENCODE_DEFAULT_MODEL_ENV]
      return { changed: true }
    }
    return { changed: false }
  }
  if (typeof input !== 'string') throw new Error('defaultModel must be a string')
  const next = input.trim()
  if (process.env[OPENCODE_DEFAULT_MODEL_ENV] !== next) {
    process.env[OPENCODE_DEFAULT_MODEL_ENV] = next
    return { changed: true }
  }
  return { changed: false }
}

export function createEnvRouter(cfg: Config, opencode: Opencode, projectEnv: ProjectEnvStore): Hono {
  const router = new Hono()
  let syncInFlight: Promise<Response> | null = null

  router.post('/', async (c) => {
    if (!cfg.sandboxToken) {
      return c.json({ error: 'daemon not configured', detail: 'KORTIX_TOKEN unset' }, 503)
    }
    if (bearerToken(c.req.header('Authorization')) !== cfg.sandboxToken) {
      return c.json({ error: 'unauthorized' }, 401)
    }
    // Defense in depth: this is a server-to-server control endpoint. The API's
    // postEnvToDaemon never sends a user-context header; the user-facing /v1/p
    // proxy always does. So a present user-context header means this arrived via
    // the proxy (which should already block /kortix/env) — refuse it.
    if (c.req.header(KORTIX_USER_CONTEXT_HEADER)) {
      logger.warn('[env] rejecting /kortix/env carrying user-context header')
      return c.json({ error: 'forbidden' }, 403)
    }
    if (syncInFlight) {
      return c.json({ error: 'env sync already running' }, 409)
    }

    syncInFlight = (async () => {
      try {
        const body = await c.req.json().catch(() => null) as {
          revision?: unknown
          env?: unknown
          names?: unknown
          refreshModels?: unknown
          opencodeEnv?: unknown
          llmGatewayEnabled?: unknown
          llmGatewayBaseUrl?: unknown
          defaultModel?: unknown
          sessionId?: unknown
        } | null

        if (!body || typeof body.revision !== 'string') {
          return c.json({ error: 'revision is required' }, 400)
        }
        if (!body.env || typeof body.env !== 'object' || Array.isArray(body.env)) {
          return c.json({ error: 'env object is required' }, 400)
        }

        const before = projectEnv.snapshot()
        const result = projectEnv.apply({
          revision: body.revision,
          env: body.env as Record<string, unknown>,
          names: body.names,
        })
        const after = projectEnv.snapshot()
        const opencodeEnv = applyOpencodeRuntimeEnv(body.opencodeEnv)
        const llmGatewayEnv = applyLlmGatewayMode(body.llmGatewayEnabled, body.llmGatewayBaseUrl)
        const defaultModel = applyDefaultModel(body.defaultModel)
        const opencodeEnvChanged = opencodeEnv.changed || llmGatewayEnv.changed
        const opencodeEnvNames = [...new Set([...opencodeEnv.names, ...llmGatewayEnv.names])].sort()
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : undefined

        if (result.changed) {
          logger.info('[env] project env changed; refreshing live agent env file', {
            revision: result.revision,
            names: result.names.length,
          })
          writeAgentEnvFile(projectEnv)
        }
        // Model-affecting change → make opencode pick up the new provider key(s)
        // / default model. PREFER opencode's native inflight reload: PATCH /config
        // mergeDeeps a config delta onto the RUNNING instance and rebuilds its
        // provider state on the next request — a config-delivered provider apiKey
        // lights up that provider + its full model list with NO process restart
        // and no dropped session. opencode's env is frozen at spawn, so a key
        // delivered ONLY via env stays invisible to the running process; routing
        // the change through config is what makes it inflight-reloadable. The
        // spawn-time env delivery (P2) is unchanged and still seeds cold boots.
        //
        // FALL BACK to a full restart() when the change can't be expressed as a
        // mergeDeep PATCH: a managed-gateway runtime-env change (the `kortix`
        // provider block + baked catalog rebuild at spawn), a REMOVED provider key
        // or CLEARED default model (mergeDeep can't unset), a subscription auth
        // blob change (auth.json is materialized at spawn), an empty delta, or a
        // failed/unreachable PATCH. The user accepts the under-the-hood restart.
        let reload: 'none' | 'config' | 'restart' = 'none'
        const modelAffectingChanged =
          (body.refreshModels === true && (result.changed || opencodeEnvChanged)) ||
          defaultModel.changed
        if (modelAffectingChanged) {
          const removedProviderKey = Object.keys(PROVIDER_KEY_ENV_TO_ID).some(
            (name) => !!before.env[name] && !after.env[name],
          )
          const authBlobChanged = AUTH_BLOB_ENV_NAMES.some(
            (name) => before.env[name] !== after.env[name],
          )
          const defaultModelCleared =
            defaultModel.changed && process.env[OPENCODE_DEFAULT_MODEL_ENV] === undefined

          const delta: Record<string, unknown> = {}
          const providers = buildProviderApiKeyDelta(after.env)
          if (Object.keys(providers).length > 0) delta.provider = providers
          if (defaultModel.changed && process.env[OPENCODE_DEFAULT_MODEL_ENV]) {
            delta.model = process.env[OPENCODE_DEFAULT_MODEL_ENV]
          }

          const mustRestart =
            opencodeEnvChanged ||
            removedProviderKey ||
            authBlobChanged ||
            defaultModelCleared ||
            Object.keys(delta).length === 0

          if (!mustRestart && (await opencode.reloadConfig(delta))) {
            reload = 'config'
          } else {
            await opencode.restart()
            reload = 'restart'
          }
          logger.info('[env] model-affecting env changed', {
            reload,
            projectRevision: result.revision,
            projectEnvChanged: result.changed,
            opencodeEnvNames,
            providerIds: Object.keys(buildProviderApiKeyDelta(after.env)),
            defaultModelChanged: defaultModel.changed,
            sessionId,
          })
        }

        return c.json({
          ok: true,
          changed: result.changed,
          revision: result.revision,
          names: result.names,
          opencode_env_changed: opencodeEnvChanged,
          opencode_env_names: opencodeEnvNames,
          default_model_changed: defaultModel.changed,
          reload,
          opencode: opencode.getState(),
          opencode_pid: opencode.getPid(),
        })
      } catch (err) {
        const message = (err as Error).message || 'env sync failed'
        logger.error('[env] sync failed', err)
        return c.json({ error: 'env sync failed', message }, 500)
      } finally {
        syncInFlight = null
      }
    })()

    return syncInFlight
  })

  return router
}
