import type { Hono } from 'hono'
import type { Config } from '../config'
import type { SandboxBootState } from '../boot-state'
import type { ProjectEnvStore } from '../project-env'
import type { ResourceMonitor } from '../resources'
import type { startStaticWebServer } from '../static-web'
import type { HarnessAssetsService } from './assets'
import { openCodeDefinition } from './open-code/service'

export type { OpenCodeAssetsCompatibilityResult as HarnessAssetsCompatibilityResult } from './open-code/assets'

export type HarnessState = 'starting' | 'ok' | 'down'

export interface HarnessLifecycleService {
  start(): Promise<void>
  stop(signal?: NodeJS.Signals): Promise<void>
  restart(): Promise<void>
  getState(): HarnessState
}

export interface HarnessHttpContext {
  cfg: Config
  bootTime: number
  bootState: SandboxBootState
  projectEnv?: ProjectEnvStore
  staticWebPort: number | null
  agentEnvFile?: string
  resources: () => ResourceMonitor | null
}

/** Adapter-owned compatibility routes preserve every native feature. */
export interface HarnessHttpService {
  mountControlRoutes(router: Hono, context: HarnessHttpContext): void
  mountFallback(app: Hono, context: HarnessHttpContext): void
  blockedPorts(cfg: Config): readonly number[]
}

export interface HarnessService {
  readonly id: string
  readonly environment: { readonly home: string }
  readonly lifecycle: HarnessLifecycleService
  readonly http: HarnessHttpService
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
