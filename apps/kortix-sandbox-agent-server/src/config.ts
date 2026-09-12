import { z } from 'zod'
import { resolveHarness } from './harness/harness'

/**
 * Env contract for kortix-sandbox-agent-server.
 *
 * Names must stay aligned with apps/api/src/projects/index.ts: the API
 * passes KORTIX_PROJECT_AUTO_CLONE / KORTIX_REPO_URL / KORTIX_BRANCH_NAME /
 * KORTIX_DEFAULT_BRANCH / KORTIX_PROJECT_ID / KORTIX_API_URL /
 * KORTIX_SERVICE_PORT to Daytona at sandbox creation time. The provider layer
 * injects one session-scoped KORTIX_TOKEN. It authenticates daemon, CLI,
 * connector, Git-proxy and LLM-gateway requests. Each API route applies its own
 * narrower authorization. Upstream credentials remain server-side.
 */

const BoolFlag = z.preprocess((v) => {
  if (typeof v !== 'string') return false
  const s = v.trim().toLowerCase()
  return s === '1' || s === 'true' || s === 'yes' || s === 'on'
}, z.boolean())

export const CompiledBootModeSchema = z.enum(['off', 'shadow', 'prefer', 'required'])
export type CompiledBootMode = z.infer<typeof CompiledBootModeSchema>

const Schema = z.object({
  KORTIX_SERVICE_PORT: z.coerce.number().int().positive().default(8000),
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
  KORTIX_PROJECT_AUTO_CLONE: BoolFlag.default(false),
  KORTIX_PROJECT_ID: z.string().optional(),
  KORTIX_API_URL: z.string().optional(),
  KORTIX_REPO_URL: z.string().optional(),
  KORTIX_BRANCH_NAME: z.string().optional(),
  KORTIX_SESSION_FRESH: z.string().optional(),
  KORTIX_SESSION_BRANCH_RESTORE: z.string().optional(),
  KORTIX_BASE_SHA: z.string().optional(),
  KORTIX_GIT_DELTA_BUNDLE_BASE64: z.string().optional(),
  KORTIX_GIT_DELTA_PARENT_SHA: z.string().optional(),
  KORTIX_GIT_DELTA_PARENT_COMMIT_BASE64: z.string().optional(),
  KORTIX_GIT_DELTA_BUNDLE_REMOTE: z.string().optional(),
  KORTIX_COMPILED_BOOT_MODE: CompiledBootModeSchema.default('off'),
  KORTIX_TOKEN: z.string().optional(),
  KORTIX_GIT_USER_NAME: z.string().default('Kortix Agent'),
  KORTIX_GIT_USER_EMAIL: z.string().default('agent@kortix.ai'),
  // Depth of the boot-time `git clone`. 1 (the default) is a SHALLOW clone:
  // one commit, no history — the only thing a fresh session's working tree
  // actually needs at boot. History is restored right after boot by a
  // background `fetch --unshallow` (see scheduleHistoryBackfill in git.ts), so
  // `git log`/`blame`/`diff` work by the time an agent could ask for them.
  // 0 clones full history inline (the old behaviour).
  //
  // Measured 2026-07-25 on kortix-ai/company, direct to GitHub: full 5462ms
  // (27MB / 758 commits) vs --depth 1 3516ms (25MB / 1 commit). A real but
  // MODEST win — history is only ~2MB of that repo, so shallow buys ~1.5x, not
  // an order of magnitude. The bulk of a clone is the working tree, which no
  // depth setting avoids; only baking the repo into the image does (warm
  // images). Do not expect this flag alone to fix boot latency.
  //
  // --filter=blob:none measured 6161ms — SLOWER than a full clone — on top of
  // stalling on lazy blob fetches through the git proxy, which is why the API
  // forces no filter. Shallow has neither problem: one pack, no on-demand
  // fetches.
  KORTIX_CLONE_DEPTH: z.coerce.number().int().min(0).default(1),
  // Partial-clone filter for the boot-time `git clone`. Empty (the default)
  // means no filter. Prefer KORTIX_CLONE_DEPTH — a blobless clone measured
  // slower than a full one and defers cost into unpredictable mid-session
  // stalls. Kept for remotes where shallow is unavailable.
  KORTIX_CLONE_FILTER: z.string().default(''),
  // ── Monitor box (docs/specs/2026-08-12-monitors.md) ──────────────────────
  // `monitor` selects the daemon's monitor mode: it clones the repo, skips
  // opencode entirely, and supervises the project's monitor processes instead.
  // Anything else (including unset) is the normal session daemon.
  KORTIX_WORKLOAD: z.string().default(''),
  // The enabled monitors, resolved from kortix.yaml BY apps/api and injected as
  // JSON. The daemon deliberately does not parse the manifest: one parser means
  // the box can never disagree with the platform about what a monitor is.
  KORTIX_MONITORS: z.string().default(''),
  // This boot's epoch, minted by the reconciler and stored on the box row. The
  // ingest route rejects any batch stamped with another value, so events from a
  // superseded boot can never fire.
  KORTIX_MONITOR_BOX_EPOCH: z.string().default(''),
})

/** Host configuration. Native adapters own and validate their additional fields. */
export type Config = {
  servicePort: number
  staticPort: number
  workspace: string
  projectTarget: string
  defaultBranch: string
  branchFetchAttempts: number
  branchFetchDelaySec: number
  autoClone: boolean
  projectId: string | undefined
  apiUrl: string | undefined
  repoUrl: string | undefined
  branchName: string | undefined
  sessionFresh: boolean
  sessionBranchRestore?: boolean
  baseSha: string | undefined
  gitDeltaBundleBase64?: string
  gitDeltaParentSha?: string
  gitDeltaParentCommitBase64?: string
  /** Delta exceeds the env cap: fetch it with one GET from the API (KORTIX_GIT_DELTA_BUNDLE_REMOTE=1). */
  gitDeltaBundleRemote?: boolean
  compiledBootMode: CompiledBootMode
  /** The sandbox credential (HMAC key + sandbox-identity route bearer). NOT the
   *  session/user token — see the module doc. */
  sandboxToken: string | undefined
  gitUserName: string
  gitUserEmail: string
  cloneFilter: string
  cloneDepth: number
  /** `'monitor'` selects monitor mode; '' (the default) is the session daemon. */
  workload: string
  /** Raw `KORTIX_MONITORS` JSON; parsed by monitor-runner.parseMonitorSpecs. */
  monitorsJson: string
  /** The box epoch this boot must stamp on every ingest batch. */
  monitorBoxEpoch: string
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Schema.parse({
    KORTIX_SERVICE_PORT: env.KORTIX_SERVICE_PORT,
    KORTIX_STATIC_PORT: env.KORTIX_STATIC_PORT,
    KORTIX_WORKSPACE: env.KORTIX_WORKSPACE,
    KORTIX_PROJECT_TARGET: env.KORTIX_PROJECT_TARGET,
    KORTIX_DEFAULT_BRANCH: env.KORTIX_DEFAULT_BRANCH,
    KORTIX_BRANCH_FETCH_ATTEMPTS: env.KORTIX_BRANCH_FETCH_ATTEMPTS,
    KORTIX_BRANCH_FETCH_DELAY: env.KORTIX_BRANCH_FETCH_DELAY,
    KORTIX_PROJECT_AUTO_CLONE: env.KORTIX_PROJECT_AUTO_CLONE,
    KORTIX_PROJECT_ID: env.KORTIX_PROJECT_ID,
    KORTIX_API_URL: env.KORTIX_API_URL,
    KORTIX_REPO_URL: env.KORTIX_REPO_URL,
    KORTIX_BRANCH_NAME: env.KORTIX_BRANCH_NAME,
    KORTIX_SESSION_FRESH: env.KORTIX_SESSION_FRESH,
    KORTIX_SESSION_BRANCH_RESTORE: env.KORTIX_SESSION_BRANCH_RESTORE,
    KORTIX_BASE_SHA: env.KORTIX_BASE_SHA,
    KORTIX_GIT_DELTA_BUNDLE_BASE64: env.KORTIX_GIT_DELTA_BUNDLE_BASE64,
    KORTIX_GIT_DELTA_PARENT_SHA: env.KORTIX_GIT_DELTA_PARENT_SHA,
    KORTIX_GIT_DELTA_PARENT_COMMIT_BASE64: env.KORTIX_GIT_DELTA_PARENT_COMMIT_BASE64,
    KORTIX_GIT_DELTA_BUNDLE_REMOTE: env.KORTIX_GIT_DELTA_BUNDLE_REMOTE,
    KORTIX_COMPILED_BOOT_MODE: env.KORTIX_COMPILED_BOOT_MODE,
    KORTIX_TOKEN: env.KORTIX_TOKEN,
    KORTIX_GIT_USER_NAME: env.KORTIX_GIT_USER_NAME,
    KORTIX_GIT_USER_EMAIL: env.KORTIX_GIT_USER_EMAIL,
    KORTIX_CLONE_FILTER: env.KORTIX_CLONE_FILTER,
    KORTIX_CLONE_DEPTH: env.KORTIX_CLONE_DEPTH,
    KORTIX_WORKLOAD: env.KORTIX_WORKLOAD,
    KORTIX_MONITORS: env.KORTIX_MONITORS,
    KORTIX_MONITOR_BOX_EPOCH: env.KORTIX_MONITOR_BOX_EPOCH,
  })

  return {
    ...resolveHarness().loadConfig(env),
    servicePort: parsed.KORTIX_SERVICE_PORT,
    staticPort: parsed.KORTIX_STATIC_PORT,
    workspace: parsed.KORTIX_WORKSPACE,
    projectTarget: parsed.KORTIX_PROJECT_TARGET,
    defaultBranch: parsed.KORTIX_DEFAULT_BRANCH,
    branchFetchAttempts: parsed.KORTIX_BRANCH_FETCH_ATTEMPTS,
    branchFetchDelaySec: parsed.KORTIX_BRANCH_FETCH_DELAY,
    autoClone: parsed.KORTIX_PROJECT_AUTO_CLONE,
    projectId: parsed.KORTIX_PROJECT_ID,
    apiUrl: parsed.KORTIX_API_URL,
    repoUrl: parsed.KORTIX_REPO_URL,
    branchName: parsed.KORTIX_BRANCH_NAME,
    sessionFresh: parsed.KORTIX_SESSION_FRESH === '1',
    sessionBranchRestore: parsed.KORTIX_SESSION_BRANCH_RESTORE === '1',
    baseSha: parsed.KORTIX_BASE_SHA,
    gitDeltaBundleBase64: parsed.KORTIX_GIT_DELTA_BUNDLE_BASE64,
    gitDeltaParentSha: parsed.KORTIX_GIT_DELTA_PARENT_SHA,
    gitDeltaParentCommitBase64: parsed.KORTIX_GIT_DELTA_PARENT_COMMIT_BASE64,
    gitDeltaBundleRemote: parsed.KORTIX_GIT_DELTA_BUNDLE_REMOTE === '1',
    compiledBootMode: parsed.KORTIX_COMPILED_BOOT_MODE,
    sandboxToken: parsed.KORTIX_TOKEN,
    gitUserName: parsed.KORTIX_GIT_USER_NAME,
    gitUserEmail: parsed.KORTIX_GIT_USER_EMAIL,
    cloneFilter: parsed.KORTIX_CLONE_FILTER,
    cloneDepth: parsed.KORTIX_CLONE_DEPTH,
    workload: parsed.KORTIX_WORKLOAD.trim(),
    monitorsJson: parsed.KORTIX_MONITORS,
    monitorBoxEpoch: parsed.KORTIX_MONITOR_BOX_EPOCH.trim(),
  }
}

type ManifestFormat = 'yaml' | 'toml'

/**
 * Read the project manifest, preferring the canonical `kortix.yaml` (schema v2)
 * and falling back to the legacy `kortix.toml` (v1) — the same resolution order
 * the API and CLI use. Returns null when neither file exists. The daemon has no
 * TOML/YAML parser dependency, so callers regex the returned body per `format`.
 */
export async function readProjectManifest(
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
export function extractNestedString(
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
