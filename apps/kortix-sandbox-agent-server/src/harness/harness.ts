import type { Config } from '@/lib/config/config'
import { loadHostConfig } from '@/lib/config/config'
import type { SandboxBootState } from './contract/boot-state'
import type { ProjectEnvStore } from '@/services/sandbox-env/project-env'
import type { ResourceMonitor } from '@/services/resources/resources'
import type { DaemonServer, DaemonShutdown } from './contract/server'
import type { HarnessAssetsService } from '@/services/runtime-assets/port'
import type { HarnessProxyService } from './contract/proxy'
import type { HarnessControlService } from './contract/control'
import type { HarnessDiagnosticsService } from './contract/diagnostics'
import type { HarnessQueryFactory } from './contract/queries'
import type { HarnessTurnService } from './contract/turns'
import { openCodeDefinition } from './open-code/service'
import { piDefinition } from './pi/service'

import type { HarnessLifecycleService } from './contract/lifecycle-contract'

// The lifecycle port lives in a leaf module so adapters can import it without
// dragging this resolver (and the OpenCode definition) into their importers.
export type { HarnessLifecycleService, HarnessState } from './contract/lifecycle-contract'

export interface HarnessService {
  readonly id: string
  readonly environment: { readonly home: string }
  readonly lifecycle: HarnessLifecycleService
  readonly proxy: HarnessProxyService
  readonly control: HarnessControlService
  readonly diagnostics: HarnessDiagnosticsService
  readonly queries: HarnessQueryFactory
  readonly turns: HarnessTurnService
  readonly background: { start(cfg: Config): ResourceMonitor }
  readonly assets: HarnessAssetsService
}

export interface HarnessBootContext {
  cfg: Config
  bootTime: number
  bootState: SandboxBootState
  bootMark: (label: string) => void
  /**
   * Start the daemon's HTTP server for `harness` and install the signal
   * handlers that stop it. app/ builds this; an adapter's boot calls it once,
   * as soon as its service exists.
   */
  serve(harness: HarnessService, projectEnv: ProjectEnvStore): { server: DaemonServer; shutdown: DaemonShutdown }
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
}

/**
 * The daemon configuration: the selected adapter's fields, then the host's.
 * The host fields parse first, so the selector is read BEFORE the adapter loads
 * its own environment: only the selected adapter's contract applies to a boot.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const host = loadHostConfig(env)
  const definition = resolveHarness(host)
  return { ...definition.loadConfig(env), ...host, harness: definition.id }
}

/**
 * The daemon's only implementation-selection boundary.
 *
 * The id comes from `cfg.harness` (`KORTIX_HARNESS`, set by apps/api from the
 * manifest's `runtime:` field) unless a caller names one explicitly. OpenCode
 * stays the default; an unknown id fails the boot instead of booting something
 * else. Registering a harness is one line here plus its own folder.
 */
/** The harness an unset `KORTIX_HARNESS` selects. pi becomes the default in H4. */
const DEFAULT_HARNESS = 'opencode'

export function resolveHarness(cfg?: Pick<Config, 'harness'>, id?: string): HarnessDefinition {
  const selected = (id ?? cfg?.harness ?? '').trim().toLowerCase() || DEFAULT_HARNESS
  if (selected === 'opencode') return openCodeDefinition
  if (selected === 'pi') return piDefinition
  throw new Error(`Unsupported harness: ${selected}`)
}

/**
 * Every registered harness. Built on call, not at module load: the adapters
 * import this module back, so a module-level list could read a definition
 * before it is initialized.
 */
const registeredHarnesses = (): readonly HarnessDefinition[] => [openCodeDefinition, piDefinition]

/**
 * Paths the static web server refuses for every registered harness. Every
 * harness's, on every box: the image ships all of them, so a pi box still
 * holds OpenCode's data directory.
 */
export function harnessProtectedPathSegments(): string[] {
  return registeredHarnesses().flatMap((definition) => [...definition.environment.protectedPathSegments])
}

/** Is `name` internal to any registered harness? The agent env file never writes one. */
export function isHarnessInternalVariable(name: string): boolean {
  return registeredHarnesses().some((definition) => definition.environment.isInternalVariable(name))
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
