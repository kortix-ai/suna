import { join } from 'node:path'
import { z } from 'zod'
import { loadConfig, type Config as HostConfig } from '../../config'
import { managedSkillsDir } from '../../managed-skills'
import { projectSkillDirs } from '../../project-layout'
import { resolveKortixRuntimeStateDirectory } from '../../runtime-state-dir'

/**
 * The pi harness environment contract.
 *
 * pi runs INSIDE the daemon process (no child, no port), so most of the
 * OpenCode contract has no analogue here. What remains is where its durable
 * state lives and the test seam that swaps the real model for a scripted one.
 *
 * Model, agent, prompts and the gateway are read from the SAME variables the
 * OpenCode path receives (`KORTIX_OPENCODE_MODEL`, `KORTIX_COMPILED_AGENT_CONFIG`,
 * `KORTIX_AGENT_NAME`, `KORTIX_LLM_BASE_URL`, `KORTIX_TOKEN`): the control plane
 * does not know which harness reads them, and it must not have to.
 */
const EnvironmentSchema = z.object({
  // Session transcript + pin. Defaults under the daemon's runtime state dir.
  KORTIX_PI_STATE_DIR: z.string().optional(),
  // `faux` swaps the gateway model for pi's scripted provider: no network, no
  // credentials, deterministic replies. Tests and the local bench only.
  KORTIX_PI_MODEL_MODE: z.enum(['real', 'faux']).default('real'),
  // JSON array of `{ text }` | `{ tool, args }` steps for faux mode.
  KORTIX_PI_FAUX_SCRIPT: z.string().optional(),
})

export interface PiEnvironment {
  piStateDir: string
  piModelMode: 'real' | 'faux'
  piFauxScript?: string
}

export function loadPiEnvironment(env: NodeJS.ProcessEnv): PiEnvironment {
  const parsed = EnvironmentSchema.parse({
    KORTIX_PI_STATE_DIR: env.KORTIX_PI_STATE_DIR,
    KORTIX_PI_MODEL_MODE: env.KORTIX_PI_MODEL_MODE || undefined,
    KORTIX_PI_FAUX_SCRIPT: env.KORTIX_PI_FAUX_SCRIPT,
  })
  return {
    piStateDir: parsed.KORTIX_PI_STATE_DIR?.trim() || join(resolveKortixRuntimeStateDirectory(env), 'pi'),
    piModelMode: parsed.KORTIX_PI_MODEL_MODE,
    piFauxScript: parsed.KORTIX_PI_FAUX_SCRIPT,
  }
}

/** Complete configuration visible only inside the pi implementation. */
export type PiConfig = HostConfig & PiEnvironment

export function requirePiConfig(cfg: HostConfig): PiConfig {
  if (
    !('piStateDir' in cfg) || typeof cfg.piStateDir !== 'string' ||
    !('piModelMode' in cfg) || (cfg.piModelMode !== 'real' && cfg.piModelMode !== 'faux')
  ) {
    throw new Error('Selected pi harness requires its resolved configuration')
  }
  return cfg as PiConfig
}

export function loadPiConfig(env: NodeJS.ProcessEnv = process.env): PiConfig {
  return requirePiConfig(loadConfig(env))
}

/**
 * Skill directories, most specific first; pi keeps the first skill of a name.
 * The baked managed `kortix-*` overlay comes first, so the platform's latest
 * copy wins over one a project tracks, with nothing written into the working
 * tree. Then the project's `skills/`, then the legacy `.kortix/opencode/skills`
 * a project authored for OpenCode, so switching `runtime:` never loses them.
 */
export function resolvePiSkillDirectories(cfg: HostConfig): string[] {
  const workspace = cfg.projectTarget || cfg.workspace || '/workspace'
  return [managedSkillsDir(), ...projectSkillDirs(workspace)]
}
