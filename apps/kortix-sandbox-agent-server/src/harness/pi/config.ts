import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { readProjectManifest, extractNestedString } from '@/lib/config/config'
import { z } from 'zod'
import type { Config as HostConfig } from '@/lib/config/config'
import { resolveKortixRuntimeStateDirectory } from '@/lib/config/runtime-state-dir'
import { managedSkillsDir } from '@/services/skills/managed-skills'

/** First backoff of a transient model-error retry (transient-retry.ts): 2, 4, 8, 16, 30 s. */
const TURN_RETRY_DEFAULT_BASE_MS = 2_000

/**
 * The pi harness environment contract.
 *
 * pi runs INSIDE the daemon process (no child, no port), so most of the
 * OpenCode contract has no analogue here. What remains is where its durable
 * state lives.
 *
 * Model, agent, prompts and the gateway are read from the SAME variables the
 * OpenCode path receives (`KORTIX_MODEL`, `KORTIX_COMPILED_AGENT_CONFIG`,
 * `KORTIX_AGENT_NAME`, `KORTIX_LLM_BASE_URL`, `KORTIX_TOKEN`): the control plane
 * does not know which harness reads them, and it must not have to.
 */
const EnvironmentSchema = z.object({
  // Session transcript + pin. Defaults under the daemon's runtime state dir.
  KORTIX_PI_STATE_DIR: z.string().optional(),
  // pi's global agent dir: `settings.json` lists the system packages the image
  // installed under `npm/` by the image build (runtime-versions.json `piSystemPackages`).
  KORTIX_PI_AGENT_DIR: z.string().optional(),
  // JSON array of the project's pi package sources (kortix.yaml `harnesses.pi.packages`).
  KORTIX_PI_PACKAGES: z.string().optional(),
  // The API-built bundle of those packages: short-lived download URLs (pre-built,
  // and the installed node_modules fallback) and their shared digest.
  KORTIX_PI_PACKAGES_BUNDLE_URL: z.string().optional(),
  KORTIX_PI_PACKAGES_FALLBACK_URL: z.string().optional(),
  KORTIX_PI_PACKAGES_BUNDLE_DIGEST: z.string().optional(),
  // Where bundles unpack, one `<digest>/` each. Defaults under the runtime state dir.
  KORTIX_PI_PACKAGES_DIR: z.string().optional(),
  // First backoff of a transient model-error retry (transient-retry.ts). Tests shorten it.
  KORTIX_PI_TURN_RETRY_BASE_MS: z.coerce.number().int().positive().optional(),
  KORTIX_PI_NO_PROGRESS_MS: z.coerce.number().int().positive().optional(),
  // pi compacts a context past this many tokens, whatever the model window (model.ts `compactionSettings`).
  KORTIX_PI_COMPACT_AT_TOKENS: z.coerce.number().int().positive().optional(),
})

export interface PiEnvironment {
  piStateDir: string
  piAgentDir: string
  piPackages?: string
  piPackagesBundleUrl?: string
  piPackagesFallbackUrl?: string
  piPackagesBundleDigest?: string
  piPackagesDir: string
  piTurnRetryBaseMs: number
  piNoProgressMs: number
  piCompactAtTokens: number
}

export const DEFAULT_PI_AGENT_DIR = '/opt/kortix/pi-agent'

export function loadPiEnvironment(env: NodeJS.ProcessEnv): PiEnvironment {
  const parsed = EnvironmentSchema.parse({
    KORTIX_PI_STATE_DIR: env.KORTIX_PI_STATE_DIR,
    KORTIX_PI_AGENT_DIR: env.KORTIX_PI_AGENT_DIR,
    KORTIX_PI_PACKAGES: env.KORTIX_PI_PACKAGES,
    KORTIX_PI_PACKAGES_BUNDLE_URL: env.KORTIX_PI_PACKAGES_BUNDLE_URL,
    KORTIX_PI_PACKAGES_FALLBACK_URL: env.KORTIX_PI_PACKAGES_FALLBACK_URL,
    KORTIX_PI_PACKAGES_BUNDLE_DIGEST: env.KORTIX_PI_PACKAGES_BUNDLE_DIGEST,
    KORTIX_PI_PACKAGES_DIR: env.KORTIX_PI_PACKAGES_DIR,
    KORTIX_PI_TURN_RETRY_BASE_MS: env.KORTIX_PI_TURN_RETRY_BASE_MS?.trim() || undefined,
    KORTIX_PI_NO_PROGRESS_MS: env.KORTIX_PI_NO_PROGRESS_MS?.trim() || undefined,
    KORTIX_PI_COMPACT_AT_TOKENS: env.KORTIX_PI_COMPACT_AT_TOKENS?.trim() || undefined,
  })
  return {
    piStateDir: parsed.KORTIX_PI_STATE_DIR?.trim() || join(resolveKortixRuntimeStateDirectory(env), 'pi'),
    piAgentDir: parsed.KORTIX_PI_AGENT_DIR?.trim() || DEFAULT_PI_AGENT_DIR,
    piPackages: parsed.KORTIX_PI_PACKAGES,
    piPackagesBundleUrl: parsed.KORTIX_PI_PACKAGES_BUNDLE_URL?.trim() || undefined,
    piPackagesFallbackUrl: parsed.KORTIX_PI_PACKAGES_FALLBACK_URL?.trim() || undefined,
    piPackagesBundleDigest: parsed.KORTIX_PI_PACKAGES_BUNDLE_DIGEST?.trim() || undefined,
    piPackagesDir: parsed.KORTIX_PI_PACKAGES_DIR?.trim() || join(resolveKortixRuntimeStateDirectory(env), 'pi-packages'),
    piTurnRetryBaseMs: parsed.KORTIX_PI_TURN_RETRY_BASE_MS ?? TURN_RETRY_DEFAULT_BASE_MS,
    piNoProgressMs: parsed.KORTIX_PI_NO_PROGRESS_MS ?? 10 * 60_000,
    // Every request re-sends the whole context: a 1M window left to fill costs ~6x a 160k one per turn.
    piCompactAtTokens: parsed.KORTIX_PI_COMPACT_AT_TOKENS ?? 160_000,
  }
}

/** Complete configuration visible only inside the pi implementation. */
export type PiConfig = HostConfig & PiEnvironment

export function requirePiConfig(cfg: HostConfig): PiConfig {
  if (!('piStateDir' in cfg) || typeof cfg.piStateDir !== 'string') {
    throw new Error('Selected pi harness requires its resolved configuration')
  }
  return cfg as PiConfig
}

/**
 * Skill directories, most specific first; pi keeps the first skill of a name.
 * The baked managed `kortix-*` overlay comes first, so the platform's latest
 * copy wins over one a project tracks, with nothing written into the working
 * tree. Then the project's `skills/`, then the legacy `.kortix/opencode/skills`
 * a project authored for OpenCode, so switching `runtime:` never loses them.
 */
export async function resolvePiProjectConfigDir(cfg: HostConfig): Promise<string | null> {
  const workspace = cfg.projectTarget || cfg.workspace || '/workspace'
  const manifest = await readProjectManifest(await import('node:fs/promises'), workspace)
  const raw = manifest && extractNestedString(manifest.body, manifest.format, 'pi', 'config_dir')
  // Repo-relative only. A manifest must never make the harness load host files.
  if (raw && !raw.startsWith('/') && !raw.startsWith('-') && raw.split('/').every((segment) => segment && segment !== '.' && segment !== '..' && /^[\w .-]+$/.test(segment))) {
    const path = join(workspace, raw)
    return existsSync(path) ? path : null
  }
  for (const path of ['harnesses/pi', '.kortix/pi']) {
    if (existsSync(join(workspace, path))) return join(workspace, path)
  }
  return null
}

export function resolvePiSkillDirectories(
  cfg: HostConfig,
  piDir?: string | null,
  releaseSkillDirs: string[] | null = null,
): string[] {
  const piSkills = piDir ? [join(piDir, 'skills')] : []
  // A config release decides the project's skills (config-release.ts); the
  // working tree is read only while releases are not in play.
  if (releaseSkillDirs) return [managedSkillsDir(), ...releaseSkillDirs, ...piSkills]
  const workspace = cfg.projectTarget || cfg.workspace || '/workspace'
  // The layout is packages/manifest-schema/src/layout.ts `skillDirs`; pi may not
  // import the OpenCode adapter's copy (harness/open-code/project-layout.ts).
  return [managedSkillsDir(), join(workspace, 'skills'), ...piSkills, join(workspace, '.kortix', 'opencode', 'skills')]
}
