import type { Config } from '../config'
import { normalizeHarnessId } from '../config'
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
import { piDefinition } from './pi/service'

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
 * The daemon's only implementation-selection boundary.
 *
 * The id comes from `cfg.harness` (`KORTIX_HARNESS`, set by apps/api from the
 * manifest's `runtime:` field) unless a caller names one explicitly. OpenCode
 * stays the default; an unknown id fails the boot instead of booting something
 * else. Registering a harness is one line here plus its own folder.
 */
export function resolveHarness(cfg?: Pick<Config, 'harness'>, id?: string): HarnessDefinition {
  const selected = normalizeHarnessId(id ?? cfg?.harness)
  if (selected === 'opencode') return openCodeDefinition
  if (selected === 'pi') return piDefinition
  throw new Error(`Unsupported harness: ${selected}`)
}

/**
 * Image build only (`kortix-agent warm-pi-packages`): load the pi system
 * packages once so their extension cache ships in the image. Lives here because
 * only the resolver may reach into an adapter.
 */
export async function warmPiSystemPackages(agentDir?: string): Promise<{ loaded: string[]; failed: Array<{ name: string; error: string }> }> {
  const [{ warmSystemPackageCache }, { DEFAULT_PI_AGENT_DIR }] = await Promise.all([import('./pi/extensions/host'), import('./pi/config')])
  return warmSystemPackageCache(agentDir?.trim() || DEFAULT_PI_AGENT_DIR)
}
