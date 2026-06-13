import { z } from 'zod'

/**
 * Env contract for kortix-sandbox-agent-server.
 *
 * Names must stay aligned with apps/api/src/projects/index.ts: the API
 * passes KORTIX_PROJECT_AUTO_CLONE / KORTIX_REPO_URL / KORTIX_BRANCH_NAME /
 * KORTIX_DEFAULT_BRANCH / KORTIX_PROJECT_ID / KORTIX_API_URL /
 * KORTIX_SERVICE_PORT to Daytona at sandbox creation time. The provider layer
 * injects one sandbox-scoped KORTIX_TOKEN, which is used for both API calls
 * and proxy HMAC validation. Git provider credentials are fetched just-in-time
 * from apps/api.
 */

const BoolFlag = z.preprocess((v) => {
  if (typeof v !== 'string') return false
  const s = v.trim().toLowerCase()
  return s === '1' || s === 'true' || s === 'yes' || s === 'on'
}, z.boolean())

const Schema = z.object({
  KORTIX_SERVICE_PORT: z.coerce.number().int().positive().default(8000),
  KORTIX_OPENCODE_INTERNAL_PORT: z.coerce.number().int().positive().default(4096),
  // Static web server port. Default 3211 is a hard contract: apps/web
  // (platform-client STATIC_FILE_SERVER, url.ts) and the starter `show` tool
  // build preview URLs against this exact port via /proxy/3211 and p3211-* .
  KORTIX_STATIC_PORT: z.coerce.number().int().positive().default(3211),
  KORTIX_WORKSPACE: z.string().default('/workspace'),
  // Project repo is cloned directly into the workspace. The repo's
  // Kortix-owned files live under <workspace>/.kortix/ (Dockerfile +
  // opencode config dir) — no intermediate clone-target directory.
  KORTIX_PROJECT_TARGET: z.string().default('/workspace'),
  KORTIX_DEFAULT_BRANCH: z.string().default('main'),
  KORTIX_BRANCH_FETCH_ATTEMPTS: z.coerce.number().int().positive().default(60),
  KORTIX_BRANCH_FETCH_DELAY: z.coerce.number().positive().default(0.25),
  KORTIX_DEFAULT_OPENCODE_CONFIG_DIR: z
    .string()
    .default('/ephemeral/kortix-master/opencode'),
  KORTIX_PROJECT_AUTO_CLONE: BoolFlag.default(false),
  KORTIX_PROJECT_ID: z.string().optional(),
  KORTIX_API_URL: z.string().optional(),
  KORTIX_REPO_URL: z.string().optional(),
  KORTIX_BRANCH_NAME: z.string().optional(),
  KORTIX_SESSION_FRESH: z.string().optional(),
  KORTIX_BASE_SHA: z.string().optional(),
  KORTIX_TOKEN: z.string().optional(),
  KORTIX_GIT_USER_NAME: z.string().default('Kortix Agent'),
  KORTIX_GIT_USER_EMAIL: z.string().default('agent@kortix.ai'),
  // Partial-clone filter for the boot-time `git clone`. `blob:none` (the
  // default) is a blobless clone: it transfers the full commit/tree history
  // but fetches file blobs lazily, so the initial clone is a fraction of a
  // full clone's size while `git log`/`blame`/`diff` still work. Set to an
  // empty string to force a full clone. Remotes that don't advertise
  // partial-clone fall back to a full clone automatically (see git.ts).
  KORTIX_CLONE_FILTER: z.string().default('blob:none'),
})

export type Config = {
  servicePort: number
  opencodeInternalPort: number
  staticPort: number
  workspace: string
  projectTarget: string
  defaultBranch: string
  branchFetchAttempts: number
  branchFetchDelaySec: number
  defaultOpencodeConfigDir: string
  autoClone: boolean
  projectId: string | undefined
  apiUrl: string | undefined
  repoUrl: string | undefined
  branchName: string | undefined
  sessionFresh: boolean
  baseSha: string | undefined
  kortixToken: string | undefined
  gitUserName: string
  gitUserEmail: string
  cloneFilter: string
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Schema.parse({
    KORTIX_SERVICE_PORT: env.KORTIX_SERVICE_PORT,
    KORTIX_OPENCODE_INTERNAL_PORT: env.KORTIX_OPENCODE_INTERNAL_PORT,
    KORTIX_STATIC_PORT: env.KORTIX_STATIC_PORT,
    KORTIX_WORKSPACE: env.KORTIX_WORKSPACE,
    KORTIX_PROJECT_TARGET: env.KORTIX_PROJECT_TARGET,
    KORTIX_DEFAULT_BRANCH: env.KORTIX_DEFAULT_BRANCH,
    KORTIX_BRANCH_FETCH_ATTEMPTS: env.KORTIX_BRANCH_FETCH_ATTEMPTS,
    KORTIX_BRANCH_FETCH_DELAY: env.KORTIX_BRANCH_FETCH_DELAY,
    KORTIX_DEFAULT_OPENCODE_CONFIG_DIR: env.KORTIX_DEFAULT_OPENCODE_CONFIG_DIR,
    KORTIX_PROJECT_AUTO_CLONE: env.KORTIX_PROJECT_AUTO_CLONE,
    KORTIX_PROJECT_ID: env.KORTIX_PROJECT_ID,
    KORTIX_API_URL: env.KORTIX_API_URL,
    KORTIX_REPO_URL: env.KORTIX_REPO_URL,
    KORTIX_BRANCH_NAME: env.KORTIX_BRANCH_NAME,
    KORTIX_SESSION_FRESH: env.KORTIX_SESSION_FRESH,
    KORTIX_BASE_SHA: env.KORTIX_BASE_SHA,
    KORTIX_TOKEN: env.KORTIX_TOKEN,
    KORTIX_GIT_USER_NAME: env.KORTIX_GIT_USER_NAME,
    KORTIX_GIT_USER_EMAIL: env.KORTIX_GIT_USER_EMAIL,
    KORTIX_CLONE_FILTER: env.KORTIX_CLONE_FILTER,
  })

  return {
    servicePort: parsed.KORTIX_SERVICE_PORT,
    opencodeInternalPort: parsed.KORTIX_OPENCODE_INTERNAL_PORT,
    staticPort: parsed.KORTIX_STATIC_PORT,
    workspace: parsed.KORTIX_WORKSPACE,
    projectTarget: parsed.KORTIX_PROJECT_TARGET,
    defaultBranch: parsed.KORTIX_DEFAULT_BRANCH,
    branchFetchAttempts: parsed.KORTIX_BRANCH_FETCH_ATTEMPTS,
    branchFetchDelaySec: parsed.KORTIX_BRANCH_FETCH_DELAY,
    defaultOpencodeConfigDir: parsed.KORTIX_DEFAULT_OPENCODE_CONFIG_DIR,
    autoClone: parsed.KORTIX_PROJECT_AUTO_CLONE,
    projectId: parsed.KORTIX_PROJECT_ID,
    apiUrl: parsed.KORTIX_API_URL,
    repoUrl: parsed.KORTIX_REPO_URL,
    branchName: parsed.KORTIX_BRANCH_NAME,
    sessionFresh: parsed.KORTIX_SESSION_FRESH === '1',
    baseSha: parsed.KORTIX_BASE_SHA,
    kortixToken: parsed.KORTIX_TOKEN,
    gitUserName: parsed.KORTIX_GIT_USER_NAME,
    gitUserEmail: parsed.KORTIX_GIT_USER_EMAIL,
    cloneFilter: parsed.KORTIX_CLONE_FILTER,
  }
}

/**
 * Pick the opencode config dir for this sandbox. Honors `[opencode] config_dir`
 * in the project's kortix.toml when present (defaulting to `.kortix/opencode`
 * relative to the cloned repo) and falls back to KORTIX_DEFAULT_OPENCODE_CONFIG_DIR
 * if the project doesn't have an opencode.jsonc — that's what keeps a freshly
 * provisioned sandbox bootable before a project has been cloned.
 */
/**
 * Read `[sandbox] on_boot` from the project's kortix.toml — a shell command the
 * daemon runs (backgrounded) once the repo is materialized and opencode is up,
 * so a session can auto-start its dev stack (e.g. `on_boot = "pnpm dev"`).
 * Returns null when unset. Parsed with the same regex approach as
 * resolveOpencodeConfigDir (no TOML dep in the daemon).
 */
export async function resolveSandboxOnBoot(cfg: Config): Promise<string | null> {
  const fs = await import('node:fs/promises')
  let body: string
  try {
    body = await fs.readFile(`${cfg.projectTarget}/kortix.toml`, 'utf8')
  } catch {
    return null
  }
  // The `[sandbox]` table body runs up to the next `[section]` (e.g.
  // `[[sandbox.templates]]`) or end of file.
  const sectionMatch = body.match(/^\[sandbox\]\s*$([\s\S]*?)(?=^\s*\[|(?![\s\S]))/m)
  const sectionBody = sectionMatch?.[1]
  if (!sectionBody) return null
  const keyMatch = sectionBody.match(/^\s*on_boot\s*=\s*['"]([^'"]+)['"]/m)
  const cmd = keyMatch?.[1]?.trim()
  return cmd && cmd.length > 0 ? cmd : null
}

export async function resolveOpencodeConfigDir(cfg: Config): Promise<string> {
  const fs = await import('node:fs/promises')
  const manifestPath = `${cfg.projectTarget}/kortix.toml`
  const relConfigDir = await readOpencodeConfigDirFromManifest(fs, manifestPath)
  const candidate = `${cfg.projectTarget}/${relConfigDir}`
  for (const filename of ['opencode.jsonc', 'opencode.json']) {
    try {
      const stat = await fs.stat(`${candidate}/${filename}`)
      if (stat.isFile()) {
        try {
          await fs.mkdir(candidate, { recursive: true })
        } catch {}
        return candidate
      }
    } catch {}
  }
  try {
    await fs.mkdir(cfg.defaultOpencodeConfigDir, { recursive: true })
  } catch {}
  return cfg.defaultOpencodeConfigDir
}

/**
 * Pluck `[opencode] config_dir` out of a kortix.toml without dragging in a
 * full TOML parser. The field has one canonical shape; we look for it
 * explicitly and fall back to the default if anything's off.
 */
async function readOpencodeConfigDirFromManifest(
  fs: typeof import('node:fs/promises'),
  manifestPath: string,
): Promise<string> {
  const fallback = '.kortix/opencode'
  let body: string
  try {
    body = await fs.readFile(manifestPath, 'utf8')
  } catch {
    return fallback
  }
  // Match the `[opencode]` table body up to the next `[section]` line or the
  // end of the file. `\Z` is NOT a valid JS anchor (it matches a literal `Z`),
  // so use `(?![\s\S])` for end-of-string — otherwise an `[opencode]` table
  // that's the LAST section in the manifest never matches and silently falls
  // back to the default config dir.
  const sectionMatch = body.match(/^\[opencode\]\s*$([\s\S]*?)(?=^\s*\[|(?![\s\S]))/m)
  const sectionBody = sectionMatch?.[1]
  if (!sectionBody) return fallback
  const keyMatch = sectionBody.match(/^\s*config_dir\s*=\s*['"]([^'"]+)['"]/m)
  const rawValue = keyMatch?.[1]
  if (!rawValue) return fallback
  const raw = rawValue.trim().replace(/\/+$/, '')
  // Reject absolute paths and parent traversal — matches the API's validator.
  if (!raw || raw.startsWith('/') || raw.split('/').includes('..')) return fallback
  return raw
}
