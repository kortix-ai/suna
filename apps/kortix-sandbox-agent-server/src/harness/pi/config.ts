import { join } from 'node:path'
import { z } from 'zod'
import type { Config as HostConfig } from '../../config'
import { resolveKortixRuntimeStateDirectory } from '../../runtime-state-dir'

/**
 * The pi harness environment contract.
 *
 * pi runs INSIDE the daemon process (no child, no port), so most of the
 * OpenCode contract has no analogue here. What remains is where its durable
 * state lives.
 *
 * Model, agent, prompts and the gateway are read from the SAME variables the
 * OpenCode path receives (`KORTIX_OPENCODE_MODEL`, `KORTIX_COMPILED_AGENT_CONFIG`,
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
})

export interface PiEnvironment {
  piStateDir: string
  piAgentDir: string
  piPackages?: string
  piPackagesBundleUrl?: string
  piPackagesFallbackUrl?: string
  piPackagesBundleDigest?: string
  piPackagesDir: string
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
  })
  return {
    piStateDir: parsed.KORTIX_PI_STATE_DIR?.trim() || join(resolveKortixRuntimeStateDirectory(env), 'pi'),
    piAgentDir: parsed.KORTIX_PI_AGENT_DIR?.trim() || DEFAULT_PI_AGENT_DIR,
    piPackages: parsed.KORTIX_PI_PACKAGES,
    piPackagesBundleUrl: parsed.KORTIX_PI_PACKAGES_BUNDLE_URL?.trim() || undefined,
    piPackagesFallbackUrl: parsed.KORTIX_PI_PACKAGES_FALLBACK_URL?.trim() || undefined,
    piPackagesBundleDigest: parsed.KORTIX_PI_PACKAGES_BUNDLE_DIGEST?.trim() || undefined,
    piPackagesDir: parsed.KORTIX_PI_PACKAGES_DIR?.trim() || join(resolveKortixRuntimeStateDirectory(env), 'pi-packages'),
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
 * Skill directories, most specific first. pi reads the SAME project skills a
 * project authored for OpenCode (`.kortix/opencode/skills`) so switching
 * `runtime:` never loses them, plus the harness-neutral `.kortix/skills`.
 */
export function resolvePiSkillDirectories(cfg: HostConfig): string[] {
  const workspace = cfg.projectTarget || cfg.workspace || '/workspace'
  return [join(workspace, '.kortix', 'skills'), join(workspace, '.kortix', 'opencode', 'skills')]
}

/** Where the managed skill overlay lands (runtime-assets.ts `injectSkills`). */
export function resolvePiConfigDir(cfg: HostConfig): string {
  return join(cfg.projectTarget || cfg.workspace || '/workspace', '.kortix', 'opencode')
}
