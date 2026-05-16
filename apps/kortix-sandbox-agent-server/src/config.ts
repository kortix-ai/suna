import { z } from 'zod'

/**
 * Env contract for kortix-sandbox-agent-server.
 *
 * Names must stay aligned with apps/api/src/projects/index.ts: the API
 * passes KORTIX_PROJECT_AUTO_CLONE / KORTIX_REPO_URL / KORTIX_BRANCH_NAME /
 * KORTIX_DEFAULT_BRANCH / KORTIX_GITHUB_TOKEN / KORTIX_SERVICE_PORT to
 * Daytona at sandbox creation time. The daemon reads exactly those names.
 */

const BoolFlag = z.preprocess((v) => {
  if (typeof v !== 'string') return false
  const s = v.trim().toLowerCase()
  return s === '1' || s === 'true' || s === 'yes' || s === 'on'
}, z.boolean())

const Schema = z.object({
  KORTIX_SERVICE_PORT: z.coerce.number().int().positive().default(8000),
  KORTIX_OPENCODE_INTERNAL_PORT: z.coerce.number().int().positive().default(4096),
  KORTIX_WORKSPACE: z.string().default('/workspace'),
  KORTIX_PROJECT_TARGET: z.string().default('/workspace/.kortix'),
  KORTIX_DEFAULT_BRANCH: z.string().default('main'),
  KORTIX_BRANCH_FETCH_ATTEMPTS: z.coerce.number().int().positive().default(60),
  KORTIX_BRANCH_FETCH_DELAY: z.coerce.number().positive().default(0.25),
  KORTIX_DEFAULT_OPENCODE_CONFIG_DIR: z
    .string()
    .default('/ephemeral/kortix-master/opencode'),
  KORTIX_PROJECT_AUTO_CLONE: BoolFlag.default(false),
  KORTIX_REPO_URL: z.string().optional(),
  KORTIX_BRANCH_NAME: z.string().optional(),
  KORTIX_GITHUB_TOKEN: z.string().optional(),
  KORTIX_TOKEN: z.string().optional(),
})

export type Config = {
  servicePort: number
  opencodeInternalPort: number
  workspace: string
  projectTarget: string
  defaultBranch: string
  branchFetchAttempts: number
  branchFetchDelaySec: number
  defaultOpencodeConfigDir: string
  autoClone: boolean
  repoUrl: string | undefined
  branchName: string | undefined
  githubToken: string | undefined
  kortixToken: string | undefined
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Schema.parse({
    KORTIX_SERVICE_PORT: env.KORTIX_SERVICE_PORT,
    KORTIX_OPENCODE_INTERNAL_PORT: env.KORTIX_OPENCODE_INTERNAL_PORT,
    KORTIX_WORKSPACE: env.KORTIX_WORKSPACE,
    KORTIX_PROJECT_TARGET: env.KORTIX_PROJECT_TARGET,
    KORTIX_DEFAULT_BRANCH: env.KORTIX_DEFAULT_BRANCH,
    KORTIX_BRANCH_FETCH_ATTEMPTS: env.KORTIX_BRANCH_FETCH_ATTEMPTS,
    KORTIX_BRANCH_FETCH_DELAY: env.KORTIX_BRANCH_FETCH_DELAY,
    KORTIX_DEFAULT_OPENCODE_CONFIG_DIR: env.KORTIX_DEFAULT_OPENCODE_CONFIG_DIR,
    KORTIX_PROJECT_AUTO_CLONE: env.KORTIX_PROJECT_AUTO_CLONE,
    KORTIX_REPO_URL: env.KORTIX_REPO_URL,
    KORTIX_BRANCH_NAME: env.KORTIX_BRANCH_NAME,
    KORTIX_GITHUB_TOKEN: env.KORTIX_GITHUB_TOKEN,
    KORTIX_TOKEN: env.KORTIX_TOKEN,
  })

  return {
    servicePort: parsed.KORTIX_SERVICE_PORT,
    opencodeInternalPort: parsed.KORTIX_OPENCODE_INTERNAL_PORT,
    workspace: parsed.KORTIX_WORKSPACE,
    projectTarget: parsed.KORTIX_PROJECT_TARGET,
    defaultBranch: parsed.KORTIX_DEFAULT_BRANCH,
    branchFetchAttempts: parsed.KORTIX_BRANCH_FETCH_ATTEMPTS,
    branchFetchDelaySec: parsed.KORTIX_BRANCH_FETCH_DELAY,
    defaultOpencodeConfigDir: parsed.KORTIX_DEFAULT_OPENCODE_CONFIG_DIR,
    autoClone: parsed.KORTIX_PROJECT_AUTO_CLONE,
    repoUrl: parsed.KORTIX_REPO_URL,
    branchName: parsed.KORTIX_BRANCH_NAME,
    githubToken: parsed.KORTIX_GITHUB_TOKEN,
    kortixToken: parsed.KORTIX_TOKEN,
  }
}

/**
 * Project overlay wins: prefer <projectTarget>/.opencode if it has a config
 * file, then KORTIX_DEFAULT_OPENCODE_CONFIG_DIR. Same precedence as the legacy
 * kortix-daemon `resolve_opencode_config_dir`.
 */
export async function resolveOpencodeConfigDir(cfg: Config): Promise<string> {
  const candidate = `${cfg.projectTarget}/.opencode`
  const fs = await import('node:fs/promises')
  try {
    const stat = await fs.stat(`${candidate}/opencode.jsonc`)
    if (stat.isFile()) return candidate
  } catch {}
  try {
    const stat = await fs.stat(`${candidate}/opencode.json`)
    if (stat.isFile()) return candidate
  } catch {}
  return cfg.defaultOpencodeConfigDir
}
