/**
 * The pi harness definition and service composition.
 *
 * This module is imported by the resolver for EVERY boot, so it stays light:
 * pi itself loads inside `PiRuntime.start()` (runtime.ts), never here.
 */
import { homedir } from 'node:os'
import type { ProjectEnvStore } from '../../project-env'
import type { HarnessDefinition, HarnessService, HarnessStartupOptions } from '../harness'
import { isRepoMaterialized } from '../../git'
import { runtimeAssetsActivity } from '../../runtime-assets'
import { createPiAssetsService } from './assets'
import { startPiBackground } from './background'
import type { PiBootState } from './boot-state'
import { loadPiEnvironment, requirePiConfig, resolvePiSkillDirectories, type PiConfig } from './config'
import { createPiControlService } from './control'
import { createPiDiagnosticsService } from './diagnostics'
import { createPiQueryService } from './queries'
import { schedulePiProjectionPush } from './relay'
import { PiRuntime, type PiRuntimeHooks } from './runtime'
import { createPiSurface } from './surface'

export interface PiHarnessService extends HarnessService {
  readonly id: 'pi'
  /** The live runtime; null until `lifecycle.start()` resolved. */
  readonly runtime: () => PiRuntime | null
}

export function createPiHarnessService(
  cfg: PiConfig,
  projectEnv?: ProjectEnvStore,
  options: HarnessStartupOptions & { hooks?: PiRuntimeHooks; sessionId?: string; env?: NodeJS.ProcessEnv } = {},
): PiHarnessService {
  const env = options.env ?? process.env
  const sessionId = (options.sessionId ?? env.KORTIX_SESSION_ID ?? '').trim() || 'session-local'
  const runtime = new PiRuntime({ cfg, sessionId, projectEnv, hooks: options.hooks, env })
  let started = false
  const live = () => (started ? runtime : null)
  const surface = createPiSurface(live)
  const pushProjection = (reason: string) =>
    schedulePiProjectionPush(() => {
      const rt = live()
      if (!rt) return null
      const doc = rt.stateDoc()
      return { doc, etag: rt.stateEtag(doc) }
    }, reason)

  return {
    id: 'pi',
    runtime: live,
    environment: { home: homedir() },
    lifecycle: {
      async start() {
        await runtime.start()
        started = true
        options.onStartupMark?.('pi-ready')
      },
      async stop() {
        started = false
        await runtime.stop()
      },
      async restart() {
        await runtime.restart()
        started = true
      },
      getState: () => runtime.getState(),
    },
    proxy: {
      blockedPorts: () => [],
      async readiness({ cfg: current, bootState }) {
        const state: PiBootState = bootState
        const notReady = (reason: string, body: Record<string, unknown>) => ({
          ready: false as const,
          phase: [state.timeline.at(-1)?.label ?? 'boot', `pi=${runtime.getState()}`, runtimeAssetsActivity() ?? '', reason].filter(Boolean).join('|'),
          details: { error: 'sandbox runtime not ready', ...body },
        })
        if (state.repoMaterializationError) {
          return notReady('repo_materialization_failed', { reason: 'repo_materialization_failed', message: state.repoMaterializationError })
        }
        if (current.autoClone && !(await isRepoMaterialized(current.projectTarget))) return notReady('repo_not_materialized', { reason: 'repo_not_materialized' })
        if (state.workspaceReady === false) return notReady('workspace_not_ready', { reason: 'workspace_not_ready' })
        if (state.initialOpenCodeSessionError) {
          return notReady('initial_session_failed', { reason: 'initial_opencode_session_failed', message: state.initialOpenCodeSessionError })
        }
        if (state.initialOpenCodeSessionRequired && !state.initialOpenCodeSessionId) {
          return notReady('initial_session_pending', { reason: 'initial_opencode_session_pending' })
        }
        if (runtime.getState() !== 'ok' || !started) return notReady('pi_not_ready', { reason: 'pi_not_ready', opencode: runtime.getState() })
        return { ready: true }
      },
      forward: (input) => surface.handle(input),
    },
    control: createPiControlService(live, () => pushProjection('kortix-env-applied')),
    diagnostics: createPiDiagnosticsService(live),
    queries: createPiQueryService(live, surface),
    background: { start: (currentCfg) => startPiBackground(live, currentCfg) },
    assets: createPiAssetsService(),
  }
}

export const piDefinition: HarnessDefinition = {
  id: 'pi',
  assets: createPiAssetsService(),
  environment: {
    isInternalVariable: (name) => name.startsWith('KORTIX_PI_'),
    protectedPathSegments: [],
  },
  resolveSkillDirectories: async (cfg) => resolvePiSkillDirectories(cfg),
  loadConfig: loadPiEnvironment,
  createBootState: (): PiBootState => ({
    repoMaterializationError: null,
    timeline: [],
    initialOpenCodeSessionRequired: (process.env.KORTIX_BOOTSTRAP_OPENCODE_SESSION ?? '').trim() === '1',
    initialOpenCodeSessionId: null,
    initialOpenCodeSessionError: null,
  }),
  bootDetails: (cfg) => {
    const native = requirePiConfig(cfg)
    return { harness: 'pi', piModelMode: native.piModelMode, piStateDir: native.piStateDir }
  },
  createService: (cfg, projectEnv, options) => createPiHarnessService(requirePiConfig(cfg), projectEnv, options),
  run: async (context) => (await import('./boot')).runPi({ ...context, cfg: requirePiConfig(context.cfg) }),
  // pi has no separate binary to stage: the daemon IS the runtime.
  installCompiledRuntime: async () => ({ path: process.execPath }),
}
