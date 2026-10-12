/**
 * Control operations for a pi session: live environment apply, repository
 * refresh, abort. The host-level steps (project env store, agent env file,
 * egress shim, LLM gateway mode) are the same ones the OpenCode adapter runs;
 * the harness-specific part is trivially cheaper — pi re-reads its settings in
 * place, there is no process to restart and no turn to interrupt.
 */
import { writeAgentEnvFile } from '../shared/agent-env-file'
import { syncEgressShim } from '@/services/egress-shim'
import { readRepoInfo, refreshRepo, syncWorkspaceToBase } from '@/lib/git/git'
import { llmProxyBaseUrl, setLlmProxyToken } from '@/services/llm-proxy/llm-proxy'
import { logger } from '@/lib/log/logger'
import { reconcileProjectEnv } from '@/services/sandbox-env/project-env'
import { scheduleRuntimeAssetsReconcile } from '@/services/runtime-assets/runtime-assets'
import type { HarnessControlOperations, HarnessControlService, HarnessEnvironmentInput, HarnessRefreshInput } from '../contract/control'
import type { PiConfigReleases } from './config-release'
import type { PiRuntime } from './runtime'

/** A config release owns these while it runs; the next convergence delivers newer ones. */
const RELEASE_OWNED_ENV_NAMES = new Set(['KORTIX_COMPILED_AGENT_CONFIG', 'KORTIX_COMPILED_AGENT_CONFIG_ETAG'])

/** The session-runtime values a live `POST /kortix/env` may move. Same allowlist as OpenCode's. */
const RUNTIME_ENV_NAMES = new Set([
  'KORTIX_LLM_BASE_URL',
  'KORTIX_LLM_PROXY_URL',
  'KORTIX_MODEL',
  'KORTIX_COMPILED_AGENT_CONFIG',
  'KORTIX_COMPILED_AGENT_CONFIG_ETAG',
  'KORTIX_SECRET_CAPABILITIES',
])

function setRuntimeEnv(next: Record<string, string | null>): { changed: boolean; names: string[] } {
  const changed: string[] = []
  for (const [rawName, value] of Object.entries(next)) {
    const name = rawName.trim().toUpperCase()
    if (!RUNTIME_ENV_NAMES.has(name)) continue
    if (value === null) {
      if (process.env[name] !== undefined) {
        delete process.env[name]
        changed.push(name)
      }
      continue
    }
    if (process.env[name] !== value) {
      process.env[name] = value
      changed.push(name)
    }
  }
  return { changed: changed.length > 0, names: changed.sort() }
}

function applyRuntimeEnv(input: unknown, releaseOwned: boolean): { changed: boolean; names: string[] } {
  if (input === undefined) return { changed: false, names: [] }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('runtimeEnv must be an object')
  const next: Record<string, string | null> = {}
  for (const [name, value] of Object.entries(input as Record<string, unknown>)) {
    if (releaseOwned && RELEASE_OWNED_ENV_NAMES.has(name.trim().toUpperCase())) {
      logger.info('[env] compiled governance push ignored; the config release owns it', { name })
      continue
    }
    if (value === null || typeof value === 'string') next[name] = value
  }
  return setRuntimeEnv(next)
}

function applyLlmGatewayMode(enabled: unknown, baseUrl: unknown): { changed: boolean; names: string[] } {
  if (enabled === undefined) return { changed: false, names: [] }
  if (typeof enabled !== 'boolean') throw new Error('llmGatewayEnabled must be a boolean')
  if (!enabled) return setRuntimeEnv({ KORTIX_LLM_BASE_URL: null, KORTIX_LLM_PROXY_URL: null })
  if (typeof baseUrl !== 'string' || !baseUrl.trim()) throw new Error('llmGatewayBaseUrl is required when llmGatewayEnabled is true')
  const token = process.env.KORTIX_TOKEN
  if (!token) throw new Error('KORTIX_TOKEN is unavailable; cannot enable LLM gateway in this running sandbox')
  const proxyUrl = llmProxyBaseUrl()
  if (proxyUrl && process.env.KORTIX_LLM_PROXY_DISABLE !== '1') {
    setLlmProxyToken(token, baseUrl)
    return setRuntimeEnv({ KORTIX_LLM_BASE_URL: baseUrl, KORTIX_LLM_PROXY_URL: proxyUrl })
  }
  return setRuntimeEnv({ KORTIX_LLM_BASE_URL: baseUrl })
}

export function createPiControlService(
  runtime: () => PiRuntime | null,
  releases: PiConfigReleases,
  onStateChanged: () => void,
): HarnessControlService {
  return {
    convergenceInFlight: () => releases.inFlight(),
    bind(context): HarnessControlOperations {
      const { cfg, projectEnv, agentEnvFile } = context
      return {
        async applyEnvironment(body: HarnessEnvironmentInput) {
          if (!projectEnv) throw new Error('project env store is unavailable')
          const result = projectEnv.apply({ revision: body.revision, env: body.env as Record<string, unknown>, names: body.names })
          reconcileProjectEnv(process.env, projectEnv)
          const runtimeEnv = applyRuntimeEnv(body.runtimeEnv, releases.governanceOwned())
          const gatewayEnv = applyLlmGatewayMode(body.llmGatewayEnabled, body.llmGatewayBaseUrl)
          const runtimeEnvChanged = runtimeEnv.changed || gatewayEnv.changed
          const runtimeEnvNames = [...new Set([...runtimeEnv.names, ...gatewayEnv.names])].sort()
          const egressShim = await syncEgressShim().catch((err) => {
            logger.error('[env] egress shim sync failed', err)
            return { outcome: 'failed' as const, hosts: [] as readonly string[] }
          })
          const agentEnvWritten = writeAgentEnvFile(projectEnv, { sh: agentEnvFile })
          if (!agentEnvWritten) throw new Error('failed to write live agent env file')

          let reload: 'disposed' | null = null
          const rt = runtime()
          if (rt && body.refreshModels === true && (result.changed || runtimeEnvChanged)) {
            // In place: pi reads its model, agent config and gateway target
            // from the process env on the next turn. No respawn, no turn cut.
            const applied = await rt.reconfigure()
            reload = 'disposed'
            logger.info('[env] runtime env applied to pi in place', { runtimeEnvNames, changed: applied.changed })
          }
          onStateChanged()

          const applied = projectEnv.snapshot()
          const exported = Object.keys(applied.env).length
          return {
            ok: true,
            changed: result.changed,
            revision: result.revision,
            names: result.names,
            exported,
            managed: applied.knownNames.length,
            withheld: Math.max(0, applied.knownNames.length - exported),
            agent_env_written: agentEnvWritten,
            egress_shim: egressShim.outcome,
            egress_shim_hosts: egressShim.hosts,
            runtime_env_changed: runtimeEnvChanged,
            runtime_env_names: runtimeEnvNames,
            runtime: rt?.getState() ?? 'down',
            runtime_pid: null,
            runtime_reload: reload,
            runtime_turn_ended: reload ? false : null,
          }
        },
        async refresh({ syncBase, skipRepo, baseSha }: HarnessRefreshInput) {
          const repo = syncBase
            ? await syncWorkspaceToBase(cfg, baseSha)
            : skipRepo
              ? await unchangedRepo(cfg.projectTarget)
              : await refreshRepo(cfg)
          const rt = runtime()
          // Off the release path skills live in the working tree, and a pull can
          // change them. On it, reloading reads the same release again.
          if (rt) await rt.reloadSkills().catch((err) => logger.warn('[refresh] pi skill reload failed', { err: (err as Error).message }))
          if (rt?.getState() === 'ok') scheduleRuntimeAssetsReconcile(cfg)
          return {
            ok: true,
            repo: { before: repo.before, after: repo.after },
            runtime: rt?.getState() ?? 'down',
            runtime_pid: null,
          }
        },
        // Config releases (config-release.ts). The descriptor is always fetched
        // from the API; nothing here takes one as input.
        convergeConfig: (options) => releases.converge(runtime(), options),
        async abort() {
          const rt = runtime()
          if (!rt) return { outcome: 'not-pinned', body: { ok: false, error: 'pi runtime is not started' } }
          await rt.abort()
          return { outcome: 'aborted', body: { ok: true, runtime_session_id: rt.rootId } }
        },
        // Quick Queue. The runtime holds the turn and tool state in-process, so
        // there is nothing to poll: it aborts on its own `tool_execution_end`.
        async armAbortAfterTool(input) {
          runtime()?.armAbortAfterTool(input)
        },
        disarmAbortAfterTool(promptId) {
          runtime()?.disarmAbortAfterTool(promptId)
        },
      }
    },
  }
}

/** `repo=0`: report the checkout as it is; nothing is fetched or pulled. */
async function unchangedRepo(projectTarget: string) {
  const info = await readRepoInfo(projectTarget)
  if (!info) throw new Error('project repo is not materialized')
  return { before: info, after: info }
}
