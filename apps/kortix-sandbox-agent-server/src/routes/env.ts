import { Hono } from 'hono'

import { writeAgentEnvFile } from '../agent-env-file'
import type { Config } from '../config'
import { syncEgressShim } from '../egress-shim'
import { KORTIX_USER_CONTEXT_HEADER } from '../kortix-user-context'
import { logger } from '../logger'
import { requiresRespawn, type Opencode } from '../opencode'
import { reconcileProjectEnv, type ProjectEnvStore } from '../project-env'

const OPENCODE_RUNTIME_ENV_NAMES = new Set([
  'KORTIX_LLM_BASE_URL',
  // The session's model. opencode reads this when it builds its config at spawn
  // (opencode.ts), so accepting it here + restarting is what makes a mid-session
  // model change take effect on a box that is already up.
  'KORTIX_OPENCODE_MODEL',
  // Channel sessions can opt into the Connector MCP face after a deploy. This
  // must restart OpenCode because MCP servers are registered only at spawn.
  'KORTIX_CONNECTORS_MCP_ENABLED',
  // The server-compiled agent config (agents, prompts, permissions, model) —
  // apps/api's compile-agent-config.ts output.
  //
  // Until this was allowlisted it was the ONE piece of config with no way into
  // a running box. It is compiled from git once, at provision, and handed down
  // as an env var, so a restart re-read the daemon's unchanged env and rebuilt
  // the same stale bytes: `git pull` updated the working tree, the agent's
  // behaviour did not, and nothing short of a new session reconciled the two.
  // Same mechanism as the model above — accept it, then restart.
  'KORTIX_COMPILED_AGENT_CONFIG',
  // Its content hash, echoed by /kortix/health so a client can ask what this box
  // is really running. Pushed with the config; allowlisted so the two cannot
  // drift apart on a live update.
  'KORTIX_COMPILED_AGENT_CONFIG_ETAG',
  'KORTIX_SECRET_CAPABILITIES',
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

function applyLlmGatewayMode(enabled: unknown, baseUrl: unknown): { changed: boolean; names: string[] } {
  if (enabled === undefined) return { changed: false, names: [] }
  if (typeof enabled !== 'boolean') throw new Error('llmGatewayEnabled must be a boolean')
  if (!enabled) {
    return setOpencodeRuntimeEnv({
      KORTIX_LLM_BASE_URL: null,
    })
  }
  if (typeof baseUrl !== 'string' || !baseUrl.trim()) {
    throw new Error('llmGatewayBaseUrl is required when llmGatewayEnabled is true')
  }
  const token = process.env.KORTIX_TOKEN
  if (!token) {
    throw new Error('KORTIX_TOKEN is unavailable; cannot enable LLM gateway in this running sandbox')
  }
  return setOpencodeRuntimeEnv({
    KORTIX_LLM_BASE_URL: baseUrl,
  })
}

export function createEnvRouter(
  cfg: Config,
  opencode: Opencode,
  projectEnv: ProjectEnvStore,
  opts: { agentEnvFile?: string } = {},
): Hono {
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
        // PTYs and other daemon children inherit process.env directly. Keep it
        // aligned with the authoritative store so a new child cannot inherit a
        // revoked boot secret before it sources agent-env.sh.
        reconcileProjectEnv(process.env, projectEnv)
        const opencodeEnv = applyOpencodeRuntimeEnv(body.opencodeEnv)
        const llmGatewayEnv = applyLlmGatewayMode(body.llmGatewayEnabled, body.llmGatewayBaseUrl)
        // null when no reload was needed at all; otherwise how it was applied.
        let reloadOutcome: 'disposed' | 'restarted' | 'kept-old' | null = null
        // Whether applying the config interrupted work someone was waiting on.
        // null = no reload happened, or the box could not tell.
        let reloadTurnEnded: boolean | null = null
        const opencodeEnvChanged = opencodeEnv.changed || llmGatewayEnv.changed
        const opencodeEnvNames = [...new Set([...opencodeEnv.names, ...llmGatewayEnv.names])].sort()

        if (result.changed) {
          logger.info('[env] project env changed; refreshing live agent env file', {
            revision: result.revision,
            names: result.names.length,
          })
        }
        // The capability catalog applied just above is also what arms the
        // in-guest egress shim, and boundary rules can move on a LIVE box:
        // adding the session's first network-boundary secret has to start a
        // listener that boot decided this session did not need.
        //
        // Ordered exactly as boot and fork adoption order it — shim first, then
        // writeAgentEnvFile — because that file is how the proxy + CA variables
        // reach the agent's shells, and it is equally what CLEARS them when the
        // last boundary secret goes away.
        //
        // Not fatal, by the same rule the boot path follows: a listener that
        // will not come up is a boundary secret that will not work, not a
        // reason to drop the project secrets, model and gateway mode arriving
        // in the same body. Nothing further down consults the outcome — a
        // catalog change is already respawn-required (opencode.ts), so the
        // reload below picks the new proxy env up on its own.
        const egressShim = await syncEgressShim().catch((err) => {
          logger.error('[env] egress shim sync failed', err)
          return { outcome: 'failed' as const, hosts: [] as readonly string[] }
        })
        // Always rewrite the shell artifact, including an identical revision.
        // A warm-fork race can leave agent-env.sh stale while the in-memory
        // store already has the requested revision. A sync replay must repair it.
        const agentEnvWritten = writeAgentEnvFile(projectEnv, { sh: opts.agentEnvFile })
        if (!agentEnvWritten) throw new Error('failed to write live agent env file')
        if (body.refreshModels === true && (result.changed || opencodeEnvChanged)) {
          // reloadConfig, not restart: opencode re-reads its config file in
          // place via /global/dispose in ~51ms, against ~8s for a respawn
          // (measured on 1.17.11, dispose re-verified on the pinned 1.18.19).
          // It falls back to a restart on its
          // own if dispose is unavailable, so this is never less correct — only
          // faster, and it does not sever an in-flight turn when dispose wins.
          // Some values are consumed by `spawnChild` OUTSIDE the config file —
          // the deny-list shapes the child's env, and the Codex/OpenCode auth
          // secrets are materialized into ~/.local/share/opencode/auth.json. A
          // dispose re-reads the config file and touches neither, so it would
          // leave the OLD subscription credential on disk while reporting
          // success. That was a real regression from the dispose fast path:
          // connecting a ChatGPT account confirmed in the UI and the next turn
          // still ran on the account it replaced.
          //
          // Keyed on the value DELTA, not the allowlist — `result.names` is the
          // full set, so using it would respawn on every push for any project
          // that merely has one of these secrets.
          //
          // Project secrets (the `result.changedNames` half) shape the opencode
          // child's PROCESS env at spawn via `mergeProjectEnv` (opencode.ts) —
          // they are NOT in the config file a dispose re-reads. So any non-empty
          // `changedNames` means opencode's process env is stale and a dispose
          // would report success while the PID kept the old (e.g. 0/47) set. The
          // only correct reload for a project-secret delta is a full respawn.
          // The ~8s cost is the price of correctness; the dispose fast path is
          // preserved for pure model/auth/deny changes that touch no project
          // secret. Revocation is preserved too: `knownNames` is tracked in the
          // store, so a respawn clears a dropped secret via `mergeProjectEnv`.
          const projectSecretsMoved = result.changedNames.length > 0
          const mustRespawn = projectSecretsMoved || requiresRespawn(opencodeEnvNames)
          const applied = await opencode.reloadConfig({ mustRespawn })
          const how = applied.how
          reloadTurnEnded = applied.turnEnded
          // 'kept-old' means the verified swap declined: the new opencode never
          // came up, so the running one was left serving. The config did NOT
          // take, and the caller has to be told — logging it here and returning
          // ok:true would report a reload that silently did nothing.
          reloadOutcome = how
          logger.info('[env] config-affecting env changed; applied to opencode', {
            projectRevision: result.revision,
            projectEnvChanged: result.changed,
            opencodeEnvNames,
            how,
            mustRespawn,
          })
        }

        const applied = projectEnv.snapshot()
        const exported = Object.keys(applied.env).length
        logger.info('[env] project env applied', {
          revision: applied.revision,
          managed: applied.knownNames.length,
          current: applied.names.length,
          exported,
          withheld: Math.max(0, applied.knownNames.length - exported),
          agentEnvWritten,
          egressShim: egressShim.outcome,
        })

        return c.json({
          ok: true,
          changed: result.changed,
          revision: result.revision,
          names: result.names,
          exported,
          managed: applied.knownNames.length,
          withheld: Math.max(0, applied.knownNames.length - exported),
          agent_env_written: agentEnvWritten,
          // 'unchanged' | 'started' | 'restarted' | 'stopped' | 'failed'.
          // 'failed' is the one a caller must surface: the secret saved, the
          // catalog landed, and the credential still will not be injected.
          egress_shim: egressShim.outcome,
          egress_shim_hosts: egressShim.hosts,
          opencode_env_changed: opencodeEnvChanged,
          opencode_env_names: opencodeEnvNames,
          opencode: opencode.getState(),
          opencode_pid: opencode.getPid(),
          // 'disposed' | 'restarted' | 'kept-old' | null (no reload needed).
          // 'kept-old' is the verified swap declining a config that would not
          // boot — a successful safety outcome, and a FAILED reload.
          opencode_reload: reloadOutcome,
          opencode_turn_ended: reloadTurnEnded,
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
