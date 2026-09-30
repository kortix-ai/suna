import { join } from 'node:path'
import { stat } from 'node:fs/promises'
import type { RuntimeAssetsOptions, RuntimeComponent, ManifestComponent, RuntimeAssetsManifest } from './runtime-assets'

const DEFAULT_AGENT_STATE_DIR = '/opt/kortix'
const DEFAULT_AGENT_BAKED_PATH = '/usr/local/bin/kortix-agent'

// ── Manifest reading ───────────────────────────────────────────────────────
// Every read below is total: a field that is missing, null, or the wrong type
// answers "not stated" instead of throwing. A daemon that crashes on a manifest
// shape it does not recognize is a daemon that cannot be rolled forward.

export function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function manifestComponent(
  manifest: RuntimeAssetsManifest,
  name: 'agent' | 'cli' | 'managed-skills',
): ManifestComponent | null {
  const components = manifest.components
  if (!components || typeof components !== 'object' || Array.isArray(components)) return null
  const entry = (components as Record<string, unknown>)[name]
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
  return entry as ManifestComponent
}

/** True once the API speaks v2 at all — i.e. it stated a `components` map. */
export function isV2Manifest(manifest: RuntimeAssetsManifest): boolean {
  const components = manifest.components
  return Boolean(components && typeof components === 'object' && !Array.isArray(components))
}

export function manifestBuild(manifest: RuntimeAssetsManifest): number | undefined {
  const build = manifest.build
  return typeof build === 'number' && Number.isFinite(build) ? build : undefined
}

/**
 * The kill switch. `false` — and only an explicit `false` — stops agent
 * self-update fleet-wide.
 *
 * It has to be centrally flippable precisely because the thing it governs is
 * the component that might no longer boot: shipping a new daemon to stop a bad
 * daemon rollout assumes the daemon still works.
 */
export function agentSelfUpdateAllowed(manifest: RuntimeAssetsManifest): boolean {
  const policy = manifest.policy
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return true
  return (policy as Record<string, unknown>).agent_self_update !== false
}

/**
 * Turn a manifest-supplied artifact path into a URL on the API we are already
 * talking to.
 *
 * The path is server-supplied and decides what this root process downloads and
 * stages, so it may name a PATH on this API and nothing else. An absolute URL,
 * a protocol-relative `//host/…`, or anything with whitespace is refused and
 * the built-in route is used instead — the manifest can never redirect a
 * sandbox to another host.
 */
export function resolveArtifactUrl(apiRoot: string, path: unknown, fallback: string): string {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) return fallback
  if (/\s/.test(path) || path.includes('://')) return fallback
  const origin = apiRoot.replace(/\/v1$/, '')
  return `${origin}${path}`
}

/**
 * Give the daemon write access to the directory that holds the CLI.
 *
 * The shipped image now bakes this (platform-binaries.ts
 * SANDBOX_CLI_OWNERSHIP_COMMAND), but a box already running an older snapshot
 * cannot wait for a rebuild, and it is exactly the box whose CLI has drifted
 * from the manifest. The image grants `kortix` NOPASSWD:ALL sudo, so one
 * non-interactive `chown` converges the live box to the state the new image
 * bakes. `-n` means a box WITHOUT that sudo rule fails immediately instead of
 * hanging on a password prompt.
 */
// ── Agent staging ──────────────────────────────────────────────────────────

export function agentStateDirOf(options: RuntimeAssetsOptions): string {
  return options.agentStateDir ?? process.env.KORTIX_AGENT_STATE_DIR ?? DEFAULT_AGENT_STATE_DIR
}

export function agentBakedPathOf(options: RuntimeAssetsOptions): string {
  return options.agentBakedPath ?? process.env.KORTIX_AGENT_BIN ?? DEFAULT_AGENT_BAKED_PATH
}

/**
 * Is this process a `bun --compile` standalone binary, or `bun some/file.ts`?
 *
 * A standalone build runs its entry from Bun's embedded filesystem, so
 * `process.argv[1]` is a `/$bunfs/` path. In dev and under `bun test` it is a
 * real source path. The distinction matters because `process.execPath` is the
 * daemon binary in the first case and the BUN RUNTIME in the second — hashing
 * the latter would compare the wrong file entirely.
 */
export function isCompiledStandalone(): boolean {
  return typeof process.argv[1] === 'string' && process.argv[1].startsWith('/$bunfs/')
}

/**
 * Which file is this daemon actually running from?
 *
 * `process.execPath` is the truthful answer for a compiled binary: it is the
 * real path of the executable and it follows a rename or a copy (verified
 * 2026-08-20 by renaming a `bun --compile` output and re-reading it inside the
 * process). Falling back, we use the supervisor's own rule from
 * `select_agent()` in apps/sandbox/entrypoint.sh: `agent.current` when it is
 * present, the baked floor otherwise.
 *
 * Getting this wrong has one specific, expensive consequence. An already-
 * updated box runs `agent.current`; hashing the baked floor there would compare
 * the wrong file, find a permanent mismatch, and re-download ~96 MB on every
 * single start — for ever.
 */
