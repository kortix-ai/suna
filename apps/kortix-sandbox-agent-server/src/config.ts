import { z } from 'zod'

/**
 * Env contract for kortix-sandbox-agent-server.
 *
 * Names must stay aligned with apps/api/src/projects/index.ts: the API
 * passes KORTIX_PROJECT_AUTO_CLONE / KORTIX_REPO_URL / KORTIX_BRANCH_NAME /
 * KORTIX_DEFAULT_BRANCH / KORTIX_PROJECT_ID / KORTIX_API_URL /
 * KORTIX_SERVICE_PORT to Daytona at sandbox creation time. The provider layer
 * injects the sandbox credential as KORTIX_SANDBOX_TOKEN (with KORTIX_TOKEN kept
 * as a back-compat alias for daemons baked before the rename). It is the daemon's
 * own identity: the HMAC key for X-Kortix-User-Context validation AND the bearer
 * for the sandbox-identity routes (clone-credential / turn-stream / turn-question).
 * It is distinct from the SESSION token (KORTIX_CLI_TOKEN), which acts as the
 * launching user. Git provider credentials are fetched just-in-time from apps/api.
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
  // The sandbox credential. KORTIX_SANDBOX_TOKEN is canonical; KORTIX_TOKEN is
  // the legacy alias (resolved with a fallback below).
  KORTIX_SANDBOX_TOKEN: z.string().optional(),
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
  /** The sandbox credential (HMAC key + sandbox-identity route bearer). NOT the
   *  session/user token — see the module doc. */
  sandboxToken: string | undefined
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
    KORTIX_SANDBOX_TOKEN: env.KORTIX_SANDBOX_TOKEN,
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
    // Canonical name wins; fall back to the legacy alias so daemons running in
    // older-API sandboxes (which only inject KORTIX_TOKEN) still resolve it.
    sandboxToken: parsed.KORTIX_SANDBOX_TOKEN ?? parsed.KORTIX_TOKEN,
    gitUserName: parsed.KORTIX_GIT_USER_NAME,
    gitUserEmail: parsed.KORTIX_GIT_USER_EMAIL,
    cloneFilter: parsed.KORTIX_CLONE_FILTER,
  }
}

type ManifestFormat = 'yaml' | 'toml'

/**
 * Read the project manifest, preferring the canonical `kortix.yaml` (schema v2)
 * and falling back to the legacy `kortix.toml` (v1) — the same resolution order
 * the API and CLI use. Returns null when neither file exists. The daemon has no
 * TOML/YAML parser dependency, so callers regex the returned body per `format`.
 */
async function readProjectManifest(
  fs: typeof import('node:fs/promises'),
  projectTarget: string,
): Promise<{ body: string; format: ManifestFormat } | null> {
  const candidates: { file: string; format: ManifestFormat }[] = [
    { file: 'kortix.yaml', format: 'yaml' },
    { file: 'kortix.yml', format: 'yaml' },
    { file: 'kortix.toml', format: 'toml' },
  ]
  for (const { file, format } of candidates) {
    try {
      return { body: await fs.readFile(`${projectTarget}/${file}`, 'utf8'), format }
    } catch {}
  }
  return null
}

/**
 * Pull a single string value at `<section>.<key>` out of a manifest body without
 * a full parser. Handles both shapes:
 *   YAML — `section:` then an indented `key: value` (value optionally quoted)
 *   TOML — `[section]` then `key = "value"` (value quoted)
 * Returns null if the section/key is absent or the value is empty.
 */
function extractNestedString(
  body: string,
  format: ManifestFormat,
  section: string,
  key: string,
): string | null {
  if (format === 'toml') {
    // The `[section]` table body runs up to the next `[…]` header or EOF.
    // `(?![\s\S])` is the JS end-of-string anchor (`\Z` matches a literal Z).
    const sectionMatch = body.match(
      new RegExp(`^\\[${section}\\]\\s*$([\\s\\S]*?)(?=^\\s*\\[|(?![\\s\\S]))`, 'm'),
    )
    const sectionBody = sectionMatch?.[1]
    if (!sectionBody) return null
    const keyMatch = sectionBody.match(new RegExp(`^\\s*${key}\\s*=\\s*['"]([^'"]+)['"]`, 'm'))
    const value = keyMatch?.[1]?.trim()
    return value && value.length > 0 ? value : null
  }
  // YAML: a top-level `section:` mapping whose block is the indented lines that
  // follow, up to the next non-indented (non-blank) line or EOF.
  const sectionMatch = body.match(
    new RegExp(`^${section}:\\s*$([\\s\\S]*?)(?=^\\S|(?![\\s\\S]))`, 'm'),
  )
  const sectionBody = sectionMatch?.[1]
  if (!sectionBody) return null
  const keyMatch = sectionBody.match(
    new RegExp(`^\\s+${key}\\s*:\\s*(?:['"]([^'"]+)['"]|([^\\s#][^#\\n]*?))\\s*(?:#.*)?$`, 'm'),
  )
  const value = (keyMatch?.[1] ?? keyMatch?.[2])?.trim()
  return value && value.length > 0 ? value : null
}

/**
 * Read `sandbox.on_boot` from the project manifest — a shell command the daemon
 * runs (backgrounded) once the repo is materialized and opencode is up, so a
 * session can auto-start its dev stack (e.g. `on_boot: "pnpm dev"`). Resolves
 * kortix.yaml first, then legacy kortix.toml. Returns null when unset.
 */
export async function resolveSandboxOnBoot(cfg: Config): Promise<string | null> {
  const fs = await import('node:fs/promises')
  const manifest = await readProjectManifest(fs, cfg.projectTarget)
  if (!manifest) return null
  return extractNestedString(manifest.body, manifest.format, 'sandbox', 'on_boot')
}

/**
 * Pick the opencode config dir for this sandbox. Honors `opencode.config_dir` in
 * the project's manifest (kortix.yaml, or legacy kortix.toml) when present,
 * defaulting to `.kortix/opencode` relative to the cloned repo, and falls back
 * to KORTIX_DEFAULT_OPENCODE_CONFIG_DIR if the project doesn't have an
 * opencode.jsonc — that's what keeps a freshly provisioned sandbox bootable
 * before a project has been cloned.
 */
export async function resolveOpencodeConfigDir(cfg: Config): Promise<string> {
  const fs = await import('node:fs/promises')
  const relConfigDir = await readOpencodeConfigDirFromManifest(fs, cfg.projectTarget)
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
 * Pluck `opencode.config_dir` out of the project manifest without dragging in a
 * full parser. Resolves kortix.yaml first, then legacy kortix.toml, and reads
 * the field from whichever format it found. Falls back to the default if the
 * manifest is absent or anything's off.
 */
async function readOpencodeConfigDirFromManifest(
  fs: typeof import('node:fs/promises'),
  projectTarget: string,
): Promise<string> {
  const fallback = '.kortix/opencode'
  const manifest = await readProjectManifest(fs, projectTarget)
  if (!manifest) return fallback
  const rawValue = extractNestedString(manifest.body, manifest.format, 'opencode', 'config_dir')
  if (!rawValue) return fallback
  const raw = rawValue.trim().replace(/\/+$/, '')
  // Reject absolute paths and parent traversal — matches the API's validator.
  if (!raw || raw.startsWith('/') || raw.split('/').includes('..')) return fallback
  return raw
}
