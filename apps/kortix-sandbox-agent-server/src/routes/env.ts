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
  // Gateway-only: the provider-key names opencode must never see. Flipped with the
  // mode so a live toggle to DIRECT clears it (native BYOK keys reach opencode) and
  // a toggle to GATEWAY restores the strip on the next opencode restart.
  'KORTIX_OPENCODE_DENY_ENV',
])

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

function applyLlmGatewayMode(enabled: unknown, baseUrl: unknown, denyEnv: unknown): { changed: boolean; names: string[] } {
  if (enabled === undefined) return { changed: false, names: [] }
  if (typeof enabled !== 'boolean') throw new Error('llmGatewayEnabled must be a boolean')
  if (!enabled) {
    return setOpencodeRuntimeEnv({
      KORTIX_LLM_API_KEY: null,
      KORTIX_LLM_BASE_URL: null,
      // DIRECT/BYOK: stop withholding native provider keys from opencode.
      KORTIX_OPENCODE_DENY_ENV: null,
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
    // GATEWAY: restore the strip (names supplied by the API) on the next restart.
    KORTIX_OPENCODE_DENY_ENV: typeof denyEnv === 'string' ? denyEnv : '',
  })
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
          llmGatewayDenyEnv?: unknown
        } | null

        if (!body || typeof body.revision !== 'string') {
          return c.json({ error: 'revision is required' }, 400)
        }
        if (!body.env || typeof body.env !== 'object' || Array.isArray(body.env)) {
          return c.json({ error: 'env object is required' }, 400)
        }

        const result = projectEnv.apply({
          revision: body.revision,
          env: body.env as Record<string, unknown>,
          names: body.names,
        })
        const opencodeEnv = applyOpencodeRuntimeEnv(body.opencodeEnv)
        const llmGatewayEnv = applyLlmGatewayMode(body.llmGatewayEnabled, body.llmGatewayBaseUrl, body.llmGatewayDenyEnv)
        const opencodeEnvChanged = opencodeEnv.changed || llmGatewayEnv.changed
        const opencodeEnvNames = [...new Set([...opencodeEnv.names, ...llmGatewayEnv.names])].sort()

        if (result.changed) {
          logger.info('[env] project env changed; refreshing live agent env file', {
            revision: result.revision,
            names: result.names.length,
          })
          writeAgentEnvFile(projectEnv)
        }
        if (body.refreshModels === true && (result.changed || opencodeEnvChanged)) {
          logger.info('[env] model-affecting env changed; restarting opencode', {
            projectRevision: result.revision,
            projectEnvChanged: result.changed,
            opencodeEnvNames,
          })
          await opencode.restart()
        }

        return c.json({
          ok: true,
          changed: result.changed,
          revision: result.revision,
          names: result.names,
          opencode_env_changed: opencodeEnvChanged,
          opencode_env_names: opencodeEnvNames,
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
