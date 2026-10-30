import { createHash } from 'node:crypto'
import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs'
import { join, sep } from 'node:path'
import { z } from 'zod'
import type { Config as HostConfig } from '@/lib/config/config'
import { resolveKortixRuntimeStateDirectory } from '@/lib/config/runtime-state-dir'
import { logger } from '@/lib/log/logger'
import { managedSkillsDir } from '@/lib/config/managed-skills-dir'
import { DEFAULT_MAX_CLOUD_SUBAGENT_DEPTH, DEFAULT_MAX_LIVE_CLOUD_SUBAGENTS } from './cloud-subagent'

/** First backoff of a transient model-error retry (transient-retry.ts): 2, 4, 8, 16, 30 s. */
const TURN_RETRY_DEFAULT_BASE_MS = 2_000

/**
 * The pi harness environment contract.
 *
 * pi runs INSIDE the daemon process (no child, no port), so this contract is
 * mostly where its durable state lives.
 *
 * Model, agent, prompts and the gateway are read from the harness-neutral
 * variables the control plane sets (`KORTIX_MODEL`, `KORTIX_COMPILED_AGENT_CONFIG`,
 * `KORTIX_AGENT_NAME`, `KORTIX_LLM_BASE_URL`, `KORTIX_TOKEN`): the control plane
 * does not know which harness reads them, and it must not have to.
 */
const EnvironmentSchema = z.object({
  // Session transcript + pin. Defaults under the daemon's runtime state dir.
  KORTIX_PI_STATE_DIR: z.string().optional(),
  // pi's global agent dir: `settings.json` lists the system packages the image
  // installed under `npm/` by the image build (runtime-versions.json `piSystemPackages`).
  KORTIX_PI_AGENT_DIR: z.string().optional(),
  // JSON array of the session agent's pi package sources (kortix.yaml `extensions` the agent enables).
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
  // The session agent's codemode (`off`, `on` or `only`, codemode.ts), sent by the API. Absent or invalid: the
  // compiled agent's `codemode`, else `on` (runtime.ts `codemode`).
  KORTIX_PI_CODEMODE: z.enum(['off', 'on', 'only']).optional().catch(undefined),
  // Cloud subagent guardrails (cloud-subagent.ts): children one parent waits on at
  // once, and the depth a cloud child may still delegate from. Invalid: the default.
  KORTIX_PI_CLOUD_SUBAGENTS_MAX: z.coerce.number().int().positive().optional().catch(undefined),
  KORTIX_PI_CLOUD_SUBAGENTS_MAX_DEPTH: z.coerce.number().int().nonnegative().optional().catch(undefined),
  // The workflow tool (extensions/workflow.ts): agents one run may start, and how many work at once
  // (never above KORTIX_PI_CLOUD_SUBAGENTS_MAX). Invalid: the default.
  KORTIX_WORKFLOW_MAX_AGENTS: z.coerce.number().int().positive().optional().catch(undefined),
  KORTIX_WORKFLOW_MAX_CONCURRENT: z.coerce.number().int().positive().optional().catch(undefined),
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
  piCodemode?: 'off' | 'on' | 'only'
  /** Cloud children one parent waits on at once. */
  piCloudSubagentsMax: number
  /** A session at this subagent depth starts no cloud child. */
  piCloudSubagentsMaxDepth: number
  /** `agent()` calls one workflow run may make. */
  workflowMaxAgents: number
  /** Workflow children working at once, before the cloud cap applies. */
  workflowMaxConcurrent: number
}

/** Defaults of the workflow limits: Claude Code's size guideline `large` (fewer than 50 agents), 8 at once. */
export const DEFAULT_WORKFLOW_MAX_AGENTS = 50
export const DEFAULT_WORKFLOW_MAX_CONCURRENT = 8

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
    KORTIX_PI_CODEMODE: env.KORTIX_PI_CODEMODE?.trim() || undefined,
    KORTIX_PI_CLOUD_SUBAGENTS_MAX: env.KORTIX_PI_CLOUD_SUBAGENTS_MAX?.trim() || undefined,
    KORTIX_PI_CLOUD_SUBAGENTS_MAX_DEPTH: env.KORTIX_PI_CLOUD_SUBAGENTS_MAX_DEPTH?.trim() || undefined,
    KORTIX_WORKFLOW_MAX_AGENTS: env.KORTIX_WORKFLOW_MAX_AGENTS?.trim() || undefined,
    KORTIX_WORKFLOW_MAX_CONCURRENT: env.KORTIX_WORKFLOW_MAX_CONCURRENT?.trim() || undefined,
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
    piCodemode: parsed.KORTIX_PI_CODEMODE,
    piCloudSubagentsMax: parsed.KORTIX_PI_CLOUD_SUBAGENTS_MAX ?? DEFAULT_MAX_LIVE_CLOUD_SUBAGENTS,
    piCloudSubagentsMaxDepth: parsed.KORTIX_PI_CLOUD_SUBAGENTS_MAX_DEPTH ?? DEFAULT_MAX_CLOUD_SUBAGENT_DEPTH,
    workflowMaxAgents: parsed.KORTIX_WORKFLOW_MAX_AGENTS ?? DEFAULT_WORKFLOW_MAX_AGENTS,
    workflowMaxConcurrent: parsed.KORTIX_WORKFLOW_MAX_CONCURRENT ?? DEFAULT_WORKFLOW_MAX_CONCURRENT,
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
 * tree. Then exactly the folders kortix.yaml registers (`compiled.skills`)
 * under the config root: the active release root, else the workspace. No
 * folder is scanned. Null (the image default) has no project skill.
 */
export function resolvePiSkillDirectories(skills: Record<string, string> | undefined, root: string | null): string[] {
  return [managedSkillsDir(), ...(root ? Object.values(skills ?? {}).map((folder) => join(root, folder)) : [])]
}

/** The project's root instructions file, as the system prompt renders it and health reports it. */
export interface ProjectInstructions {
  source: 'release' | 'workspace'
  path: string
  bytes: number
  /** The first 12 hex characters of the file's sha256. */
  sha: string
  /** `AGENTS.md`, or `CLAUDE.md` when the root has no `AGENTS.md`. */
  name: string
  text: string
}

/**
 * The root `AGENTS.md` of `root`, else its `CLAUDE.md`: the first name that
 * exists wins. Only the
 * root: no ancestor directory, no nested file, no agent-dir file. Null when
 * there is none or it is empty. Null and one warning when it is not a regular
 * file, resolves out of `root`, or cannot be read.
 */
export function readProjectInstructions(root: string, source: ProjectInstructions['source']): ProjectInstructions | null {
  for (const name of ['AGENTS.md', 'CLAUDE.md']) {
    const path = join(root, name)
    if (!existsSync(path)) continue
    try {
      const real = realpathSync(path)
      // A symlink to a host file (`/proc/self/environ`) would put that file in the prompt.
      if (!real.startsWith(`${realpathSync(root)}${sep}`)) throw new Error('it resolves outside the project root')
      // Check and read through one descriptor: a file swapped for a symlink after
      // realpath is refused by O_NOFOLLOW, not read; O_NONBLOCK keeps a FIFO from hanging the open.
      const fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      let raw: Buffer
      try {
        if (!fstatSync(fd).isFile()) throw new Error('it is not a regular file')
        raw = readFileSync(fd)
      } finally {
        closeSync(fd)
      }
      const text = raw.toString('utf8').trim()
      if (!text) return null
      const loaded = { source, path, bytes: raw.length, sha: createHash('sha256').update(raw).digest('hex').slice(0, 12) }
      logger.info('[pi] AGENTS.md loaded', loaded)
      return { ...loaded, name, text }
    } catch (err) {
      logger.warn('[pi] AGENTS.md not loaded', { path, reason: err instanceof Error ? err.message : String(err) })
      return null
    }
  }
  return null
}
