/**
 * Boot artifacts: one release's prebuilt runtime on a read-only volume the
 * control plane mounts into every Platinum session box (apps/api
 * platform/services/boot-artifacts.ts; built by scripts/boot-artifacts/publish.ts).
 *
 * Layout (manifest.json names every path and digest):
 *   kortix/kortix-agent     the daemon         (entrypoint launches it)
 *   kortix/kortix           the CLI            (convergence reads it here)
 *   <harness>/bin/<harness> the harness binary (first on PATH, entrypoint)
 *   managed-skills/         the skill overlay  (entrypoint copies it)
 *   managed-skills.json     the same overlay as the API serves it
 *
 * Everything here is a local SOURCE for bytes the convergence pass would
 * otherwise download. It never decides what is current: the API manifest does,
 * and the caller verifies every digest exactly as it does for a download.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { logger } from '@/lib/log/logger'

export const BOOT_ARTIFACTS_DEFAULT_DIR = '/opt/kortix-artifacts'

/** One component: a binary (`sha256`), a versioned harness binary (`version`) or the skill overlay (`hash`). */
export interface BootArtifactComponent {
  path: string
  sha256?: string
  version?: string
  hash?: string
}

export interface BootArtifactsManifest {
  release: string
  components: Record<string, BootArtifactComponent | undefined>
}

export function bootArtifactsDir(): string {
  return process.env.KORTIX_BOOT_ARTIFACTS_DIR || BOOT_ARTIFACTS_DEFAULT_DIR
}

let cached: { dir: string; manifest: BootArtifactsManifest | null } | null = null

/** The mounted release's manifest, or null when no artifacts volume is mounted. Read once: the mount is pinned. */
export async function bootArtifactsManifest(): Promise<BootArtifactsManifest | null> {
  const dir = bootArtifactsDir()
  if (cached?.dir === dir) return cached.manifest
  let manifest: BootArtifactsManifest | null = null
  try {
    const parsed = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as BootArtifactsManifest
    if (parsed && typeof parsed === 'object' && parsed.components) manifest = parsed
  } catch {
    manifest = null
  }
  cached = { dir, manifest }
  return manifest
}

/** The bytes of `component` when the mounted release holds exactly `expectedSha`, else null. */
export async function bootArtifactBytes(component: 'agent' | 'cli', expectedSha: string): Promise<Buffer | null> {
  const c = (await bootArtifactsManifest())?.components[component]
  if (!c || c.sha256 !== expectedSha) return null
  try {
    const bytes = await readFile(join(bootArtifactsDir(), c.path))
    logger.info('[boot-artifacts] read from the artifacts volume', { component, bytes: bytes.length })
    return bytes
  } catch (err) {
    logger.warn('[boot-artifacts] artifact unreadable; downloading instead', { component, err: String(err) })
    return null
  }
}

/** The managed-skill overlay payload when the mounted release has exactly `hash`, else null. */
export async function bootArtifactSkills<T>(hash: string): Promise<T | null> {
  const c = (await bootArtifactsManifest())?.components['managed-skills']
  if (!c || c.hash !== hash) return null
  try {
    return JSON.parse(await readFile(join(bootArtifactsDir(), 'managed-skills.json'), 'utf8')) as T
  } catch {
    return null
  }
}

/** The binary of `component` at exactly `version` on the artifacts volume, or null. */
export async function bootArtifactVersioned(component: string, version: string): Promise<string | null> {
  const c = (await bootArtifactsManifest())?.components[component]
  return c && c.version === version ? join(bootArtifactsDir(), c.path) : null
}

/**
 * Take the artifacts volume's binaries off PATH. Called once this box installs
 * a harness version the volume does not carry, so the next spawn resolves the
 * installed one instead of the volume's older binary.
 */
export function dropBootArtifactsFromPath(): void {
  const prefix = bootArtifactsDir()
  const parts = (process.env.PATH ?? '').split(':')
  const kept = parts.filter((p) => !(p === prefix || p.startsWith(`${prefix}/`)))
  if (kept.length !== parts.length) process.env.PATH = kept.join(':')
}

export function _resetBootArtifactsForTests(): void {
  cached = null
}
