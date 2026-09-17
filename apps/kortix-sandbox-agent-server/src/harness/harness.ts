import type { Config } from '../config'
import type { SandboxBootState } from '../boot-state'
import type { ProjectEnvStore } from '../project-env'
import type { ResourceMonitor } from '../resources'
import type { startStaticWebServer } from '../static-web'
import type { HarnessAssetsService } from './assets'
import type { HarnessProxyService } from './proxy'
import type { HarnessControlService } from './control'
import type { HarnessDiagnosticsService } from './diagnostics'
import type { HarnessQueryFactory } from './queries'
import { openCodeDefinition } from './open-code/service'

import type { HarnessLifecycleService } from './lifecycle-contract'

export type { OpenCodeAssetsCompatibilityResult as HarnessAssetsCompatibilityResult } from './open-code/assets'
// The lifecycle port lives in a leaf module so adapters can import it without
// dragging this resolver (and the OpenCode definition) into their importers.
export type { HarnessLifecycleService, HarnessState } from './lifecycle-contract'

export interface HarnessService {
  readonly id: string
  readonly environment: { readonly home: string }
  readonly lifecycle: HarnessLifecycleService
  readonly proxy: HarnessProxyService
  readonly control: HarnessControlService
  readonly diagnostics: HarnessDiagnosticsService
  readonly queries: HarnessQueryFactory
  readonly background: { start(cfg: Config): ResourceMonitor }
  readonly assets: HarnessAssetsService
}

export interface HarnessBootContext {
  cfg: Config
  bootTime: number
  bootState: SandboxBootState
  bootMark: (label: string) => void
  staticWeb: ReturnType<typeof startStaticWebServer>
}

export interface HarnessStartupOptions {
  onStartupMark?: (label: string) => void
}

/** A definition is inert. Only run/createService execute the selected path. */
export interface HarnessDefinition {
  readonly id: string
  readonly assets: HarnessAssetsService
  readonly environment: {
    isInternalVariable(name: string): boolean
    readonly protectedPathSegments: readonly string[]
  }
  resolveSkillDirectories(cfg: Config): Promise<string[]>
  /** Extra flat configuration fields; each adapter owns their shape. */
  loadConfig(env: NodeJS.ProcessEnv): object
  createBootState(): SandboxBootState
  bootDetails(cfg: Config): Record<string, unknown>
  createService(cfg: Config, projectEnv?: ProjectEnvStore, options?: HarnessStartupOptions): HarnessService
  run(context: HarnessBootContext): Promise<void>
  runWarmSeed?(context: HarnessBootContext): Promise<boolean>
  installCompiledRuntime(cfg: Config): Promise<{ path: string }>
}

/**
 * The daemon's only implementation-selection boundary. Keep the existing
 * OpenCode default; this refactor introduces no environment/UI selector.
 * Future integrations register here without changing host consumers.
 */
export function resolveHarness(_cfg?: Config, id: string = 'opencode'): HarnessDefinition {
  if (id === 'opencode') return openCodeDefinition
  throw new Error(`Unsupported harness: ${id}`)
}
