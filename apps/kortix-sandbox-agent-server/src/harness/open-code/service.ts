import { OPENCODE_HOME } from './paths'
import type { OpenCodeConfig as Config } from './config'
import type { ProjectEnvStore } from '../../project-env'
import type { HarnessDefinition, HarnessService } from '../harness'
import { loadOpenCodeEnvironment, requireOpenCodeConfig, resolveOpenCodeSkillDirectories } from './config'
import { createOpenCodeAssetsService } from './assets'
import { createOpenCodeProxyService } from './proxy'
import { createOpenCodeControlService } from './control'
import { createOpenCodeDiagnosticsService } from './diagnostics'
import { createOpenCodeQueryService } from './queries'
import { createOpenCodeQuickQueueInterrupt, startOpenCodeBackground } from './background'
import {
  startOpencodeEventLoop,
  type OpencodeEventHandlers,
  type OpencodeEventLoopOptions,
  type OpencodeEventSubscription,
} from './events'
import { createOpencodeLifecycle, type Opencode, type OpencodeLifecycleOptions } from './lifecycle'

/** Native reload semantics remain explicit; these are not universal promises. */
export type OpenCodeConfigurationService = Pick<
  Opencode,
  'reloadConfig' | 'reloadVerified' | 'reloadForWorkspace' | 'reconfigure'
>

export interface OpenCodeEventService {
  /**
   * Preserve native events, dispatch order, readiness and reconnect behavior.
   * Receive the current config at subscription time, including warm adoption.
   * Creating the service does not open a connection.
   */
  subscribe(
    cfg: Config,
    handlers: OpencodeEventHandlers,
    options?: OpencodeEventLoopOptions,
  ): OpencodeEventSubscription
}

export interface OpenCodeHarnessService extends HarnessService {
  readonly id: 'opencode'
  readonly configuration: OpenCodeConfigurationService
  readonly events: OpenCodeEventService
  /**
   * Adapter-internal lifecycle access. Not exposed by HarnessService, so host
   * consumers cannot bypass the boundary. No native operations are removed.
   */
  readonly native: Opencode
}

/** Create the OpenCode lifecycle and compose every service over it. */
export function createOpenCodeHarnessService(
  cfg: Config,
  opencodeConfigDir: string,
  projectEnv?: ProjectEnvStore,
  options: OpencodeLifecycleOptions = {},
): OpenCodeHarnessService {
  return composeOpenCodeHarnessService(cfg, createOpencodeLifecycle(cfg, opencodeConfigDir, projectEnv, options))
}

/**
 * Compose services over ONE lifecycle without changing startup behavior. The
 * daemon HTTP tests call this with a fake lifecycle, so a wiring change here
 * reaches every one of them.
 */
export function composeOpenCodeHarnessService(cfg: Config, lifecycle: Opencode): OpenCodeHarnessService {
  // One interrupt per service: control arms it, background delivers events to it.
  const quickQueue = createOpenCodeQuickQueueInterrupt(lifecycle, cfg)
  return {
    id: 'opencode',
    environment: { home: OPENCODE_HOME },
    proxy: createOpenCodeProxyService(lifecycle),
    control: createOpenCodeControlService(lifecycle, quickQueue),
    diagnostics: createOpenCodeDiagnosticsService(lifecycle),
    queries: createOpenCodeQueryService(lifecycle),
    background: { start: (currentCfg) => startOpenCodeBackground(lifecycle, requireOpenCodeConfig(currentCfg), quickQueue) },
    assets: createOpenCodeAssetsService({
      getInternalUrl: () => lifecycle.getInternalUrl(),
      restart: () => lifecycle.restart(),
      workspace: () => cfg.workspace,
    }),
    // Keep the method owner: restart/reload/reconfigure call sibling methods
    // through `this`. Copying unbound methods into separate objects breaks it.
    lifecycle,
    configuration: lifecycle,
    native: lifecycle,
    events: {
      subscribe: (currentCfg, handlers, eventOptions) =>
        startOpencodeEventLoop(lifecycle, currentCfg, handlers, eventOptions),
    },
  }
}

export const openCodeDefinition: HarnessDefinition = {
  id: 'opencode',
  assets: createOpenCodeAssetsService(),
  environment: {
    isInternalVariable: (name) => name.startsWith("OPENCODE_"),
    protectedPathSegments: ["/.local/share/opencode/"],
  },
  resolveSkillDirectories: (cfg) => resolveOpenCodeSkillDirectories(requireOpenCodeConfig(cfg)),
  loadConfig: loadOpenCodeEnvironment,
  createBootState: () => ({
    repoMaterializationError: null,
    timeline: [],
    initialOpenCodeSessionRequired: (process.env.KORTIX_BOOTSTRAP_OPENCODE_SESSION ?? '').trim() === '1',
    initialOpenCodeSessionId: null,
    initialOpenCodeSessionError: null,
  }),
  bootDetails: (cfg) => {
    const native = requireOpenCodeConfig(cfg)
    return {
      opencodeInternalPort: native.opencodeInternalPort,
      opencodeStandbyPort: native.opencodeStandbyPort,
    }
  },
  createService: (cfg, projectEnv, options) => {
    const native = requireOpenCodeConfig(cfg)
    return createOpenCodeHarnessService(native, native.defaultOpencodeConfigDir, projectEnv, options)
  },
  run: async (context) => (await import('./boot')).runOpenCode({ ...context, cfg: requireOpenCodeConfig(context.cfg) }),
  runWarmSeed: async (context) => (await import('./boot')).runOpenCodeWarmSeed({ ...context, cfg: requireOpenCodeConfig(context.cfg) }),
  installCompiledRuntime: async (cfg) => (await import('./compiled-runtime')).installCompiledRuntime(requireOpenCodeConfig(cfg)),
}
