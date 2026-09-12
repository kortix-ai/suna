import { OPENCODE_HOME } from './paths'
import type { OpenCodeConfig as Config } from './config'
import type { ProjectEnvStore } from '../../project-env'
import type { HarnessDefinition, HarnessService } from '../harness'
import { loadOpenCodeEnvironment, requireOpenCodeConfig, resolveOpenCodeSkillDirectories } from './config'
import { createOpenCodeAssetsService } from './assets'
import { createOpenCodeHttpService } from './http'
import { startOpenCodeBackground } from './background'
import {
  startOpencodeEventLoop,
  type OpencodeEventHandlers,
  type OpencodeEventLoopOptions,
  type OpencodeEventSubscription,
} from './events'
import { createOpencodeSupervisor, type Opencode, type OpencodeSupervisorOptions } from './supervisor'

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
   * Adapter-internal supervisor access. Not exposed by HarnessService, so host
   * consumers cannot bypass the boundary. No native operations are removed.
   */
  readonly native: Opencode
}

/** Compose services over ONE supervisor without changing startup behavior. */
export function createOpenCodeHarnessService(
  cfg: Config,
  opencodeConfigDir: string,
  projectEnv?: ProjectEnvStore,
  options: OpencodeSupervisorOptions = {},
): OpenCodeHarnessService {
  const supervisor = createOpencodeSupervisor(cfg, opencodeConfigDir, projectEnv, options)
  return {
    id: 'opencode',
    environment: { home: OPENCODE_HOME },
    http: createOpenCodeHttpService(supervisor),
    background: { start: (currentCfg) => startOpenCodeBackground(supervisor, requireOpenCodeConfig(currentCfg)) },
    assets: createOpenCodeAssetsService({
      getInternalUrl: () => supervisor.getInternalUrl(),
      restart: () => supervisor.restart(),
      workspace: () => cfg.workspace,
    }),
    // Keep the method owner: restart/reload/reconfigure call sibling methods
    // through `this`. Copying unbound methods into separate objects breaks it.
    lifecycle: supervisor,
    configuration: supervisor,
    native: supervisor,
    events: {
      subscribe: (currentCfg, handlers, eventOptions) =>
        startOpencodeEventLoop(supervisor, currentCfg, handlers, eventOptions),
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
