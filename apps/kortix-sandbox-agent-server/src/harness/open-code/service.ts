import type { Config } from '../../config'
import type { ProjectEnvStore } from '../../project-env'
import type { HarnessService } from '../harness'
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
   * Compatibility port for existing native routes and boot operations. Retains
   * every supervisor feature, including workspace gates and binary prefetch.
   * Generic consumers use lifecycle; OpenCode-specific consumers stay explicit.
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
