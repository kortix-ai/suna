/**
 * pi's own extension system, hosted around the runtime's `Agent`.
 *
 * pi-coding-agent's `AgentSession` owns everything an extension can touch:
 * the loader (npm/git/local packages, `pi` manifests, `.pi/extensions`), the
 * real `ExtensionRunner`, tool wrapping, `before_agent_start`/`input` on
 * prompt, `/skill:` and prompt-template expansion. Kortix keeps the `Agent`
 * (gateway model, tools, wire) and hands it to the session, so any package
 * from pi.dev runs unmodified — no per-extension code here.
 *
 * Packages come from two scopes, exactly pi's own:
 * - system (global): `<agentDir>/settings.json`, installed under `<agentDir>/npm`
 *   when the image is built (apps/sandbox/pi-system-packages.json);
 * - project: kortix.yaml `harnesses.pi.packages` (`KORTIX_PI_PACKAGES`); npm
 *   sources come from the API-built bundle (bundle.ts), unpacked outside the
 *   repo before the runtime starts; `./` paths are files in the repo.
 * A project pin of a package replaces the system one.
 *
 * Nothing is installed at boot: pi would `npm install` a missing package on
 * load (~13 s for two packages, measured), so a source that is not on disk is
 * dropped and reported in the runtime's extension status instead.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Agent, AgentOptions, AgentTool } from '@earendil-works/pi-agent-core'
import type { Provider } from '@earendil-works/pi-ai'
import { InMemoryCredentialStore } from '@earendil-works/pi-ai'
import {
  AgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionRunner,
  type InlineExtension,
  type PackageSource,
  type Skill,
} from '@earendil-works/pi-coding-agent'
import { logger } from '../../../logger'

export type { InlineExtension }

export interface ExtensionStatus {
  loaded: string[]
  failed: Array<{ name: string; error: string }>
}

export type RunnerRef = { current?: ExtensionRunner }

/** The Agent options that route pi's provider/context hooks to the current runner. */
export function extensionAgentHooks(ref: RunnerRef): Pick<AgentOptions, 'onPayload' | 'onResponse' | 'transformContext'> {
  return {
    onPayload: async (payload) => (ref.current?.hasHandlers('before_provider_request') ? ref.current.emitBeforeProviderRequest(payload) : payload),
    onResponse: async (response) => {
      if (ref.current?.hasHandlers('after_provider_response')) {
        await ref.current.emit({ type: 'after_provider_response', status: response.status, headers: response.headers })
      }
    },
    transformContext: async (messages) => (ref.current ? ref.current.emitContext(messages) : messages),
  }
}

/** `npm:name@version` → name and pinned version. Scoped names keep their leading `@`. */
export function parseNpmSource(source: string): { name: string; version?: string } | null {
  if (!source.startsWith('npm:')) return null
  const spec = source.slice(4)
  const at = spec.lastIndexOf('@')
  return at > 0 ? { name: spec.slice(0, at), version: spec.slice(at + 1) } : { name: spec }
}

function sourceOf(entry: PackageSource): string {
  return typeof entry === 'string' ? entry : entry.source
}

/**
 * Keep the entries pi can load without installing anything. An npm source must
 * already sit under `<npmRoot>/node_modules` at the pinned version; git sources
 * would clone at boot and are refused. Local paths pass: pi reports a missing one.
 */
export function installedPackages(entries: readonly PackageSource[], npmRoot: string): { kept: PackageSource[]; failed: ExtensionStatus['failed'] } {
  const kept: PackageSource[] = []
  const failed: ExtensionStatus['failed'] = []
  for (const entry of entries) {
    const source = sourceOf(entry)
    const npm = parseNpmSource(source)
    if (npm) {
      const manifest = join(npmRoot, 'node_modules', npm.name, 'package.json')
      let version: string | undefined
      try {
        version = (JSON.parse(readFileSync(manifest, 'utf8')) as { version?: string }).version
      } catch {
        failed.push({ name: source, error: 'package is not installed' })
        continue
      }
      if (npm.version && version !== npm.version) {
        failed.push({ name: source, error: `installed version ${version} does not match ${npm.version}` })
        continue
      }
      kept.push(entry)
      continue
    }
    if (source.startsWith('git:') || /^[a-z]+:\/\//i.test(source)) {
      failed.push({ name: source, error: 'git packages are not supported; use an npm package' })
      continue
    }
    kept.push(entry)
  }
  return { kept, failed }
}

/** The project's package list from `KORTIX_PI_PACKAGES`; invalid JSON is an empty list, logged. */
export function parseProjectPackages(raw: string | undefined): PackageSource[] {
  if (!raw?.trim()) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) throw new Error('not an array')
    return parsed.filter((entry): entry is PackageSource => typeof entry === 'string' || (!!entry && typeof entry === 'object' && typeof (entry as { source?: unknown }).source === 'string'))
  } catch (err) {
    logger.warn('[pi] KORTIX_PI_PACKAGES is not a JSON array of package sources; ignoring', { err: (err as Error).message })
    return []
  }
}

function readSettings(path: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** Both scopes in memory: pi reads them, and any write it attempts stays in this process. */
class ScopedSettingsStorage {
  constructor(private readonly scopes: { global: string; project: string }) {}
  withLock(scope: 'global' | 'project', fn: (current: string | undefined) => string | undefined): void {
    const next = fn(this.scopes[scope])
    if (next !== undefined) this.scopes[scope] = next
  }
}

/** The loader, with the runtime's system prompt read live (it follows the compiled agent config). */
class KortixResourceLoader extends DefaultResourceLoader {
  constructor(options: ConstructorParameters<typeof DefaultResourceLoader>[0], private readonly prompt: () => string) {
    super(options)
  }
  override getSystemPrompt(): string {
    return this.prompt()
  }
}

export interface PiSessionInput {
  agent: Agent
  ref: RunnerRef
  cwd: string
  agentDir: string
  projectPackages: readonly PackageSource[]
  /** The unpacked project bundle (`<root>/node_modules/<name>`), or null when there is none. */
  projectBundleRoot: string | null
  baseTools: readonly AgentTool<any, any>[]
  extensions: readonly InlineExtension[]
  systemPrompt: () => string
  /** The provider the agent streams through; pi checks it has auth before a prompt. */
  provider: Provider | undefined
}

export interface PiSession {
  session: AgentSession
  status: () => ExtensionStatus
  skills: () => Skill[]
}

function extensionName(path: string): string {
  const inline = /^<inline:(.+)>$/.exec(path)
  return inline ? inline[1]! : path
}

function withSource(entry: PackageSource, source: string): PackageSource {
  return typeof entry === 'string' ? source : { ...entry, source }
}

/**
 * Project entries as pi loads them: an npm source becomes the absolute path of
 * its directory in the unpacked bundle (outside the repo, so a clone never
 * meets it), a repo path becomes absolute. `labels` maps each path back to the
 * source the project wrote.
 */
export function resolveProjectPackages(
  entries: readonly PackageSource[],
  input: { cwd: string; bundleRoot: string | null },
): { kept: PackageSource[]; failed: ExtensionStatus['failed']; npmNames: Set<string>; labels: Map<string, string> } {
  const kept: PackageSource[] = []
  const failed: ExtensionStatus['failed'] = []
  const npmNames = new Set<string>()
  const labels = new Map<string, string>()
  for (const entry of entries) {
    const source = sourceOf(entry)
    const npm = parseNpmSource(source)
    if (npm) {
      npmNames.add(npm.name)
      if (!input.bundleRoot) {
        failed.push({ name: source, error: 'package is not installed' })
        continue
      }
      const checked = installedPackages([entry], input.bundleRoot)
      if (checked.failed.length) {
        failed.push(...checked.failed)
        continue
      }
      const dir = join(input.bundleRoot, 'node_modules', npm.name)
      kept.push(withSource(entry, dir))
      labels.set(dir, source)
      continue
    }
    if (source.startsWith('./')) {
      kept.push(withSource(entry, join(input.cwd, source)))
      continue
    }
    failed.push({ name: source, error: 'use an exact npm pin or a ./ repo path' })
  }
  return { kept, failed, npmNames, labels }
}

export async function createPiSession(input: PiSessionInput): Promise<PiSession> {
  const globalSettings = readSettings(join(input.agentDir, 'settings.json'))
  const project = resolveProjectPackages(input.projectPackages, { cwd: input.cwd, bundleRoot: input.projectBundleRoot })
  // A package the project pins itself replaces the system one (pi would load both: a path and an npm name differ).
  const systemEntries = ((globalSettings.packages as PackageSource[] | undefined) ?? []).filter((entry) => {
    const npm = parseNpmSource(sourceOf(entry))
    return !npm || !project.npmNames.has(npm.name)
  })
  const system = installedPackages(systemEntries, join(input.agentDir, 'npm'))
  const settingsManager = SettingsManager.fromStorage(
    new ScopedSettingsStorage({
      global: JSON.stringify({ ...globalSettings, packages: system.kept }),
      project: JSON.stringify({ packages: project.kept }),
    }),
    { projectTrusted: true },
  )
  // Kortix owns these: the transcript has no compaction yet, and a failed turn
  // is the product's to retry (a silent pi retry would double-bill and reorder the wire).
  settingsManager.applyOverrides({ compaction: { enabled: false }, retry: { enabled: false } } as never)

  const loader = new KortixResourceLoader(
    {
      cwd: input.cwd,
      agentDir: input.agentDir,
      settingsManager,
      extensionFactories: [...input.extensions],
      noContextFiles: true,
      noThemes: true,
    },
    input.systemPrompt,
  )
  await loader.reload()

  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false })
  if (input.provider) {
    modelRuntime.registerNativeProvider(input.provider)
    // The agent's own stream function carries the real credentials; this only satisfies pi's pre-prompt auth check.
    await modelRuntime.setRuntimeApiKey(input.provider.id, 'kortix-runtime')
  }

  const session = new AgentSession({
    agent: input.agent,
    sessionManager: SessionManager.inMemory(input.cwd),
    settingsManager,
    cwd: input.cwd,
    resourceLoader: loader,
    modelRuntime,
    baseToolsOverride: Object.fromEntries(input.baseTools.map((tool) => [tool.name, tool])),
    extensionRunnerRef: input.ref,
  })
  const runtimeErrors: ExtensionStatus['failed'] = []
  await session.bindExtensions({
    onError: (error) => {
      logger.warn('[pi] extension error', { extension: error.extensionPath, event: error.event, err: error.error })
      runtimeErrors.push({ name: extensionName(error.extensionPath), error: `${error.event}: ${error.error}` })
    },
  })

  const loaded = loader.getExtensions()
  return {
    session,
    status: () => ({
      // A package's extension reads as its source (`npm:pi-web-access@0.30.0`), the rest as name or path.
      loaded: loaded.extensions
        .filter((extension) => !extension.hidden)
        .map((extension) => {
          const source = extension.sourceInfo?.origin === 'package' ? extension.sourceInfo.source : extensionName(extension.path)
          return project.labels.get(source) ?? source
        }),
      failed: [
        ...system.failed,
        ...project.failed,
        ...loaded.errors.map((error) => ({ name: extensionName(error.path), error: error.error })),
        ...runtimeErrors,
      ],
    }),
    skills: () => loader.getSkills().skills,
  }
}
