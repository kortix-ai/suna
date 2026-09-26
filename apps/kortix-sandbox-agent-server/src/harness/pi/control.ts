/**
 * Control operations for a pi session: live environment apply, repository
 * refresh, abort. The host-level steps (project env store, agent env file,
 * egress shim, LLM gateway mode) are the same ones the OpenCode adapter runs;
 * the harness-specific part is trivially cheaper — pi re-reads its settings in
 * place, there is no process to restart and no turn to interrupt.
 */
import { writeAgentEnvFile } from '../../agent-env-file'
import { syncEgressShim } from '../../egress-shim'
import { refreshRepo, syncWorkspaceToBase } from '../../git'
import { llmProxyBaseUrl, setLlmProxyToken } from '../../llm-proxy'
import { logger } from '../../logger'
import { reconcileProjectEnv } from '../../project-env'
import { scheduleRuntimeAssetsReconcile } from '../../runtime-assets'
import type { HarnessControlOperations, HarnessControlService, HarnessEnvironmentInput, HarnessRefreshInput } from '../control'
import type { PiRuntime } from './runtime'

/** The session-runtime values a live `POST /kortix/env` may move. Same allowlist as OpenCode's. */
const RUNTIME_ENV_NAMES = new Set([
  'KORTIX_LLM_BASE_URL',
  'KORTIX_LLM_PROXY_URL',
  'KORTIX_OPENCODE_MODEL',
  'KORTIX_CONNECTORS_MCP_ENABLED',
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

function applyRuntimeEnv(input: unknown): { changed: boolean; names: string[] } {
  if (input === undefined) return { changed: false, names: [] }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('opencodeEnv must be an object')
  const next: Record<string, string | null> = {}
  for (const [name, value] of Object.entries(input as Record<string, unknown>)) {
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

export function createPiControlService(runtime: () => PiRuntime | null, onStateChanged: () => void): HarnessControlService {
  return {
    bind(context): HarnessControlOperations {
      const { cfg, projectEnv, agentEnvFile } = context
      return {
        async applyEnvironment(body: HarnessEnvironmentInput) {
          if (!projectEnv) throw new Error('project env store is unavailable')
          const result = projectEnv.apply({ revision: body.revision, env: body.env as Record<string, unknown>, names: body.names })
          reconcileProjectEnv(process.env, projectEnv)
          const runtimeEnv = applyRuntimeEnv(body.runtimeEnv)
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
            opencode_env_changed: runtimeEnvChanged,
            opencode_env_names: runtimeEnvNames,
            opencode: rt?.getState() ?? 'down',
            opencode_pid: null,
            opencode_reload: reload,
            opencode_turn_ended: reload ? false : null,
          }
        },
        async refresh({ syncBase, baseSha }: HarnessRefreshInput) {
          const repo = syncBase ? await syncWorkspaceToBase(cfg, baseSha) : await refreshRepo(cfg)
          const rt = runtime()
          // Skills live in the working tree: a pull can change them. The
          // config dir sync OpenCode does here has no pi analogue (no config dir).
          if (rt) await rt.reloadSkills().catch((err) => logger.warn('[refresh] pi skill reload failed', { err: (err as Error).message }))
          if (rt?.getState() === 'ok') scheduleRuntimeAssetsReconcile(cfg)
          return {
            ok: true,
            repo: { before: repo.before, after: repo.after },
            opencode: rt?.getState() ?? 'down',
            opencode_pid: null,
          }
        },
        async abort() {
          const rt = runtime()
          if (!rt) return { outcome: 'not-pinned', body: { ok: false, error: 'pi runtime is not started' } }
          await rt.abort()
          return { outcome: 'aborted', body: { ok: true, opencode_session_id: rt.rootId } }
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
