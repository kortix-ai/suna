import { hydrateEnvironmentSecret } from '@kortix/shared';
import { z } from '@hono/zod-openapi';
import { SLACK_BOT_SCOPES } from './channels/slack-manifest';
import {
  DEFAULT_LLM_GATEWAY_FALLBACK_POLICIES,
  parseFallbackPolicies,
} from './llm-gateway/routing/policy-config';

hydrateEnvironmentSecret();

/**
 * Running sandbox version.
 *
 * Source of truth: SANDBOX_VERSION env var, injected at container start
 * by deploy-zero-downtime.sh (extracted from the Docker image tag).
 * Falls back to 'unknown' only if the env var is missing.
 */
export const SANDBOX_VERSION = process.env.SANDBOX_VERSION || 'unknown';

// ─── Types ──────────────────────────────────────────────────────────────────

// Platinum is the reference provider. Daytona is a legacy fallback: its
// removal is scheduled, existing Daytona sessions keep working for now, and it
// gets no new features and no support guarantee. E2B support is discontinued;
// the DB enum keeps `e2b` only so legacy rows stay readable.
export type SandboxProviderName = 'platinum' | 'daytona';
type InternalKortixEnv = 'dev' | 'staging' | 'prod' | 'preview';

// ─── Zod Helpers ────────────────────────────────────────────────────────────

/** Optional string — defaults to empty string when missing or empty. */
const optStr = z.string().optional().default('');

/** Optional string with a custom default value. */
const optStrDefault = (def: string) => z.string().optional().default(def);

/** Optional URL string with a custom default. Not required, just validated if present. */
const optUrl = (def: string) =>
  z
    .string()
    .optional()
    .default(def)
    .refine((v) => v === '' || /^https?:\/\//.test(v), { message: 'Must be a valid HTTP(S) URL' });

/** Optional int with a default. */
const optInt = (def: number) =>
  z
    .string()
    .optional()
    .default(String(def))
    .transform((v) => {
      const n = Number.parseInt(v, 10);
      return Number.isNaN(n) ? def : n;
    });

/** Optional boolean. optBoolFalse accepts the common truthy spellings
 * (case-insensitive) so a "1" / "yes" / "on" from a k8s env or secret bundle
 * isn't silently dropped. optBoolTrue keeps its original 'anything but false'
 * rule. */
const optBoolTrue = z
  .string()
  .optional()
  .default('true')
  .transform((v) => v !== 'false');
const optBoolFalse = z
  .string()
  .optional()
  .default('false')
  .transform((v) => ['true', '1', 'yes', 'on'].includes(v.trim().toLowerCase()));
/** Tri-state boolean: stays `undefined` when unset so a deployment-aware
 * default can be derived after parsing (see KORTIX_MANAGED_PROVIDER_ENABLED,
 * which follows the billing flag when not explicitly set). */
const optBoolUnset = z
  .string()
  .optional()
  .transform((v) =>
    v === undefined ? undefined : ['true', '1', 'yes', 'on'].includes(v.trim().toLowerCase()),
  );

/** Declarative, operator-defined model fallback policies. */
const optFallbackPolicies = z
  .string()
  .optional()
  .default(DEFAULT_LLM_GATEWAY_FALLBACK_POLICIES)
  .transform((raw, ctx) => {
    try {
      return parseFallbackPolicies(raw);
    } catch (err) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: err instanceof Error ? err.message : String(err),
      });
    }
    return z.NEVER;
  });

// ─── Env Schema ─────────────────────────────────────────────────────────────
//
// Every env var that kortix-api reads is declared here.
// Categories:
//   - REQUIRED:    server will not start without these
//   - CONDITIONAL: required when a related feature is enabled
//   - OPTIONAL:    graceful degradation or sane default if missing

const envSchema = z.object({
  // ── Core (required) ──────────────────────────────────────────────────────
  PORT: optInt(8008),

  // ── Database (REQUIRED) ──────────────────────────────────────────────────
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required — cannot start without a database'),
  // Debug only: append each SQL statement the API pool sends (whitespace-normalized
  // text, no params) as one line to this file. Empty = off.
  KORTIX_SQL_TRACE: optStr,

  // ── Supabase (REQUIRED) ──────────────────────────────────────────────────
  SUPABASE_URL: z
    .string()
    .min(1, 'SUPABASE_URL is required')
    .refine((v) => /^https?:\/\//.test(v), { message: 'SUPABASE_URL must be a valid HTTP(S) URL' }),
  // Public origin for CLIENT-facing Supabase Storage URLs. On a self-host box
  // SUPABASE_URL is an internal Docker hostname (http://supabase-kong:8000) that
  // no browser/CLI/remote-sandbox can resolve; this is the box's public origin
  // (e.g. https://sampleco.kortix.cloud) used to rewrite signed URLs on the way
  // out (see toPublicStorageUrl). Optional: unset on managed cloud, where
  // SUPABASE_URL is already public and no rewrite is needed.
  SUPABASE_PUBLIC_URL: z
    .string()
    .refine((v) => v === '' || /^https?:\/\//.test(v), {
      message: 'SUPABASE_PUBLIC_URL must be a valid HTTP(S) URL',
    })
    .optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, 'SUPABASE_SERVICE_ROLE_KEY is required'),
  // The Supabase anon key. PUBLIC by design (every browser gets it from the
  // web runtime config); the API only hands it to clients through
  // GET /v1/auth/client-config so a native app can sign in from the API URL.
  SUPABASE_ANON_KEY: optStr,
  // Sign-in options the web auth page renders (apps/web/src/lib/env-config.ts
  // reads the same names). Unset = not reported (client-config returns null);
  // set to '' = none.
  KORTIX_PUBLIC_AUTH_METHODS: z.string().optional(),
  KORTIX_PUBLIC_AUTH_PROVIDERS: z.string().optional(),
  // Auth confirms every email sign-up without sending mail. The self-host CLI
  // writes this to .env and GoTrue reads it as GOTRUE_MAILER_AUTOCONFIRM; the
  // kortix-api service loads the same .env (env_file), so both read one value.
  // `kortix self-host env set EMAIL_URL=…` turns it off. While it is on, a
  // password email proves nothing (iam/email-trust.ts). Unset on cloud.
  ENABLE_EMAIL_AUTOCONFIRM: optBoolFalse,
  // Legacy symmetric (HS256) JWT secret of the Supabase project. When set, the
  // API checks an HS256 access token's signature and expiry locally instead of
  // asking GoTrue on every request (shared/jwt-verify.ts). Optional: without it
  // HS256 tokens keep the per-request GoTrue round trip.
  SUPABASE_JWT_SECRET: optStr,

  // ── Prompt attachment uploads (optional, non-secret) ────────────────────
  // `direct` (default): the client PUTs each file once to a signed Storage URL.
  // `chunked`: the client PUTs bounded chunks through the API. Only for a
  // deployment whose public edge drops large request bodies (the PR preview).
  PROMPT_ATTACHMENT_UPLOAD_MODE: z.enum(['direct', 'chunked']).optional().default('direct'),
  // Bytes per chunk. Read only in `chunked` mode.
  PROMPT_ATTACHMENT_CHUNK_BYTES: optInt(65536).refine((bytes) => bytes > 0, {
    message: 'PROMPT_ATTACHMENT_CHUNK_BYTES must be a positive integer',
  }),

  // ── API Key Hashing (REQUIRED) ───────────────────────────────────────────
  API_KEY_SECRET: z.string().min(1, 'API_KEY_SECRET is required — API key hashing will fail'),

  // ── Internal Deployment Controls (optional, safe defaults for self-hosted) ─
  // `preview` = ephemeral per-PR API on EKS (shares the dev data plane, never
  // migrates it, workers off, allows preview frontends in CORS). See ensure-schema.ts + the CORS block in index.ts.
  INTERNAL_KORTIX_ENV: z.enum(['dev', 'staging', 'prod', 'preview']).optional().default('dev'),
  // Instance scope for BACKGROUND work on a shared database (local dev only:
  // worktrees + the primary `pnpm dev` share one Supabase, so the lifecycle
  // queue, env-sync fan-outs and the box reaper are one queue across every
  // running API). Set by the launchers (`scripts/dev-local.sh` → `primary`,
  // `scripts/worktree/lib/launch-env.ts` → the worktree name). Unset in every
  // deployed environment → every scope check is a no-op.
  // See projects/instance-scope.ts.
  KORTIX_INSTANCE_ID: z.string().trim().optional(),

  // Wildcard domain every preview ORIGIN sits under
  // (`{env}-p{port}-{sandbox}.{domain}`). Unset on managed cloud, where it is
  // derived as `p.<registrable domain of KORTIX_URL>`; set it on a self-host
  // whose DNS does not fit that shape. A deployment with neither keeps previews
  // on the path proxy. See sandbox-proxy/preview-hosts.ts.
  KORTIX_PREVIEW_BASE_DOMAIN: optStr,
  // Master switch: turns on real billing (Stripe + credit ledger), makes
  // KORTIX_URL fatal-required, mounts the proxy-auth gate, hides /v1/setup.
  // Set to true on managed/cloud deployments; leave false for self-host + dev.
  KORTIX_BILLING_INTERNAL_ENABLED: optBoolFalse,
  // Kortix Apps: a `static` App is served by the API from content-addressed
  // storage, with no runtime. `false` builds it into a sandbox, as before.
  KORTIX_APPS_STATIC_HOSTING: optBoolTrue,
  // Ready deployments an App keeps besides its active one (rollback targets).
  // Older ones are retired: runtime, image, files and archive are freed.
  KORTIX_APPS_RETAINED_DEPLOYMENTS: optInt(5),
  // New server Apps run 24/7 unless the request says otherwise. Existing Apps
  // keep their own setting. Static Apps have no runtime and ignore it.
  KORTIX_APPS_DEFAULT_ALWAYS_ON: optBoolTrue,
  // 'false' stops the Apps deployment worker; 'static' drives only static deployments.
  KORTIX_APPS_WORKER_ENABLED: optStr,
  // Global background-worker switch. API-only and migration-shadow deployments
  // keep request handling active while disabling every recurring write loop.
  KORTIX_WORKERS_ENABLED: optBoolTrue,
  // Kill switch for the scheduled account-deletion sweep. True skips every
  // scheduled run; immediate deletion is unaffected. Default off (sweep runs).
  ACCOUNT_DELETION_SWEEP_PAUSED: optBoolFalse,
  /**
   * Enforce the sandbox egress pin on the secret-broker route (default ON).
   *
   * A kill switch, not a feature flag. The pin blocks a session token used from
   * outside its own sandbox — but the broker route also serves
   * `kortix secrets call` and the connector MCP, so if a provider ever
   * reassigns a running sandbox's egress address the pin would 403 real work.
   * Set this to `false` to fall back to log-only while that is investigated,
   * instead of reverting a deploy. Watch for `[secret-broker] refused an
   * off-sandbox token use`.
   */
  KORTIX_SANDBOX_EGRESS_PIN_ENFORCED: optBoolTrue,
  /**
   * Hosts a connector may call even though they resolve to a private address.
   * Comma-separated hostnames or IP literals, matched exactly. Empty (the
   * default) means every connector endpoint must be a public address. Set it
   * on a self-hosted deployment whose connectors call internal APIs; the local
   * test stack sets `127.0.0.1` for its loopback upstream.
   */
  KORTIX_CONNECTOR_EGRESS_ALLOW_HOSTS: optStr,
  /**
   * The same allowlist for a project's custom LLM provider (Models → Custom):
   * the gateway calls its base URL from inside our network, so by default it
   * must resolve to a public address. Set it on a self-hosted deployment whose
   * models run on an internal host (Ollama, vLLM).
   */
  KORTIX_LLM_CUSTOM_PROVIDER_ALLOW_HOSTS: optStr,

  // ── Streaming secret relay (POST /v1/projects/:id/secrets/:id/relay) ──────
  //
  // The kill switch. `false` makes /relay answer 503 `relay_disabled` with no
  // image rebuild; the in-guest shim probes once at construction, so NEW
  // sessions fall back to the permanent buffered /broker route immediately.
  // In-flight relay-mode sessions get a 503 per request and the agent retries —
  // the honest, documented limitation of a construction-time probe. The
  // alternative (a capability header on every request) costs a round trip per
  // relayed request and still cannot un-consume a body already streamed.
  KORTIX_SECRET_RELAY_STREAM_ENABLED: optBoolTrue,
  // Byte budgets. These are a RESOURCE guard, not a product limit: 1 GiB is
  // 1024x the legacy request cap and 205x the response cap — effectively
  // uncapped for any real API call — but it stops one runaway sandbox.
  //
  // They are MANDATORY because Bun applies NO inbound flow control. Measured on
  // bun 1.3.14: a 200 MiB body into a 50 ms/chunk consumer produced 12 chunks,
  // one of them 23,003,148 bytes, and +113.6 MiB RSS. Neither documented lever
  // helps — `getReader({mode:'byob'})` throws (it needs a
  // ReadableByteStreamController) and `pipeTo` with
  // `CountQueuingStrategy({highWaterMark:1})` is byte-for-byte identical to
  // manual reads. The counter in the read loop is the ONLY guard that exists.
  // 0 = unlimited, for self-host operators who want no ceiling at all.
  KORTIX_RELAY_MAX_REQUEST_BYTES: optInt(1_073_741_824),
  KORTIX_RELAY_MAX_RESPONSE_BYTES: optInt(1_073_741_824),
  // Global ceiling on a request body, enforced from `Content-Length` before any
  // route reads it (http-middleware.ts). Bun's own default is 128 MiB, which an
  // anonymous caller could spend on a single JSON request. 0 = unlimited.
  KORTIX_MAX_REQUEST_BODY_BYTES: optInt(64 * 1024 * 1024),
  // Time to the upstream's RESPONSE HEADERS, not to completion. The legacy
  // broker's flat 30 s `REQUEST_TIMEOUT_MS` cannot become a total-duration
  // timeout here or every SSE stream would die at 30 s.
  KORTIX_RELAY_HEADERS_TIMEOUT_MS: optInt(30_000),
  // IDLE on the upstream response socket — never a total duration. 0 = off.
  KORTIX_RELAY_UPSTREAM_IDLE_TIMEOUT_MS: optInt(600_000),
  // Kortix-owned session titles: the moment a session's first prompt text is
  // known server-side (at create when it carries one, else on the first HTTP
  // prompt), generate the title ourselves via the internal LLM gateway instead
  // of relying on the harness summarizer. On by default; the kill-switch
  // disables title generation entirely — nothing else writes `metadata.name`,
  // so sessions then stay untitled and clients fall back to their display chain.
  SESSION_TITLE_GENERATION_ENABLED: optBoolTrue,
  // Generative UI kill switch. On by default; false => no session is taught the genui catalog,
  // whatever the project flag says. Blocks already in transcripts still render.
  GENUI_ENABLED: optBoolTrue,
  // Operator switch for the session-log journal ingest (`POST …/sessions/:s/log/journal`).
  // On by default. Off answers 503: each daemon keeps its unacknowledged changes and
  // retries with backoff, so turning it back on loses nothing the boxes still hold.
  SESSION_LOG_INGEST_ENABLED: optBoolTrue,
  // Operator switch for the session-log restore (`POST …/sessions/:s/log/restore`, P6.1).
  // On by default. Off answers 503 and claims nothing: the box boots without a restore.
  SESSION_LOG_RESTORE_ENABLED: optBoolTrue,
  // Default of the project flag `session_log_restore` for a project with no stored value. Off by
  // default; dev turns it on in its deploy overrides (deploy-dev.yml). A project's stored value wins.
  // Rollback: set it to "false" in the overrides. Removing the key keeps the running task's value.
  SESSION_LOG_RESTORE_DEFAULT_ENABLED: optBoolFalse,
  // The largest restore the API answers (`POST …/log/restore`), in bytes: the live messages' stored
  // JSON lengths plus 2/5 of the session's live blob bytes (full texts, attachments; ~15x in the daemon,
  // 30 MB of images: +455 MB; `SESSION_LOG_BLOB_WEIGHT`). So 24 MiB allows 24 MiB of records or 60 MiB
  // of blobs (~125 screenshots of 500 kB). Above it the claim still happens and the answer is 413 without messages:
  // the box boots with the D3 note alone. A pi restore peaks at about 38x the log in the daemon's
  // memory (a 38.5 MB log: +1.45 GB on a 4 GB box) and about 9x in the API (+330 MB). 24 MiB keeps the
  // daemon peak under 1 GB and is 1.6x the p99.9 session (15 MB; p99 3.7 MB).
  SESSION_LOG_RESTORE_MAX_BYTES: optInt(24 * 1024 * 1024),
  // How long `PUT …/log/blobs/<sha256>` waits for its body (P2.13): a body not read by then is
  // cancelled with 408 and its upload slot freed. Under the route's 95 s request deadline.
  SESSION_LOG_BLOB_READ_MS: optInt(60_000),
  // Operator switch for the retention purge of session content (P2.8, decision D6): session
  // rows 30 days after a delete, 80 days after a subscription end (inert until decision D6b), their files 7 days later.
  // On by default. Off stops the worker's tick; nothing it has not yet purged is touched.
  SESSION_LOG_PURGE_ENABLED: optBoolTrue,
  // The backfill of old sessions (P3.1, `projects/session-log-backfill.ts`): each session with
  // history only in the v1 mirror gets its v2 log. `write` (default since P8.2: no read serves the
  // mirror, so a self-hosted upgrade converts its own history) writes the logs (it also needs
  // SESSION_LOG_INGEST_ENABLED). `dry` converts in memory, writes nothing, and logs counts per
  // tick and per pass. `off` runs nothing. Leader only. The pass resumes across leaders
  // (`kortix.session_log_backfill_state`). A dry pass runs once per build (KORTIX_COMMIT): a new
  // build runs it again; on the same build, `DELETE FROM kortix.session_log_backfill_state`.
  // A mirror over the capture's size cap (~SESSION_LOG_RESTORE_MAX_BYTES of JSON) converts in a
  // Worker thread, only while the process has room for it (SESSION_LOG_BACKFILL_MEMORY_MB).
  SESSION_LOG_BACKFILL: z.enum(['off', 'dry', 'write']).optional().default('write'),
  // The API task's memory in MiB (prod and dev ECS tasks: 4096). The backfill starts a conversion
  // thread only while RSS plus its estimate stays under 75 % of this, or of cgroup memory.max when lower.
  SESSION_LOG_BACKFILL_MEMORY_MB: optInt(4096),
  // The source commit the image was built from (Dockerfile ARG, kept across the prod retag). 'unknown' locally.
  KORTIX_COMMIT: optStrDefault('unknown'),
  // Serve the public OpenAPI spec (/v1/openapi.json) + Scalar docs UI (/v1/docs).
  // On by default — the base API surface is meant to be discoverable. Internal
  // routers (/v1/admin, /v1/ops) are ALWAYS stripped from the spec regardless
  // (see openapi/index.ts filterSpecPaths); this flag lets a hardened self-host
  // deployment turn the whole docs/spec surface OFF so no route shapes publish.
  OPENAPI_PUBLIC_DOCS: optBoolTrue,
  // Mobile release policy, served by GET /v1/clients/mobile. A mobile build older
  // than MOBILE_MIN_VERSION (`major.minor.patch`) shows a blocking "update
  // required" screen. Unset: no gate. The store URLs are the update button's
  // targets; unset: the screen has no button.
  // A malformed value would make every device fail open, so it is a boot error.
  MOBILE_MIN_VERSION: optStr.refine(
    (v) => v.trim() === '' || /^v?\d+(\.\d+){0,2}$/.test(v.trim()),
    {
      message: 'Must be major.minor.patch',
    },
  ),
  MOBILE_STORE_URL_IOS: optUrl(''),
  MOBILE_STORE_URL_ANDROID: optUrl(''),
  // Self-host enterprise license: when the operator has purchased/holds a
  // Kortix Enterprise license, this bypasses the sales-assigned `enterprise`
  // tier check and unlocks every enterprise entitlement (SSO, SCIM, RBAC,
  // audit access) regardless of the account's billing tier — see
  // getAccountEntitlements()/accountHasEntitlement() in
  // billing/services/entitlements.ts. Off by default; billing is irrelevant
  // for a self-host license check.
  ENTERPRISE_LICENSE_AVAILABLE: optBoolFalse,
  // Self-host account-creation restriction: when true, POST /v1/accounts
  // (creating an ADDITIONAL/org account) is blocked with 403 for everyone
  // except a platform admin (KORTIX_PLATFORM_ADMIN_EMAILS — see
  // shared/platform-roles.ts's isPlatformAdmin). Deliberately narrower than
  // the removed KORTIX_SINGLE_ACCOUNT_MODE: signups still work, teams/orgs
  // still fully function, SSO/JIT still lands users in their org — only the
  // CREATION of new accounts by ordinary users is gated. The personal-account
  // bootstrap path (bootstrapPersonalAccount, called directly from GET
  // /v1/accounts on first login) does NOT route through this gate — every
  // user still gets their own landing account. Off by default (cloud is
  // unaffected); the self-host CLI defaults this to 'true'
  // (SHARED_FEATURE_FLAG_DEFAULTS) since a VPS operator usually wants to be
  // the only one who can spin up new organizations. The frontend mirrors this
  // with KORTIX_PUBLIC_RESTRICT_ACCOUNT_CREATION to hide "New account" UI for
  // non-admins.
  KORTIX_RESTRICT_ACCOUNT_CREATION: optBoolFalse,

  // ── Search Providers (optional — features degrade gracefully) ────────────
  TAVILY_API_URL: optUrl('https://api.tavily.com'),
  TAVILY_API_KEY: optStr,
  SERPER_API_URL: optUrl('https://google.serper.dev'),
  SERPER_API_KEY: optStr,

  // ── Proxy Providers (optional) ───────────────────────────────────────────
  FIRECRAWL_API_URL: optUrl('https://api.firecrawl.dev'),
  FIRECRAWL_API_KEY: optStr,

  // ── Managed git (provider-agnostic via the git proxy) ────────────────────
  // MANAGED_GIT_PROVIDER selects the backend NEW managed repos provision on
  // ('github' default). `code-storage` is RETIRED here and is refused by
  // `defaultManagedProviderId()` — a deployed bundle that still names it
  // provisions on github and logs a warning. Existing code.storage repos keep
  // resolving through their own connection row. The GitHub backend creates repos under
  // MANAGED_GIT_GITHUB_OWNER (a Kortix-owned org) via the Kortix App
  // installed there (MANAGED_GIT_GITHUB_INSTALL_ID). Reuses KORTIX_GITHUB_APP_*
  // for the App JWT. Each backend's isConfigured() checks its own vars, so
  // leaving these blank keeps the managed-git path inert.
  MANAGED_GIT_PROVIDER: optStr,
  MANAGED_GIT_GITHUB_OWNER: optStr,
  MANAGED_GIT_GITHUB_INSTALL_ID: optStr,
  // Optional straight org PAT for the managed org (the "one server-side key"
  // model). When set it takes precedence
  // over the GitHub App for managed-org admin ops (create/delete repo, invite
  // collaborator). Leave blank to use the App installation instead.
  MANAGED_GIT_GITHUB_TOKEN: optStr,
  // Second managed backend: code.storage (Pierre), a headless git-hosting API
  // (https://code.storage/docs). RETIRED as a provisioning target — it can no
  // longer be selected with MANAGED_GIT_PROVIDER. These credentials stay
  // because EXISTING projects still clone, fetch and push their repos through
  // it; clearing them breaks those projects, not new ones.
  // CODE_STORAGE_ORG: your code.storage organization identifier — doubles as
  // the JWT `iss` claim and (unless overridden) the git-remote/API host prefix.
  CODE_STORAGE_ORG: optStr,
  // PKCS8 PEM private key (EC or RSA — algorithm auto-detected) code.storage
  // issued you; signs every management-API and git-push/pull JWT server-side
  // (projects/git-backends/code-storage.ts's `mintCodeStorageJwt`). Never
  // logged, returned to a caller, or embedded verbatim — only its signatures
  // leave this process. \n-escaped or quote-wrapped values are normalized.
  CODE_STORAGE_PRIVATE_KEY: optStr,
  // Management API base URL. Defaults to `https://api.<CODE_STORAGE_ORG>.code.storage`
  // when blank; set only for a non-standard cluster mapping.
  CODE_STORAGE_API_BASE: optStr,
  // Git remote host for clone/push URLs. Defaults to `<CODE_STORAGE_ORG>.code.storage`
  // when blank.
  CODE_STORAGE_GIT_HOST: optStr,
  // ── Pause / resume tuning ─────────────────────────────────────────────────
  // The sandbox idle→stop / stop→archive / →delete intervals live below as
  // KORTIX_SANDBOX_AUTOSTOP_MINUTES / AUTOARCHIVE_MINUTES / AUTODELETE_MINUTES
  // (consumed by daytonaLifecycle()). Main's 3-day auto-archive default already
  // keeps a hibernated box in the fast-resume "stopped" tier far longer than the
  // earlier 120m, so the pause/resume win is subsumed there.
  // Mandatory declared agents. GATED OFF platform-wide by default — flipping it on would
  // immediately reject every session/trigger on a pre-existing, agent-less project.
  // The intent is ON for NEW projects: since there's no per-project flag store yet,
  // a project is "subject" to enforcement when EITHER this is true OR its own
  // `project.metadata.require_declared_agents === true` (stamped at creation —
  // see POST /projects/provision). When subject: an agent name not declared in
  // `[[agents]]`/`agents:` is rejected outright (never silently resolved to the
  // permissive null grant), and the `default` sentinel must resolve to a
  // *declared* default_agent. Non-subject projects keep the v1 adopt-to-govern
  // behavior (absence of `[[agents]]` → unrestricted) untouched.
  KORTIX_REQUIRE_DECLARED_AGENTS: optBoolFalse,

  // Supabase Storage bucket holding the durable per-sandbox backup bundle
  // (workspace files + OpenCode chat-history store). Source for rehydrate.
  LEGACY_MIGRATION_BACKUP_BUCKET: optStrDefault('legacy-migrations'),

  // ── Channels — Slack adapter (optional) ──────────────────────────────────
  SLACK_SIGNING_SECRET: optStr,
  SLACK_CLIENT_ID: optStr,
  SLACK_CLIENT_SECRET: optStr,
  SLACK_REDIRECT_URI: optStr,
  // Derived from the SINGLE scope source of truth (SLACK_BOT_SCOPES in
  // channels/slack-manifest.ts) so OAuth always grants exactly what the manifest
  // declares — no hand-synced drift. 100% bot-token scopes; the integration
  // never requests a user token (no user_scope= param).
  SLACK_OAUTH_SCOPES: optStrDefault(SLACK_BOT_SCOPES.join(',')),
  // Optional banner image rendered at the top of the App Home tab. Must be a
  // public HTTPS URL Slack can fetch (no auth). Recommended 1600×400 PNG.
  SLACK_HOME_HERO_URL: optStr,
  // Per-Slack-user identity. Default-on: each sender must link their own Kortix
  // account via `/kortix login` and the agent runs AS them; unlinked senders
  // are blocked. Set explicitly to "false" only for legacy fallback where
  // Slack messages should run as the bound project owner.
  SLACK_REQUIRE_USER_IDENTITY: optBoolTrue,

  // ── Channels — AgentMail email adapter (optional) ────────────────────────
  AGENTMAIL_API_URL: optUrl('https://api.agentmail.to/v0'),
  AGENTMAIL_API_KEY: optStr,
  AGENTMAIL_WEBHOOK_SECRET: optStr,

  // ── Channels — Telegram Bot API (connectors_v2). Overridable for tests. ──
  TELEGRAM_API_URL: optUrl('https://api.telegram.org'),

  // ── MCP apps (connectors_v2) — Kortix-owned OAuth clients ───────────────
  // JSON: {"google":{"client_id":"…","client_secret":"…"},"github":{…}}. One
  // client per vendor whose MCP server has no dynamic client registration
  // (connectors/mcp-apps.ts). An app whose client is absent is not listed.
  KORTIX_OAUTH_CLIENTS: optStr,

  // ── Channels — Microsoft Teams adapter (optional) ────────────────────────
  // One Kortix-owned multi-tenant Azure AD bot app. The same app id/password
  // serve every tenant; the per-conversation tenant id arrives on each inbound
  // activity. Outbound auth is a short-lived AAD token minted per scope at call
  // time (channels/teams-auth.ts) — there is no static bot token to store.
  MICROSOFT_APP_ID: optStr,
  MICROSOFT_APP_PASSWORD: optStr,
  // The bot's home tenant. Multi-tenant bots authenticate against the shared
  // `botframework.com` tenant; single-tenant deployments set their own.
  MICROSOFT_APP_TENANT: optStrDefault('botframework.com'),
  // OpenID metadata used to validate the signed JWT on every inbound activity
  // (the Teams analog of Slack signature verification).
  MICROSOFT_BOT_OPENID_METADATA: optUrl(
    'https://login.botframework.com/v1/.well-known/openidconfiguration',
  ),
  TEAMS_REQUIRE_USER_IDENTITY: optBoolTrue,
  // Whether the Teams channel is offered is NOT an operator env var — it is the
  // per-project `teams` feature flag (feature-flags/registry.ts).
  TEAMS_APP_NAME: optStrDefault('Kortix'),

  // ── LLM Providers (optional — only needed in cloud mode) ─────────────────
  // Kortix Platinum inference: the one upstream of every Kortix-managed model
  // (`managedCandidates`). The key is a pt_live_ key with `inference:write`.
  PLATINUM_INFERENCE_URL: optUrl('https://api.platinum.dev/v1/inference'),
  PLATINUM_INFERENCE_API_KEY: optStr,
  // CLOUD-ONLY. Whether KORTIX's own managed model lineup exists on this
  // deployment. The lineup is served by Platinum inference on Kortix's key.
  // Kortix bills each request as platform credits.
  // A self-host still runs the gateway for its own
  // BYOK routing (every sandbox model call goes through `/v1/llm`), it just
  // must never see or route to Kortix's shared credentials. When unset it
  // follows KORTIX_BILLING_INTERNAL_ENABLED (derived below): billing on =
  // managed cloud where the managed lineup is the product; billing off =
  // self-host where it must stay dark. An explicit true/false always wins.
  // See loadManagedLineup (managed-models.ts) and managedCandidates()
  // (descriptors.ts) — both are gated on this and read no managed credentials
  // when off.
  KORTIX_MANAGED_PROVIDER_ENABLED: optBoolUnset,
  // Empty = the in-API gateway at `${KORTIX_URL}/v1/llm`. Set to a standalone
  // gateway's public base (…/v1/llm) to route every sandbox model call there.
  LLM_GATEWAY_BASE_URL: optStr,
  // Runtime routing is control-plane configuration, not a model-catalog
  // constant baked into the gateway binary. Operators can replace the default
  // and define any number of exact-match fallback policies without code changes.
  // Empty = the first model Platinum Inference lists (platformDefaultModelId).
  LLM_GATEWAY_DEFAULT_MODEL: optStr,
  // Model used when the default receives an image. Empty = the first managed
  // model that reads images (platformVisionModelId).
  LLM_GATEWAY_VISION_MODEL: optStr,
  LLM_GATEWAY_FALLBACK_POLICIES: optFallbackPolicies,
  // Runtime source for provider/model metadata. The API keeps the last known
  // snapshot if this source is temporarily unavailable.
  LLM_GATEWAY_CATALOG_URL: optUrl('https://models.dev/api.json'),
  // Dev: reverse-proxy /v1/llm-gateway/* to a standalone gateway on this port,
  // so sandboxes reach it through the API's own tunnel (no separate tunnel).
  LLM_GATEWAY_PROXY_PORT: optInt(0),
  // Where the /v1/llm-gateway/* reverse-proxy forwards. Defaults to
  // 127.0.0.1:LLM_GATEWAY_PROXY_PORT (local, gateway same host). In K8s set to
  // the in-cluster gateway service, e.g. http://kortix-gateway:8090, so the
  // gateway stays internal and sandboxes reach it via the API's public origin.
  LLM_GATEWAY_PROXY_TARGET: optStr,
  OPENAI_API_KEY: optStr,
  // ── Billing — Stripe (optional, only for cloud billing) ──────────────────
  STRIPE_SECRET_KEY: optStr,
  STRIPE_WEBHOOK_SECRET: optStr,

  // ── Billing — RevenueCat (optional) ──────────────────────────────────────
  REVENUECAT_WEBHOOK_SECRET: optStr,

  // ── Daytona — LEGACY fallback provider (removal scheduled; use Platinum) ──
  // Required only if ALLOWED_SANDBOX_PROVIDERS includes daytona.
  // Note: there is intentionally no DAYTONA_SNAPSHOT here. Every sandbox
  // boots from a per-project snapshot built by the snapshot builder
  // (apps/api/src/snapshots/builder.ts). A shared/global fallback image
  // would silently bypass per-project Dockerfiles and is explicitly
  // disallowed.
  DAYTONA_API_KEY: optStr,
  DAYTONA_SERVER_URL: optStr,
  DAYTONA_TARGET: optStr,
  // Org-level Daytona webhook signing secret (Svix `whsec_…`). When set, the
  // /v1/billing/webhooks/daytona endpoint closes compute billing the instant a
  // box stops; the reaper sweep is the backstop, so this is optional.
  DAYTONA_WEBHOOK_SECRET: optStr,

  // When a template's content hash changes and a fresh snapshot is built, drop
  // the now-superseded predecessor immediately (reap-on-repoint) instead of
  // leaving it for the lazy, pressure-gated quota GC. Keeps steady state at ~1
  // snapshot per lineage so the org-wide 100-snapshot quota can't fill with
  // stale builds (dev auto-deploys churn the default ~20×/day). Best-effort;
  // only deletes managed (kortix-default-/tpl-/wproj-) names that no other
  // template row still references. On by default; boot auto-heal covers the rare
  // cross-env race where another env's row pointed at the reaped (identical) name.
  KORTIX_SNAPSHOT_REAP_PREDECESSOR: optBoolTrue,
  // Files: `off` boots every session without its folders (operator kill
  // switch); unset or anything else mounts them. `on` for KORTIX_DRIVES_SYNC
  // lets a project with Files boot sessions on a provider without volume
  // mounts, with the folders synced in by the box's daemon.
  KORTIX_DRIVES_SESSION_MOUNT: optStr,
  KORTIX_DRIVES_SYNC: optStr,
  // `off` (or 0/false/no): no new session gets a /workspace volume, whatever its
  // project's `workspace_volume` flag says. A session that already has one keeps
  // it (platform/services/workspace-volume.ts).
  KORTIX_WORKSPACE_VOLUMES: optStr,
  // The fresh-session Git fast path: KORTIX_SESSION_FRESH, the base-tip +
  // scaffold-delta hint (inline or remote bundle), and the OpenCode config-dir
  // hint that lets the daemon spawn OpenCode before the checkout. Default ON;
  // `false` restores the pre-2026-08-27 create-time contract. The daemon side
  // is additive and falls back to the clone path without these hints.
  // ── Project snapshot archives (S3 config provider) ─────────────────────
  // A fresh session materializes its project from a prebuilt `.tar.gz` in S3
  // instead of a Git clone. `git` (default) never attempts S3 and is the
  // rollback mode. `prefer-s3` tries a prepared archive and falls back to the
  // legacy Git path on any acquisition failure. `require-s3` fails closed —
  // acceptance runs and controlled validation only. A project can override
  // the platform mode with `projects.metadata.project_snapshot_mode` (canary).
  // The producer worker runs on the leader whenever the bucket is configured,
  // independent of the consumption mode, so archives can be prepared ahead of
  // a rollout. Credentials: the explicit pair below, else the AWS SDK default
  // chain (env, shared config, ECS/EKS task role). Endpoint + path style are
  // the MinIO/S3-compatible overrides; leave them unset on AWS.
  KORTIX_PROJECT_SNAPSHOT_MODE: z
    .enum(['git', 'prefer-s3', 'require-s3'])
    .optional()
    .default('git'),
  KORTIX_PROJECT_SNAPSHOT_S3_BUCKET: optStr,
  KORTIX_PROJECT_SNAPSHOT_S3_REGION: optStr,
  KORTIX_PROJECT_SNAPSHOT_S3_ENDPOINT: optUrl(''),
  /**
   * Endpoint the SANDBOX reaches the store through, when it differs from the
   * API's (MinIO behind a proxy/tunnel; self-host). Presigned download URLs
   * are signed for this host. Unset = same as the endpoint above / AWS.
   */
  KORTIX_PROJECT_SNAPSHOT_S3_PUBLIC_ENDPOINT: optUrl(''),
  KORTIX_PROJECT_SNAPSHOT_S3_FORCE_PATH_STYLE: optBoolFalse,
  // S3 Transfer Acceleration for the SANDBOX downloads only: presigned URLs
  // target <bucket>.s3-accelerate.amazonaws.com, so a box's connection ends at
  // the nearest AWS edge and the distance to the bucket rides AWS's backbone.
  // Needs `transfer_acceleration = true` on the bucket (Terraform module).
  // Ignored when a custom public endpoint (MinIO) is set. The API's own calls
  // stay on the regional endpoint.
  KORTIX_PROJECT_SNAPSHOT_S3_ACCELERATE: optBoolFalse,
  /** Optional key prefix inside the bucket (e.g. `dev/`), namespacing environments that share one bucket. */
  KORTIX_PROJECT_SNAPSHOT_S3_PREFIX: optStr,
  KORTIX_PROJECT_SNAPSHOT_S3_ACCESS_KEY_ID: optStr,
  KORTIX_PROJECT_SNAPSHOT_S3_SECRET_ACCESS_KEY: optStr,
  /** Lifetime of the presigned download URL handed to a sandbox. */
  KORTIX_PROJECT_SNAPSHOT_DOWNLOAD_TTL_SECONDS: optInt(900),
  KORTIX_PROJECT_SNAPSHOT_MAX_ARCHIVE_BYTES: optInt(512 * 1024 * 1024),

  // ── Audit archive (optional) ────────────────────────────────────────────
  // Weeks of kortix.audit_events older than 90 days are exported to this S3 bucket (Object Lock,
  // retained until the week's end + 365 days) and their PostgreSQL partition is dropped. Off
  // unless AUDIT_ARCHIVE_ENABLED is true AND the bucket is set AND the bucket has Object Lock.
  // Credentials: the AWS SDK default chain (the ECS task role). Endpoint + path style: MinIO.
  AUDIT_ARCHIVE_ENABLED: optBoolFalse,
  AUDIT_ARCHIVE_BUCKET: optStr,
  AUDIT_ARCHIVE_REGION: optStr,
  AUDIT_ARCHIVE_ENDPOINT: optUrl(''),
  AUDIT_ARCHIVE_FORCE_PATH_STYLE: optBoolFalse,
  AUDIT_ARCHIVE_ACCESS_KEY_ID: optStr,
  AUDIT_ARCHIVE_SECRET_ACCESS_KEY: optStr,
  /** Export read rate cap (rows per second): the job must not compete with ingest for IO. */
  AUDIT_ARCHIVE_ROWS_PER_SECOND: optInt(5_000),

  // ── Config releases (optional) ──────────────────────────────────────────
  // Config archives go through the API's ONE object store
  // (src/object-store/s3.ts), same as project snapshots above, with their own
  // bucket/prefix so that naming a config bucket never starts the snapshot
  // producer (which the snapshot bucket setting gates).
  //   dev/staging/prod: the environment's S3 bucket, credentials from the AWS
  //     SDK default chain (the ECS task role). Point the prefix somewhere
  //     distinct when the bucket is shared with project snapshots.
  //   local/preview/self-host: Supabase Storage's S3 PROTOCOL endpoint
  //     (`<supabase>/storage/v1/s3`) with the S3 protocol key pair, bucket
  //     `kortix-config-releases` (created by database migration).
  // Unset ⇒ validateEnv() warns and every archive request rebuilds from the
  // Git mirror.
  KORTIX_CONFIG_ARCHIVE_S3_BUCKET: optStr,
  KORTIX_CONFIG_ARCHIVE_S3_REGION: optStr,
  /** S3-compatible endpoint. Empty = the AWS regional endpoint. */
  KORTIX_CONFIG_ARCHIVE_S3_ENDPOINT: optUrl(''),
  KORTIX_CONFIG_ARCHIVE_S3_FORCE_PATH_STYLE: optBoolFalse,
  KORTIX_CONFIG_ARCHIVE_S3_ACCESS_KEY_ID: optStr,
  KORTIX_CONFIG_ARCHIVE_S3_SECRET_ACCESS_KEY: optStr,
  /** Key prefix inside the bucket. Keeps config archives apart from snapshots. */
  KORTIX_CONFIG_ARCHIVE_S3_PREFIX: optStr.transform((v) =>
    v.trim() ? v.trim() : 'config-releases',
  ),
  /** Archives kept per project. Older ones are deleted after a publish. */
  KORTIX_CONFIG_ARCHIVE_RETAIN_PER_PROJECT: optInt(20),
  // The endpoint the SANDBOX reaches the store through, when it differs from
  // the API's. Download URLs are presigned for this host and the archive route
  // answers 302 to them. Unset = presign for the API's own endpoint, and the
  // route streams the bytes when that host is loopback or private.
  KORTIX_CONFIG_ARCHIVE_PUBLIC_URL: optUrl(''),

  // ── Kortix Capture (optional) ───────────────────────────────────────────
  // Devices write the Kortix Capture format to this bucket under
  // `orgs/<account_id>/<device_id>/`. The API reads it
  // (ingestion), writes `policy.json`, and signs short-lived media URLs.
  //   dev/staging/prod: the Terraform bucket, credentials from the ECS task role.
  //   local/self-host: an S3-compatible store (MinIO, Supabase Storage).
  // Unset bucket ⇒ every capture route that needs storage answers 503.
  KORTIX_CAPTURE_S3_BUCKET: optStr,
  KORTIX_CAPTURE_S3_REGION: optStr,
  /** S3-compatible endpoint for the API's own calls. Empty = the AWS regional endpoint. */
  KORTIX_CAPTURE_S3_ENDPOINT: optUrl(''),
  /** Endpoint a DEVICE reaches (credentials response, signed URLs). Empty = the endpoint above / AWS. */
  KORTIX_CAPTURE_S3_PUBLIC_ENDPOINT: optUrl(''),
  KORTIX_CAPTURE_S3_FORCE_PATH_STYLE: optBoolFalse,
  /**
   * Self-host without a domain (loopback, Cloudflare tunnel): the in-network S3
   * endpoint this API forwards `/<bucket>/*` to, so a device reaches the store
   * over the API's own origin. Unset in domain mode, where Caddy does it.
   */
  KORTIX_CAPTURE_S3_PROXY_TARGET: optUrl(''),
  /** Create the bucket if it is missing (self-host's bundled store). AWS: Terraform owns it. */
  KORTIX_CAPTURE_S3_CREATE_BUCKET: optBoolFalse,
  KORTIX_CAPTURE_S3_ACCESS_KEY_ID: optStr,
  KORTIX_CAPTURE_S3_SECRET_ACCESS_KEY: optStr,
  // Credential issuer: STS AssumeRole with an inline session policy that
  // narrows the role to one device's prefix. AWS: the Terraform device role
  // (trusts the API task role). MinIO: any ARN; MinIO enforces the session
  // policy. Unset ⇒ `POST /v1/capture/credentials` answers 503.
  KORTIX_CAPTURE_STS_ROLE_ARN: optStr,
  /** STS endpoint override (MinIO serves STS on its S3 endpoint). Empty = AWS STS. */
  KORTIX_CAPTURE_STS_ENDPOINT: optUrl(''),
  /** SQS queue with the bucket's `*.manifest.json` ObjectCreated events. Unset ⇒ index polling only. */
  KORTIX_CAPTURE_SQS_QUEUE_URL: optStr,
  /** How often the index reader polls each active device's `index/<day>.jsonl` and `status.json`. */
  KORTIX_CAPTURE_INDEX_POLL_SECONDS: optInt(60),
  /** Minutes a device must be not recording (awake time) before the account's managers are told. */
  KORTIX_CAPTURE_ALERT_AFTER_MINUTES: optInt(30),
  /** The update manifest that names the newest published Capture version. Empty: no version check. */
  KORTIX_CAPTURE_UPDATE_MANIFEST_URL: optUrl(
    'https://github.com/kortix-ai/suna/releases/latest/download/capture-update.json',
  ),

  // ── Platinum — Sandbox provisioning (conditional: required if platinum provider enabled) ──
  // Platinum is our own Cloud Hypervisor microVM API. PLATINUM_API_KEY is a
  // pt_live_… key; PLATINUM_API_URL is the control-plane base
  // (https://api.platinum.dev). PLATINUM_TEMPLATE is a ready Platinum template
  // id to boot sessions from (e.g. kortix-computer) — used as the fallback when
  // a session hasn't built its own per-project Platinum template.
  PLATINUM_API_KEY: optStr,
  PLATINUM_API_URL: optStr,
  PLATINUM_TEMPLATE: optStr,
  // Per-webhook HMAC-SHA-256 secret from Platinum's `POST /v1/webhooks` (shown
  // once at registration). Optional — same backstop story as Daytona's.
  PLATINUM_WEBHOOK_SECRET: optStr,
  // Local development switch. `local` points the provider at a Platinum
  // control plane on this machine (PLATINUM_API_URL_LOCAL / _KEY_LOCAL);
  // unset or `prod` keeps PLATINUM_API_URL / PLATINUM_API_KEY above.
  PLATINUM_TARGET: z.enum(['local', 'prod']).optional().default('prod'),
  PLATINUM_API_URL_LOCAL: optStr,
  PLATINUM_API_KEY_LOCAL: optStr,

  // ── Sandbox Platform ──────────────────────────────────────────────────────
  // Public API base URL, without a route suffix. Auto-derived from PORT in local mode.
  KORTIX_URL: optStr,
  // Comma-separated. The first entry is the default for new sessions.
  // Platinum is the reference; `daytona` is a legacy opt-in fallback.
  ALLOWED_SANDBOX_PROVIDERS: optStrDefault('platinum'),

  // ── Sandbox lifecycle (Daytona auto-stop / auto-archive / auto-delete) ────
  // Set as SDK create() params so a box self-manages even if the API/tunnel
  // that created it dies (orphaned local-dev & ephemeral-env sessions are the
  // main leak source). All in MINUTES.
  //   autostop   → idle box stops, compute billing ends. CLAMPED to >=1 at the
  //                use site so a box is NEVER created persistent.
  //                This is what actually stops the money burn.
  //                Was 120 until 2026-07-07: prod never set the env var, so every
  //                box idled a full 2h after its last real activity — 78% of all
  //                billed sandbox-hours (Jul 1-7 audit) were idle tail charged to
  //                users. 15 matches dev and the reaper's own default.
  //                Trigger-fired sessions (source 'trigger:*') have no human
  //                waiting on the box, so the reaper stops them after the much
  //                shorter TRIGGER_AUTOSTOP window instead.
  //   autoarchive→ stopped box moves to cold storage after half a day (cheap,
  //                still resumable; kept warm-resumable in the meantime).
  //                Was 3 days (4320) until 2026-07-02: the org-wide (shared
  //                across every environment) stopped-sandbox pool rode that
  //                window up to ~32000GiB, tipping the shared 40000GiB total
  //                disk quota and failing every create/resume org-wide. Went
  //                to 360 (6h) as the incident fix, then back up to 720 (12h)
  //                once disk headroom was confirmed stable — keeps next-day
  //                warm-resume while still capping how much disk any one
  //                environment's idle churn can hold at once.
  //   autodelete → NEVER (-1). A sandbox is only ever removed when a user
  //                explicitly deletes the session — auto-stop + cold archive
  //                make an idle box nearly free, so we never destroy disk.
  KORTIX_SANDBOX_AUTOSTOP_MINUTES: optInt(15),
  KORTIX_SANDBOX_AUTOARCHIVE_MINUTES: optInt(720), // 12 hours
  KORTIX_SANDBOX_AUTODELETE_MINUTES: optInt(-1), // never auto-delete
  // Stateless sandboxes: a session whose /workspace is a Platinum volume loses
  // its stopped box after this many minutes (projects/reaping/idle-volume-retire.ts);
  // the next open boots a fresh box on the volume. -1 keeps every stopped box.
  KORTIX_SANDBOX_IDLE_DELETE_MINUTES: optInt(60),
  // The PROVIDER-NATIVE idle timer (Daytona autoStopInterval / Platinum
  // auto_stop_minutes) — a LAST-RESORT backstop for boxes this API can no
  // longer reach, NOT the primary stop. It used to be derived from
  // KORTIX_SANDBOX_AUTOSTOP_MINUTES above, which welded an idle-policy knob to
  // a provider-safety knob; see providerAutoStopBackstopMinutes() in
  // platform/providers/index.ts for why the two must move independently.
  // Unrelated to AUTOARCHIVE_MINUTES despite the shared 720: that one is
  // measured from the moment a box STOPS, this one from its last inbound
  // request while running.
  KORTIX_SANDBOX_PROVIDER_AUTOSTOP_MINUTES: optInt(720), // 12 hours

  // ── Internal Service Key (auto-generated if missing — never fails) ───────
  INTERNAL_SERVICE_KEY: optStr,

  // ── Frontend (optional) ──────────────────────────────────────────────────
  FRONTEND_URL: optUrl('http://localhost:3000'),

  // ── Pipedream Connect (optional — powers the Connector's 1-click connectors) ─
  PIPEDREAM_CLIENT_ID: optStr,
  PIPEDREAM_CLIENT_SECRET: optStr,
  PIPEDREAM_PROJECT_ID: optStr,
  PIPEDREAM_ENVIRONMENT: optStrDefault('production'),
  PIPEDREAM_WEBHOOK_SECRET: optStr,

  // ── Composio Connect (optional — powers provider-neutral connector connect) ─
  COMPOSIO_API_KEY: optStr,
  // Optional: signing secret of the Composio project webhook subscription; required to receive app-event triggers.
  COMPOSIO_WEBHOOK_SECRET: optStr,
  // Optional: required only when importing a public Postman workspace URL.
  // Exported collection JSON and Postman-managed Git repositories need no key.
  POSTMAN_API_KEY: optStr,

  // ── Tunnel (optional, all have sane defaults) ────────────────────────────
  TUNNEL_SIGNING_SECRET: optStr,
  TUNNEL_ENABLED: optBoolTrue,
  TUNNEL_HEARTBEAT_INTERVAL_MS: optInt(30_000),
  TUNNEL_HEARTBEAT_MAX_MISSED: optInt(3),
  TUNNEL_RPC_TIMEOUT_MS: optInt(30_000),
  TUNNEL_RATE_LIMIT_RPC: optInt(100),
  TUNNEL_RATE_LIMIT_PERM_REQUEST: optInt(20),
  TUNNEL_RATE_LIMIT_WS_CONNECT: optInt(5),
  TUNNEL_RATE_LIMIT_PERM_GRANT: optInt(30),
  TUNNEL_MAX_WS_MESSAGE_SIZE: optInt(5 * 1024 * 1024),

  // ── Abuse controls (optional, all have sane defaults) ────────────────────
  KORTIX_INVITE_ACCEPT_REQS_PER_MIN: optInt(20),
  KORTIX_PUBLIC_RESPONSE_REQS_PER_MIN: optInt(3000),
  KORTIX_DEMO_REQUEST_REQS_PER_MIN: optInt(10),
  KORTIX_FEEDBACK_REQS_PER_MIN: optInt(10),
  KORTIX_LLM_ROUTER_REQS_PER_MIN_FREE: optInt(60),
  KORTIX_LLM_ROUTER_REQS_PER_MIN_PAID: optInt(600),
  // Per-credential bound on the LLM gateway mount (/v1/llm and its
  // /v1/llm-gateway alias). Defence-in-depth at the boundary, not a quota:
  // 600/min is ~10/s per credential, far above any real inference pattern.
  KORTIX_LLM_GATEWAY_REQS_PER_MIN: optInt(600),
  KORTIX_PROXY_REQS_PER_MIN: optInt(600),
  // Proxies in front of the API that APPEND to X-Forwarded-For. The client is
  // the entry this many places from the right; everything to its left was
  // written by the client. Cloud: Cloudflare + ALB = 2. Self-host Caddy
  // replaces an untrusted header with one entry, which the rule also reads
  // correctly. See shared/client-ip.ts.
  KORTIX_TRUSTED_PROXY_HOPS: optInt(2),
  // Per client IP: Kortix bearer tokens that need a fresh hash (not seen by
  // this process recently). A token already validated here is not counted.
  KORTIX_UNKNOWN_TOKEN_ATTEMPTS_PER_MIN: optInt(300),
  KORTIX_TRIGGER_MAX_PROVISIONING_SESSIONS_PER_PROJECT: optInt(3),
  KORTIX_TRIGGER_SCHEDULER_ENABLED: optBoolTrue,
  KORTIX_TRIGGER_SCHEDULER_INTERVAL_MS: optInt(1_000),
  // Kill switch of Kortix-polled app events (source `mcp`). Off: no check runs; streams and
  // triggers stay, and checks resume when it is on again.
  KORTIX_EVENT_POLLS_ENABLED: optBoolTrue,

  // ── Version / GitHub (optional) ───────────────────────────────────────────
  SANDBOX_VERSION: optStr, // dev override: skip npm registry lookup for latest version
  GITHUB_TOKEN: optStr, // optional: authenticated GitHub API calls for changelog

  // ── Transactional email ───────────────────────────────────────────────────
  // ONE connection string configures delivery for every email the platform
  // sends, product and auth alike. The scheme picks the transport:
  //   smtp://user:pass@host:587 · smtps://user:pass@host:465
  //   resend://<api-key> · ses://<key>:<secret>@<region> · ses://<region>
  //   mailtrap://<token> · mailpit://host:8025
  // Comma-separate for a fallback chain. See lib/email/dsn.ts.
  EMAIL_URL: optStr,
  // Sender identity: `Name <address>` or a bare address.
  EMAIL_FROM: optStr,
  // Shared secret for the Supabase send-email hook (`v1,whsec_<base64>`), which
  // routes GoTrue's magic-link / confirmation / recovery mail through this API
  // so auth email uses the same provider and templates as product email.
  // See auth/send-email-hook/.
  AUTH_EMAIL_HOOK_SECRET: optStr,

  // ── Transactional email: pre-EMAIL_URL variables (still supported) ────────
  // Deployed Kortix runs on these today. They are used whenever EMAIL_URL is
  // unset; setting EMAIL_URL overrides all of them.
  // `smtp` is last but present by default: an existing self-host that
  // configured SMTP_* for GoTrue before EMAIL_URL shipped starts sending
  // product email (invites, access requests) through that same relay on
  // upgrade, with no new setting. Cloud sets no SMTP_*, so nothing changes
  // there.
  EMAIL_PROVIDER_ORDER: optStrDefault('ses,resend,mailtrap,smtp'),
  // Discrete SMTP settings, as GoTrue consumes them. Shared with the API so a
  // self-host that configures a relay for auth email also sends product email
  // through it with no second setting.
  SMTP_HOST: optStr,
  SMTP_PORT: optStr,
  SMTP_USER: optStr,
  SMTP_PASS: optStr,
  // AWS SES (SigV4-signed SESv2 HTTP API). ECS uses its task role. Static
  // credentials remain optional for local and self-hosted deployments.
  AWS_SES_REGION: optStrDefault('us-east-2'),
  AWS_SES_ACCESS_KEY_ID: optStr,
  AWS_SES_SECRET_ACCESS_KEY: optStr,
  // Resend (https://resend.com).
  RESEND_API_KEY: optStr,
  // Override sender for the Resend leg only — needed while the primary from-
  // domain is not yet claimed/verified in the Resend team. The intended from
  // address is preserved as Reply-To.
  RESEND_FROM_EMAIL: optStr,
  // Mobile push notifications through the Expo Push API
  // (notifications/expo-push.ts). The access token is optional: Expo accepts
  // unauthenticated sends unless the project enables enhanced push security.
  EXPO_ACCESS_TOKEN: optStr,
  // Expo push sends (KRTX-2938). Unset: off on a local stack (the launchers
  // set KORTIX_INSTANCE_ID), on everywhere else. A local stack holds tokens of
  // real phones, and Expo routes them to the App Store app. `true` opts in.
  EXPO_PUSH_ENABLED: optBoolUnset,
  // Kill switch for session push notifications. On by default; `0` or `false`
  // stops every send. Device-token registration keeps working.
  PUSH_NOTIFICATIONS_ENABLED: z
    .string()
    .optional()
    .default('true')
    .transform((v) => !['0', 'false'].includes(v.trim().toLowerCase())),
  // Local-only HTTP capture. The deterministic test profile points this at
  // Supabase Mailpit. Deployed environments leave it unset.
  MAILPIT_API_URL: optStr,
  MAILTRAP_API_TOKEN: optStr,
  MAILTRAP_FROM_EMAIL: optStrDefault('noreply@kortix.com'),
  MAILTRAP_FROM_NAME: optStrDefault('Kortix'),
  // Where Kortix sales hears about leads: "book a demo", "Talk to sales", the
  // Enterprise demo turned on, billing ops copies. Comma-separated list; every
  // address gets every email. Unset → the sales inboxes on prod only: dev,
  // staging, local and self-host test accounts must never email sales.
  DEMO_LEAD_NOTIFY_EMAIL: z.string().optional(),
  // Sender for those notifications. kortix.ai (not the global MAILTRAP_FROM_
  // EMAIL on kortix.com) so the send is DKIM-aligned with the kortix.ai
  // recipient inboxes — the kortix.com sender was landing in spam.
  DEMO_LEAD_FROM_EMAIL: optStrDefault('hi@kortix.ai'),

  // ── Mailtrap contact sync (signup → automation lists) ─────────────────────
  // The email automations themselves live in Mailtrap's Automations UI; the
  // API only registers each new signup as a contact. Sync is active iff
  // MAILTRAP_API_TOKEN + MAILTRAP_ACCOUNT_ID are both set.
  MAILTRAP_ACCOUNT_ID: optStr,
  // Contact list every signup joins (automation trigger: "added to list").
  MAILTRAP_SIGNUPS_LIST_ID: optStr,
  // Additional list for work-email signups (founder "book a call" flow).
  MAILTRAP_BUSINESS_SIGNUPS_LIST_ID: optStr,

  // ── Signup webhook (signup → sales factory) ─────────────────────────────
  // Every genuinely new account POSTs one `account.signup` event here, signed
  // `X-Kortix-Signature: sha256=<HMAC-SHA256 of the raw body>` with the secret.
  // Inert unless both are set (accounts/signup-webhook.ts).
  SIGNUP_WEBHOOK_URL: optStr,
  SIGNUP_WEBHOOK_SECRET: optStr,

  // ── Better Stack Observability (optional — graceful degradation) ────────
  BETTERSTACK_API_LOG_TOKEN: optStr, // Logtail source token for structured logs
  BETTERSTACK_API_LOG_HOST: optStr, // Logtail ingesting host (e.g. s1234.us-east-9.betterstackdata.com)
  BETTERSTACK_API_SENTRY_DSN: optStr, // Sentry DSN for error tracking (Better Stack compatible)

  // ── Stray env vars used directly in other files (centralized here) ───────
  CORS_ALLOWED_ORIGINS: optStr,
});

// ─── Validation + Conditional Checks ────────────────────────────────────────

type EnvIssue = { var: string; message: string; level: 'error' | 'warn' };

// Recognised provider names. Source-of-truth for what can legally appear in
// ALLOWED_SANDBOX_PROVIDERS — adding a new provider is a one-place change
// here plus a case in `getProvider()` in platform/providers/index.ts.
// `e2b` is not listed: E2B support is discontinued, so the entry is ignored.
export const KNOWN_PROVIDERS: readonly SandboxProviderName[] = ['platinum', 'daytona'] as const;

/**
 * Parse comma-separated provider list (e.g. "platinum,daytona"). `fallback` is
 * returned both when `raw` is empty and when every entry in it is unrecognised
 * — kept as a parameter (rather than hardcoding `['platinum']`) so a caller
 * whose empty/all-invalid answer should mean "nothing enabled" does not
 * silently inherit ALLOWED_SANDBOX_PROVIDERS' "default to platinum" safety
 * belt.
 */
export function parseAllowedProviders(
  raw: string,
  fallback: SandboxProviderName[] = ['platinum'],
): SandboxProviderName[] {
  if (!raw) return fallback;
  const names = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const valid: SandboxProviderName[] = [];
  for (const n of names) {
    if ((KNOWN_PROVIDERS as readonly string[]).includes(n)) {
      const known = n as SandboxProviderName;
      if (!valid.includes(known)) valid.push(known);
    } else {
      console.warn(
        `[config] Unknown sandbox provider "${n}" in ALLOWED_SANDBOX_PROVIDERS - ignored`,
      );
    }
  }
  return valid.length > 0 ? valid : fallback;
}

function validateEnv(): z.infer<typeof envSchema> {
  const result = envSchema.safeParse(process.env);

  const issues: EnvIssue[] = [];

  // ── Collect Zod schema errors ──────────────────────────────────────────
  if (!result.success) {
    for (const issue of result.error.issues) {
      const varName = issue.path.join('.');
      issues.push({ var: varName, message: issue.message, level: 'error' });
    }
  }

  // Use raw values for conditional checks (schema may have failed)
  const raw = result.success ? result.data : (process.env as Record<string, string | undefined>);

  // ── Conditional: sandbox provider credentials ───────────────────────────
  // On the managed cloud (billing on) a missing provider key is a hard error —
  // sessions are the product. On self-host it is a WARNING: the operator sets
  // the key after first boot (dashboard-first onboarding); the server must
  // start so they can reach that dashboard at all. Sandbox creation fails with
  // a clear error until the key lands.
  const providers = parseAllowedProviders((raw as any).ALLOWED_SANDBOX_PROVIDERS || '');
  const billingOn =
    (raw as any).KORTIX_BILLING_INTERNAL_ENABLED === 'true' ||
    (raw as any).KORTIX_BILLING_INTERNAL_ENABLED === true;
  const providerKeyLevel: 'error' | 'warn' = billingOn ? 'error' : 'warn';
  const providerKeySuffix = billingOn
    ? ''
    : ' — agent sessions will fail until it is set (kortix self-host env set ...)';
  if (providers.includes('daytona')) {
    if (!raw.DAYTONA_API_KEY)
      issues.push({
        var: 'DAYTONA_API_KEY',
        message: `Required when ALLOWED_SANDBOX_PROVIDERS includes "daytona" (legacy fallback, removal scheduled; use platinum)${providerKeySuffix}`,
        level: providerKeyLevel,
      });
    if (!raw.DAYTONA_SERVER_URL)
      issues.push({
        var: 'DAYTONA_SERVER_URL',
        message: `Required when ALLOWED_SANDBOX_PROVIDERS includes "daytona" (legacy fallback, removal scheduled; use platinum)${providerKeySuffix}`,
        level: providerKeyLevel,
      });
    if (!raw.DAYTONA_TARGET)
      issues.push({
        var: 'DAYTONA_TARGET',
        message: `Required when ALLOWED_SANDBOX_PROVIDERS includes "daytona" (legacy fallback, removal scheduled; use platinum)${providerKeySuffix}`,
        level: providerKeyLevel,
      });
  }
  if (providers.includes('platinum')) {
    if (!raw.PLATINUM_API_KEY)
      issues.push({
        var: 'PLATINUM_API_KEY',
        message: `Required when ALLOWED_SANDBOX_PROVIDERS includes "platinum"${providerKeySuffix}`,
        level: providerKeyLevel,
      });
    if (!raw.PLATINUM_API_URL)
      issues.push({
        var: 'PLATINUM_API_URL',
        message: `Required when ALLOWED_SANDBOX_PROVIDERS includes "platinum"${providerKeySuffix}`,
        level: providerKeyLevel,
      });
  }

  // ── Conditional: Billing enabled → need Stripe keys ────────────────────
  const billingWillBeEnabled =
    (raw as any).KORTIX_BILLING_INTERNAL_ENABLED === 'true' ||
    (raw as any).KORTIX_BILLING_INTERNAL_ENABLED === true;
  if (billingWillBeEnabled) {
    if (!raw.STRIPE_SECRET_KEY)
      issues.push({
        var: 'STRIPE_SECRET_KEY',
        message: 'Required when KORTIX_BILLING_INTERNAL_ENABLED=true',
        level: 'error',
      });
    if (!raw.STRIPE_WEBHOOK_SECRET)
      issues.push({
        var: 'STRIPE_WEBHOOK_SECRET',
        message: 'Required when KORTIX_BILLING_INTERNAL_ENABLED=true',
        level: 'error',
      });
  }

  // ── Config archives → the ONE object store ──────────────────────────────
  // Every project publishes config archives through the API's one object
  // store (src/object-store/s3.ts); there is no second store and no fallback
  // path that quietly writes somewhere else.
  // Unset ⇒ every archive request rebuilds from the Git mirror, every time,
  // for every box. A warning, not an error: the store is a cache, and a
  // container with a stale env block must still boot.
  {
    const bucket = String((raw as any).KORTIX_CONFIG_ARCHIVE_S3_BUCKET ?? '').trim();
    const endpoint = String((raw as any).KORTIX_CONFIG_ARCHIVE_S3_ENDPOINT ?? '').trim();
    const keyId = String((raw as any).KORTIX_CONFIG_ARCHIVE_S3_ACCESS_KEY_ID ?? '').trim();
    const keySecret = String((raw as any).KORTIX_CONFIG_ARCHIVE_S3_SECRET_ACCESS_KEY ?? '').trim();
    if (!bucket) {
      issues.push({
        var: 'KORTIX_CONFIG_ARCHIVE_S3_BUCKET',
        message:
          'Not set — config archives are not cached; every box rebuilds them from the Git mirror (set the KORTIX_CONFIG_ARCHIVE_S3_* block)',
        level: 'warn',
      });
    } else if (endpoint && !(keyId && keySecret)) {
      // A custom S3 endpoint (Supabase Storage, MinIO) never has a task role.
      issues.push({
        var: 'KORTIX_CONFIG_ARCHIVE_S3_ACCESS_KEY_ID',
        message:
          'Required with KORTIX_CONFIG_ARCHIVE_S3_ENDPOINT — an S3-compatible endpoint has no AWS task role to fall back to',
        level: 'error',
      });
    }
  }

  // ── Conditional: GitHub App configured → need its OAuth client too ─────
  // The App's own OAuth client is what proves "this GitHub user is you" when
  // linking an installation to an account (POST /projects/github/installations/
  // {linkable,link} need a user token from it). Without the pair, that flow
  // dead-ends at `?error=oauth_not_configured` — a redirect parameter in a
  // browser, with nothing said server-side. Every environment ran that way
  // unnoticed because these vars are read straight from process.env and so
  // never appeared in this report. Warn, don't fail: the App still signs its
  // own JWT and managed git keeps working without an OAuth client.
  const githubAppConfigured = Boolean(
    (raw as any).KORTIX_GITHUB_APP_ID || (raw as any).KORTIX_GITHUB_APP_PRIVATE_KEY,
  );
  if (githubAppConfigured) {
    const clientId = (raw as any).KORTIX_GITHUB_APP_CLIENT_ID || (raw as any).GITHUB_APP_CLIENT_ID;
    const clientSecret =
      (raw as any).KORTIX_GITHUB_APP_CLIENT_SECRET || (raw as any).GITHUB_APP_CLIENT_SECRET;
    const oauthHint =
      'Set it (or complete the manifest setup flow) or GitHub account linking fails with oauth_not_configured';
    if (!clientId)
      issues.push({ var: 'KORTIX_GITHUB_APP_CLIENT_ID', message: oauthHint, level: 'warn' });
    if (!clientSecret)
      issues.push({ var: 'KORTIX_GITHUB_APP_CLIENT_SECRET', message: oauthHint, level: 'warn' });
  }

  // ── Conditional: Tunnel enabled → need signing secret ──────────────────
  const tunnelEnabled =
    (raw as any).TUNNEL_ENABLED !== 'false' && (raw as any).TUNNEL_ENABLED !== false;
  if (tunnelEnabled && !raw.TUNNEL_SIGNING_SECRET) {
    issues.push({
      var: 'TUNNEL_SIGNING_SECRET',
      message: 'Required when tunnel is enabled — protects device-handoff token derivation',
      level: 'error',
    });
  } else if (
    tunnelEnabled &&
    typeof raw.TUNNEL_SIGNING_SECRET === 'string' &&
    Buffer.byteLength(raw.TUNNEL_SIGNING_SECRET, 'utf8') < 24
  ) {
    issues.push({
      var: 'TUNNEL_SIGNING_SECRET',
      message: 'Must contain at least 24 bytes of secret material',
      level: 'error',
    });
  }

  // ── Conditional: KORTIX_URL — required for sandbox routing ──────────────
  // Auto-derive from PORT for self-host/dev — fatal when billing is enabled
  // (you can't bill against an unreachable origin).
  if (!raw.KORTIX_URL) {
    const port = (raw as any).PORT || '8008';
    if (billingWillBeEnabled) {
      issues.push({
        var: 'KORTIX_URL',
        message:
          'Required when KORTIX_BILLING_INTERNAL_ENABLED=true — sandbox routing and health checks will break',
        level: 'error',
      });
    } else {
      // Auto-derive so dev/self-host "just works". KORTIX_URL is the public
      // API origin/base; individual callers append /v1, /v1/router, etc.
      const derived = `http://localhost:${port}`;
      process.env.KORTIX_URL = derived;
      if (result.success) (result.data as any).KORTIX_URL = derived;
      console.warn(`[config] KORTIX_URL not set — auto-derived: ${derived}`);
      issues.push({
        var: 'KORTIX_URL',
        message: `Not set — auto-derived to ${derived} (add to .env to silence this)`,
        level: 'warn',
      });
    }
  }

  // ── Warnings (non-fatal but worth knowing) ─────────────────────────────
  if (raw.KORTIX_MANAGED_PROVIDER_ENABLED === 'true' && !raw.PLATINUM_INFERENCE_API_KEY) {
    issues.push({
      var: 'PLATINUM_INFERENCE_API_KEY',
      message:
        'Managed models are on but PLATINUM_INFERENCE_API_KEY is unset — Kortix managed models are unavailable',
      level: 'warn',
    });
  }

  // ── Print results ─────────────────────────────────────────────────────
  const errors = issues.filter((i) => i.level === 'error');
  const warnings = issues.filter((i) => i.level === 'warn');

  if (warnings.length > 0) {
    console.warn('');
    console.warn('\x1b[33m' + '='.repeat(70) + '\x1b[0m');
    console.warn('\x1b[33m  kortix-api: Environment warnings\x1b[0m');
    console.warn('\x1b[33m' + '='.repeat(70) + '\x1b[0m');
    for (const w of warnings) {
      console.warn(`\x1b[33m  ${w.var.padEnd(40)} ${w.message}\x1b[0m`);
    }
    console.warn('\x1b[33m' + '='.repeat(70) + '\x1b[0m');
    console.warn('');
  }

  if (errors.length > 0) {
    console.error('');
    console.error('\x1b[31m' + '='.repeat(70) + '\x1b[0m');
    console.error(
      '\x1b[31m  kortix-api: Environment validation FAILED — server cannot start\x1b[0m',
    );
    console.error('\x1b[31m' + '='.repeat(70) + '\x1b[0m');
    for (const e of errors) {
      console.error(`\x1b[31m  ${e.var.padEnd(40)} ${e.message}\x1b[0m`);
    }
    console.error('\x1b[31m' + '='.repeat(70) + '\x1b[0m');
    console.error('');
    console.error('\x1b[31m  Fix the above in your .env file and restart.\x1b[0m');
    console.error('');
    process.exit(1);
  }

  if (!result.success) {
    // Should not be reachable (errors already handled above) but safety net
    console.error('[config] Unexpected validation failure:', result.error.format());
    process.exit(1);
  }

  console.log(
    `[config] Environment validated (${Object.keys(envSchema.shape).length} vars, ${warnings.length} warnings)`,
  );
  return result.data;
}

// ─── Run Validation at Module Load ──────────────────────────────────────────

const env = validateEnv();

// ─── Parse Providers ────────────────────────────────────────────────────────

const allowedProviders = parseAllowedProviders(env.ALLOWED_SANDBOX_PROVIDERS);

// ─── Config Object (typed, validated) ───────────────────────────────────────

export const config = {
  PORT: env.PORT,

  // ─── Internal Deployment Controls ─────────────────────────────────────────
  INTERNAL_KORTIX_ENV: env.INTERNAL_KORTIX_ENV as InternalKortixEnv,
  // True only when the deploy set the variable. An unset variable falls back to
  // 'dev' above, and the router credit gate must not read that fallback as a
  // dev exemption (see router/services/credit-gate-env.ts).
  INTERNAL_KORTIX_ENV_EXPLICIT: Boolean(process.env.INTERNAL_KORTIX_ENV),
  // A local stack (the worktree launcher and scripts/dev-local.sh export it).
  // It runs as INTERNAL_KORTIX_ENV=dev on dev's sandbox provider organisation
  // but reads its own database, so it must never delete provider images it
  // did not build (KRTX-2546). No deployed environment sets it.
  KORTIX_LOCAL_DEV: process.env.KORTIX_LOCAL_DEV === '1',
  // Empty string reads as unset: the launchers always export the var, and a
  // blank value must not turn into an instance called "".
  KORTIX_INSTANCE_ID: env.KORTIX_INSTANCE_ID || undefined,
  KORTIX_PREVIEW_BASE_DOMAIN: env.KORTIX_PREVIEW_BASE_DOMAIN,
  // Single master switch — see schema docstring above.
  KORTIX_BILLING_INTERNAL_ENABLED: env.KORTIX_BILLING_INTERNAL_ENABLED,
  KORTIX_APPS_STATIC_HOSTING: env.KORTIX_APPS_STATIC_HOSTING,
  KORTIX_APPS_RETAINED_DEPLOYMENTS: Math.max(1, env.KORTIX_APPS_RETAINED_DEPLOYMENTS),
  KORTIX_APPS_DEFAULT_ALWAYS_ON: env.KORTIX_APPS_DEFAULT_ALWAYS_ON,
  KORTIX_APPS_WORKER_ENABLED: env.KORTIX_APPS_WORKER_ENABLED,
  KORTIX_WORKERS_ENABLED: env.KORTIX_WORKERS_ENABLED,
  ACCOUNT_DELETION_SWEEP_PAUSED: env.ACCOUNT_DELETION_SWEEP_PAUSED,
  KORTIX_SANDBOX_EGRESS_PIN_ENFORCED: env.KORTIX_SANDBOX_EGRESS_PIN_ENFORCED,
  KORTIX_CONNECTOR_EGRESS_ALLOW_HOSTS: env.KORTIX_CONNECTOR_EGRESS_ALLOW_HOSTS.split(',')
    .map((host) => host.trim())
    .filter(Boolean),
  KORTIX_LLM_CUSTOM_PROVIDER_ALLOW_HOSTS: env.KORTIX_LLM_CUSTOM_PROVIDER_ALLOW_HOSTS.split(',')
    .map((host) => host.trim())
    .filter(Boolean),
  KORTIX_SECRET_RELAY_STREAM_ENABLED: env.KORTIX_SECRET_RELAY_STREAM_ENABLED,
  KORTIX_RELAY_MAX_REQUEST_BYTES: env.KORTIX_RELAY_MAX_REQUEST_BYTES,
  KORTIX_RELAY_MAX_RESPONSE_BYTES: env.KORTIX_RELAY_MAX_RESPONSE_BYTES,
  KORTIX_RELAY_HEADERS_TIMEOUT_MS: env.KORTIX_RELAY_HEADERS_TIMEOUT_MS,
  KORTIX_RELAY_UPSTREAM_IDLE_TIMEOUT_MS: env.KORTIX_RELAY_UPSTREAM_IDLE_TIMEOUT_MS,
  SESSION_TITLE_GENERATION_ENABLED: env.SESSION_TITLE_GENERATION_ENABLED,
  GENUI_ENABLED: env.GENUI_ENABLED,
  SESSION_LOG_INGEST_ENABLED: env.SESSION_LOG_INGEST_ENABLED,
  SESSION_LOG_RESTORE_ENABLED: env.SESSION_LOG_RESTORE_ENABLED,
  SESSION_LOG_RESTORE_DEFAULT_ENABLED: env.SESSION_LOG_RESTORE_DEFAULT_ENABLED,
  SESSION_LOG_RESTORE_MAX_BYTES: env.SESSION_LOG_RESTORE_MAX_BYTES,
  SESSION_LOG_BLOB_READ_MS: env.SESSION_LOG_BLOB_READ_MS,
  SESSION_LOG_PURGE_ENABLED: env.SESSION_LOG_PURGE_ENABLED,
  SESSION_LOG_BACKFILL: env.SESSION_LOG_BACKFILL,
  SESSION_LOG_BACKFILL_MEMORY_MB: env.SESSION_LOG_BACKFILL_MEMORY_MB,
  KORTIX_COMMIT: env.KORTIX_COMMIT,
  OPENAPI_PUBLIC_DOCS: env.OPENAPI_PUBLIC_DOCS,
  MOBILE_MIN_VERSION: env.MOBILE_MIN_VERSION.trim(),
  MOBILE_STORE_URL_IOS: env.MOBILE_STORE_URL_IOS,
  MOBILE_STORE_URL_ANDROID: env.MOBILE_STORE_URL_ANDROID,
  ENTERPRISE_LICENSE_AVAILABLE: env.ENTERPRISE_LICENSE_AVAILABLE,
  KORTIX_RESTRICT_ACCOUNT_CREATION: env.KORTIX_RESTRICT_ACCOUNT_CREATION,

  // ─── Database ──────────────────────────────────────────────────────────────
  DATABASE_URL: env.DATABASE_URL,
  KORTIX_SQL_TRACE: env.KORTIX_SQL_TRACE,

  // ─── Supabase ──────────────────────────────────────────────────────────────
  SUPABASE_URL: env.SUPABASE_URL,
  SUPABASE_PUBLIC_URL: env.SUPABASE_PUBLIC_URL,
  SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_ANON_KEY: env.SUPABASE_ANON_KEY,
  KORTIX_PUBLIC_AUTH_METHODS: env.KORTIX_PUBLIC_AUTH_METHODS,
  KORTIX_PUBLIC_AUTH_PROVIDERS: env.KORTIX_PUBLIC_AUTH_PROVIDERS,
  ENABLE_EMAIL_AUTOCONFIRM: env.ENABLE_EMAIL_AUTOCONFIRM,
  SUPABASE_JWT_SECRET: env.SUPABASE_JWT_SECRET,
  PROMPT_ATTACHMENT_UPLOAD_MODE: env.PROMPT_ATTACHMENT_UPLOAD_MODE,
  PROMPT_ATTACHMENT_CHUNK_BYTES: env.PROMPT_ATTACHMENT_CHUNK_BYTES,

  // ─── API Key Hashing ──────────────────────────────────────────────────────
  API_KEY_SECRET: env.API_KEY_SECRET,

  // ─── Pipedream Connect (Connector 1-click connectors) ──────────────────────
  PIPEDREAM_CLIENT_ID: env.PIPEDREAM_CLIENT_ID,
  PIPEDREAM_CLIENT_SECRET: env.PIPEDREAM_CLIENT_SECRET,
  PIPEDREAM_PROJECT_ID: env.PIPEDREAM_PROJECT_ID,
  PIPEDREAM_ENVIRONMENT: env.PIPEDREAM_ENVIRONMENT,
  PIPEDREAM_WEBHOOK_SECRET: env.PIPEDREAM_WEBHOOK_SECRET,

  // ─── Composio Connect (Connector connect provider) ─────────────────────────
  COMPOSIO_API_KEY: env.COMPOSIO_API_KEY,
  COMPOSIO_WEBHOOK_SECRET: env.COMPOSIO_WEBHOOK_SECRET,
  POSTMAN_API_KEY: env.POSTMAN_API_KEY,

  // ─── Search Providers ──────────────────────────────────────────────────────
  TAVILY_API_URL: env.TAVILY_API_URL,
  TAVILY_API_KEY: env.TAVILY_API_KEY,
  SERPER_API_URL: env.SERPER_API_URL,
  SERPER_API_KEY: env.SERPER_API_KEY,

  // ─── Proxy Providers ──────────────────────────────────────────────────────
  FIRECRAWL_API_URL: env.FIRECRAWL_API_URL,
  FIRECRAWL_API_KEY: env.FIRECRAWL_API_KEY,

  // ─── Managed git ──────────────────────────────────────────────────────────
  MANAGED_GIT_PROVIDER: env.MANAGED_GIT_PROVIDER,
  MANAGED_GIT_GITHUB_OWNER: env.MANAGED_GIT_GITHUB_OWNER,
  MANAGED_GIT_GITHUB_INSTALL_ID: env.MANAGED_GIT_GITHUB_INSTALL_ID,
  MANAGED_GIT_GITHUB_TOKEN: env.MANAGED_GIT_GITHUB_TOKEN,
  CODE_STORAGE_ORG: env.CODE_STORAGE_ORG,
  CODE_STORAGE_PRIVATE_KEY: env.CODE_STORAGE_PRIVATE_KEY,
  CODE_STORAGE_API_BASE: env.CODE_STORAGE_API_BASE,
  CODE_STORAGE_GIT_HOST: env.CODE_STORAGE_GIT_HOST,
  KORTIX_REQUIRE_DECLARED_AGENTS: env.KORTIX_REQUIRE_DECLARED_AGENTS,

  // ─── Legacy migration ─────────────────────────────────────────────────────
  LEGACY_MIGRATION_BACKUP_BUCKET: env.LEGACY_MIGRATION_BACKUP_BUCKET,

  // ─── Channels (Slack) ─────────────────────────────────────────────────────
  SLACK_SIGNING_SECRET: env.SLACK_SIGNING_SECRET,
  SLACK_CLIENT_ID: env.SLACK_CLIENT_ID,
  SLACK_CLIENT_SECRET: env.SLACK_CLIENT_SECRET,
  SLACK_REDIRECT_URI: env.SLACK_REDIRECT_URI,
  SLACK_OAUTH_SCOPES: env.SLACK_OAUTH_SCOPES,
  SLACK_HOME_HERO_URL: env.SLACK_HOME_HERO_URL,
  SLACK_REQUIRE_USER_IDENTITY: env.SLACK_REQUIRE_USER_IDENTITY,

  // ─── Channels (AgentMail email) ──────────────────────────────────────────
  AGENTMAIL_API_URL: env.AGENTMAIL_API_URL,
  AGENTMAIL_API_KEY: env.AGENTMAIL_API_KEY,
  AGENTMAIL_WEBHOOK_SECRET: env.AGENTMAIL_WEBHOOK_SECRET,
  TELEGRAM_API_URL: env.TELEGRAM_API_URL,
  KORTIX_OAUTH_CLIENTS: env.KORTIX_OAUTH_CLIENTS,

  // ─── Channels (Microsoft Teams) ───────────────────────────────────────────
  MICROSOFT_APP_ID: env.MICROSOFT_APP_ID,
  MICROSOFT_APP_PASSWORD: env.MICROSOFT_APP_PASSWORD,
  MICROSOFT_APP_TENANT: env.MICROSOFT_APP_TENANT,
  MICROSOFT_BOT_OPENID_METADATA: env.MICROSOFT_BOT_OPENID_METADATA,
  TEAMS_REQUIRE_USER_IDENTITY: env.TEAMS_REQUIRE_USER_IDENTITY,
  TEAMS_APP_NAME: env.TEAMS_APP_NAME,

  // ─── LLM Providers ────────────────────────────────────────────────────────
  PLATINUM_INFERENCE_URL: env.PLATINUM_INFERENCE_URL,
  PLATINUM_INFERENCE_API_KEY: env.PLATINUM_INFERENCE_API_KEY,
  // Unset → follow billing (cloud keeps its revenue lineup even if the env
  // blob misses the var; self-host stays off). Explicit value always wins.
  KORTIX_MANAGED_PROVIDER_ENABLED:
    env.KORTIX_MANAGED_PROVIDER_ENABLED ?? env.KORTIX_BILLING_INTERNAL_ENABLED,
  LLM_GATEWAY_BASE_URL: env.LLM_GATEWAY_BASE_URL,
  LLM_GATEWAY_DEFAULT_MODEL: env.LLM_GATEWAY_DEFAULT_MODEL,
  LLM_GATEWAY_VISION_MODEL: env.LLM_GATEWAY_VISION_MODEL,
  LLM_GATEWAY_FALLBACK_POLICIES: env.LLM_GATEWAY_FALLBACK_POLICIES,
  LLM_GATEWAY_CATALOG_URL: env.LLM_GATEWAY_CATALOG_URL,
  LLM_GATEWAY_PROXY_PORT: env.LLM_GATEWAY_PROXY_PORT,
  LLM_GATEWAY_PROXY_TARGET: env.LLM_GATEWAY_PROXY_TARGET,
  OPENAI_API_KEY: env.OPENAI_API_KEY,
  // ─── Stripe (Billing) ─────────────────────────────────────────────────────
  STRIPE_SECRET_KEY: env.STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET: env.STRIPE_WEBHOOK_SECRET,

  // ─── RevenueCat (Billing) ─────────────────────────────────────────────────
  REVENUECAT_WEBHOOK_SECRET: env.REVENUECAT_WEBHOOK_SECRET,

  // ─── Daytona (Sandbox provisioning + preview proxy) ───────────────────────
  // No DAYTONA_SNAPSHOT here — see comment in the env schema above. Every
  // sandbox boots from its project-specific snapshot resolved at session
  // start time by apps/api/src/snapshots/builder.ts.
  DAYTONA_API_KEY: env.DAYTONA_API_KEY,
  DAYTONA_SERVER_URL: env.DAYTONA_SERVER_URL,
  DAYTONA_TARGET: env.DAYTONA_TARGET,
  DAYTONA_WEBHOOK_SECRET: env.DAYTONA_WEBHOOK_SECRET,
  KORTIX_SNAPSHOT_REAP_PREDECESSOR: env.KORTIX_SNAPSHOT_REAP_PREDECESSOR,
  KORTIX_DRIVES_SESSION_MOUNT: env.KORTIX_DRIVES_SESSION_MOUNT,
  KORTIX_DRIVES_SYNC: env.KORTIX_DRIVES_SYNC,
  KORTIX_WORKSPACE_VOLUMES: env.KORTIX_WORKSPACE_VOLUMES,
  KORTIX_PROJECT_SNAPSHOT_MODE: env.KORTIX_PROJECT_SNAPSHOT_MODE,
  KORTIX_PROJECT_SNAPSHOT_S3_BUCKET: env.KORTIX_PROJECT_SNAPSHOT_S3_BUCKET,
  KORTIX_PROJECT_SNAPSHOT_S3_REGION: env.KORTIX_PROJECT_SNAPSHOT_S3_REGION,
  KORTIX_PROJECT_SNAPSHOT_S3_ENDPOINT: env.KORTIX_PROJECT_SNAPSHOT_S3_ENDPOINT,
  KORTIX_PROJECT_SNAPSHOT_S3_PUBLIC_ENDPOINT: env.KORTIX_PROJECT_SNAPSHOT_S3_PUBLIC_ENDPOINT,
  KORTIX_PROJECT_SNAPSHOT_S3_FORCE_PATH_STYLE: env.KORTIX_PROJECT_SNAPSHOT_S3_FORCE_PATH_STYLE,
  KORTIX_PROJECT_SNAPSHOT_S3_ACCELERATE: env.KORTIX_PROJECT_SNAPSHOT_S3_ACCELERATE,
  KORTIX_PROJECT_SNAPSHOT_S3_PREFIX: env.KORTIX_PROJECT_SNAPSHOT_S3_PREFIX,
  KORTIX_PROJECT_SNAPSHOT_S3_ACCESS_KEY_ID: env.KORTIX_PROJECT_SNAPSHOT_S3_ACCESS_KEY_ID,
  KORTIX_PROJECT_SNAPSHOT_S3_SECRET_ACCESS_KEY: env.KORTIX_PROJECT_SNAPSHOT_S3_SECRET_ACCESS_KEY,
  KORTIX_PROJECT_SNAPSHOT_DOWNLOAD_TTL_SECONDS: env.KORTIX_PROJECT_SNAPSHOT_DOWNLOAD_TTL_SECONDS,
  AUDIT_ARCHIVE_ENABLED: env.AUDIT_ARCHIVE_ENABLED,
  AUDIT_ARCHIVE_BUCKET: env.AUDIT_ARCHIVE_BUCKET,
  AUDIT_ARCHIVE_REGION: env.AUDIT_ARCHIVE_REGION,
  AUDIT_ARCHIVE_ENDPOINT: env.AUDIT_ARCHIVE_ENDPOINT,
  AUDIT_ARCHIVE_FORCE_PATH_STYLE: env.AUDIT_ARCHIVE_FORCE_PATH_STYLE,
  AUDIT_ARCHIVE_ACCESS_KEY_ID: env.AUDIT_ARCHIVE_ACCESS_KEY_ID,
  AUDIT_ARCHIVE_SECRET_ACCESS_KEY: env.AUDIT_ARCHIVE_SECRET_ACCESS_KEY,
  AUDIT_ARCHIVE_ROWS_PER_SECOND: env.AUDIT_ARCHIVE_ROWS_PER_SECOND,
  KORTIX_CAPTURE_S3_BUCKET: env.KORTIX_CAPTURE_S3_BUCKET,
  KORTIX_CAPTURE_S3_REGION: env.KORTIX_CAPTURE_S3_REGION,
  KORTIX_CAPTURE_S3_ENDPOINT: env.KORTIX_CAPTURE_S3_ENDPOINT,
  KORTIX_CAPTURE_S3_PUBLIC_ENDPOINT: env.KORTIX_CAPTURE_S3_PUBLIC_ENDPOINT,
  KORTIX_CAPTURE_S3_FORCE_PATH_STYLE: env.KORTIX_CAPTURE_S3_FORCE_PATH_STYLE,
  KORTIX_CAPTURE_S3_PROXY_TARGET: env.KORTIX_CAPTURE_S3_PROXY_TARGET,
  KORTIX_CAPTURE_S3_CREATE_BUCKET: env.KORTIX_CAPTURE_S3_CREATE_BUCKET,
  KORTIX_CAPTURE_S3_ACCESS_KEY_ID: env.KORTIX_CAPTURE_S3_ACCESS_KEY_ID,
  KORTIX_CAPTURE_S3_SECRET_ACCESS_KEY: env.KORTIX_CAPTURE_S3_SECRET_ACCESS_KEY,
  KORTIX_CAPTURE_STS_ROLE_ARN: env.KORTIX_CAPTURE_STS_ROLE_ARN,
  KORTIX_CAPTURE_STS_ENDPOINT: env.KORTIX_CAPTURE_STS_ENDPOINT,
  KORTIX_CAPTURE_SQS_QUEUE_URL: env.KORTIX_CAPTURE_SQS_QUEUE_URL,
  KORTIX_CAPTURE_INDEX_POLL_SECONDS: env.KORTIX_CAPTURE_INDEX_POLL_SECONDS,
  KORTIX_CAPTURE_ALERT_AFTER_MINUTES: env.KORTIX_CAPTURE_ALERT_AFTER_MINUTES,
  KORTIX_CAPTURE_UPDATE_MANIFEST_URL: env.KORTIX_CAPTURE_UPDATE_MANIFEST_URL,
  KORTIX_CONFIG_ARCHIVE_S3_BUCKET: env.KORTIX_CONFIG_ARCHIVE_S3_BUCKET,
  KORTIX_CONFIG_ARCHIVE_S3_REGION: env.KORTIX_CONFIG_ARCHIVE_S3_REGION,
  KORTIX_CONFIG_ARCHIVE_S3_ENDPOINT: env.KORTIX_CONFIG_ARCHIVE_S3_ENDPOINT,
  KORTIX_CONFIG_ARCHIVE_S3_FORCE_PATH_STYLE: env.KORTIX_CONFIG_ARCHIVE_S3_FORCE_PATH_STYLE,
  KORTIX_CONFIG_ARCHIVE_S3_ACCESS_KEY_ID: env.KORTIX_CONFIG_ARCHIVE_S3_ACCESS_KEY_ID,
  KORTIX_CONFIG_ARCHIVE_S3_SECRET_ACCESS_KEY: env.KORTIX_CONFIG_ARCHIVE_S3_SECRET_ACCESS_KEY,
  KORTIX_CONFIG_ARCHIVE_S3_PREFIX: env.KORTIX_CONFIG_ARCHIVE_S3_PREFIX,
  KORTIX_CONFIG_ARCHIVE_RETAIN_PER_PROJECT: env.KORTIX_CONFIG_ARCHIVE_RETAIN_PER_PROJECT,
  KORTIX_CONFIG_ARCHIVE_PUBLIC_URL: env.KORTIX_CONFIG_ARCHIVE_PUBLIC_URL,
  KORTIX_PROJECT_SNAPSHOT_MAX_ARCHIVE_BYTES: env.KORTIX_PROJECT_SNAPSHOT_MAX_ARCHIVE_BYTES,

  // Sandbox lifecycle intervals (minutes) — see schema comment above.
  KORTIX_SANDBOX_AUTOSTOP_MINUTES: env.KORTIX_SANDBOX_AUTOSTOP_MINUTES,
  KORTIX_SANDBOX_IDLE_DELETE_MINUTES: env.KORTIX_SANDBOX_IDLE_DELETE_MINUTES,
  KORTIX_SANDBOX_AUTOARCHIVE_MINUTES: env.KORTIX_SANDBOX_AUTOARCHIVE_MINUTES,
  KORTIX_SANDBOX_AUTODELETE_MINUTES: env.KORTIX_SANDBOX_AUTODELETE_MINUTES,
  KORTIX_SANDBOX_PROVIDER_AUTOSTOP_MINUTES: env.KORTIX_SANDBOX_PROVIDER_AUTOSTOP_MINUTES,

  PLATINUM_API_KEY:
    env.PLATINUM_TARGET === 'local' ? env.PLATINUM_API_KEY_LOCAL : env.PLATINUM_API_KEY,
  PLATINUM_API_URL:
    env.PLATINUM_TARGET === 'local' ? env.PLATINUM_API_URL_LOCAL : env.PLATINUM_API_URL,
  PLATINUM_TEMPLATE: env.PLATINUM_TEMPLATE,
  PLATINUM_WEBHOOK_SECRET: env.PLATINUM_WEBHOOK_SECRET,
  // ─── Sandbox Provisioning (Platform) ──────────────────────────────────────
  KORTIX_URL: env.KORTIX_URL,
  ALLOWED_SANDBOX_PROVIDERS: allowedProviders,

  /**
   * INTERNAL_SERVICE_KEY -- direction: kortix-api -> sandbox.
   *
   * This is how kortix-api authenticates itself TO the sandbox. Every request
   * from kortix-api to the sandbox (proxy, cron, health, queue drain, etc.)
   * includes `Authorization: Bearer <INTERNAL_SERVICE_KEY>`. The sandbox's
   * kortix-master middleware validates it.
   *
   * Counterpart: KORTIX_TOKEN goes the other direction (sandbox -> kortix-api).
   *
   * Auto-generated at startup if not provided -- always present.
   * Persisted to .env so the same key survives process restarts.
   */
  get INTERNAL_SERVICE_KEY(): string {
    if (!process.env.INTERNAL_SERVICE_KEY) {
      const { randomBytes } = require('crypto');
      const generated = randomBytes(32).toString('hex');
      process.env.INTERNAL_SERVICE_KEY = generated;
      console.log('[config] Auto-generated INTERNAL_SERVICE_KEY for sandbox auth');
      // Persist to .env so the key survives process restarts (avoids re-sync on every restart)
      try {
        const { appendFileSync, readFileSync } = require('fs');
        const { resolve } = require('path');
        const candidates = [
          resolve(__dirname, '../../.env'), // from src/config.ts -> ../../.env
          resolve(process.cwd(), '.env'), // cwd/.env
        ];
        for (const envPath of candidates) {
          // No existsSync-then-write: check-then-act on a path is a TOCTOU race.
          // The read IS the existence test — a missing/unreadable file throws us
          // to the next candidate, leaving no gap between check and use.
          let content: string;
          try {
            content = readFileSync(envPath, 'utf-8');
          } catch {
            continue;
          }
          if (!content.includes('INTERNAL_SERVICE_KEY=')) {
            appendFileSync(
              envPath,
              `\n# Auto-generated service key for sandbox auth (do not remove)\nINTERNAL_SERVICE_KEY=${generated}\n`,
            );
            console.log(`[config] Persisted INTERNAL_SERVICE_KEY to ${envPath}`);
          }
          break;
        }
      } catch (err: any) {
        // Non-fatal -- key still works in-memory for this process lifetime
        console.warn('[config] Could not persist INTERNAL_SERVICE_KEY to .env:', err.message);
      }
    }
    return process.env.INTERNAL_SERVICE_KEY!;
  },

  // ─── Frontend ────────────────────────────────────────────────────────────
  FRONTEND_URL: env.FRONTEND_URL,

  // ─── Tunnel (Reverse-Tunnel to Local Machine) ──────────────────────────────
  TUNNEL_SIGNING_SECRET: env.TUNNEL_SIGNING_SECRET,
  TUNNEL_ENABLED: env.TUNNEL_ENABLED,
  TUNNEL_HEARTBEAT_INTERVAL_MS: env.TUNNEL_HEARTBEAT_INTERVAL_MS,
  TUNNEL_HEARTBEAT_MAX_MISSED: env.TUNNEL_HEARTBEAT_MAX_MISSED,
  TUNNEL_RPC_TIMEOUT_MS: env.TUNNEL_RPC_TIMEOUT_MS,
  TUNNEL_RATE_LIMIT_RPC: env.TUNNEL_RATE_LIMIT_RPC,
  TUNNEL_RATE_LIMIT_PERM_REQUEST: env.TUNNEL_RATE_LIMIT_PERM_REQUEST,
  TUNNEL_RATE_LIMIT_WS_CONNECT: env.TUNNEL_RATE_LIMIT_WS_CONNECT,
  TUNNEL_RATE_LIMIT_PERM_GRANT: env.TUNNEL_RATE_LIMIT_PERM_GRANT,
  TUNNEL_MAX_WS_MESSAGE_SIZE: env.TUNNEL_MAX_WS_MESSAGE_SIZE,

  // ─── Abuse Controls ───────────────────────────────────────────────────────
  KORTIX_INVITE_ACCEPT_REQS_PER_MIN: env.KORTIX_INVITE_ACCEPT_REQS_PER_MIN,
  KORTIX_PUBLIC_RESPONSE_REQS_PER_MIN: env.KORTIX_PUBLIC_RESPONSE_REQS_PER_MIN,
  KORTIX_DEMO_REQUEST_REQS_PER_MIN: env.KORTIX_DEMO_REQUEST_REQS_PER_MIN,
  KORTIX_FEEDBACK_REQS_PER_MIN: env.KORTIX_FEEDBACK_REQS_PER_MIN,
  KORTIX_LLM_ROUTER_REQS_PER_MIN_FREE: env.KORTIX_LLM_ROUTER_REQS_PER_MIN_FREE,
  KORTIX_LLM_ROUTER_REQS_PER_MIN_PAID: env.KORTIX_LLM_ROUTER_REQS_PER_MIN_PAID,
  KORTIX_LLM_GATEWAY_REQS_PER_MIN: env.KORTIX_LLM_GATEWAY_REQS_PER_MIN,
  KORTIX_PROXY_REQS_PER_MIN: env.KORTIX_PROXY_REQS_PER_MIN,
  KORTIX_TRUSTED_PROXY_HOPS: env.KORTIX_TRUSTED_PROXY_HOPS,
  KORTIX_UNKNOWN_TOKEN_ATTEMPTS_PER_MIN: env.KORTIX_UNKNOWN_TOKEN_ATTEMPTS_PER_MIN,
  KORTIX_TRIGGER_MAX_PROVISIONING_SESSIONS_PER_PROJECT:
    env.KORTIX_TRIGGER_MAX_PROVISIONING_SESSIONS_PER_PROJECT,
  KORTIX_TRIGGER_SCHEDULER_ENABLED: env.KORTIX_TRIGGER_SCHEDULER_ENABLED,
  KORTIX_TRIGGER_SCHEDULER_INTERVAL_MS: env.KORTIX_TRIGGER_SCHEDULER_INTERVAL_MS,
  KORTIX_EVENT_POLLS_ENABLED: env.KORTIX_EVENT_POLLS_ENABLED,

  // ─── Version / GitHub ──────────────────────────────────────────────────────
  /** Dev override: force a specific sandbox version via env var. */
  SANDBOX_VERSION_OVERRIDE: env.SANDBOX_VERSION,
  GITHUB_TOKEN: env.GITHUB_TOKEN,

  // ─── Transactional email (provider chain) ──────────────────────────────────
  EMAIL_URL: env.EMAIL_URL,
  EMAIL_FROM: env.EMAIL_FROM,
  AUTH_EMAIL_HOOK_SECRET: env.AUTH_EMAIL_HOOK_SECRET,
  EMAIL_PROVIDER_ORDER: env.EMAIL_PROVIDER_ORDER,
  SMTP_HOST: env.SMTP_HOST,
  SMTP_PORT: env.SMTP_PORT,
  SMTP_USER: env.SMTP_USER,
  SMTP_PASS: env.SMTP_PASS,
  AWS_SES_REGION: env.AWS_SES_REGION,
  AWS_SES_ACCESS_KEY_ID: env.AWS_SES_ACCESS_KEY_ID,
  AWS_SES_SECRET_ACCESS_KEY: env.AWS_SES_SECRET_ACCESS_KEY,
  RESEND_API_KEY: env.RESEND_API_KEY,
  RESEND_FROM_EMAIL: env.RESEND_FROM_EMAIL,
  EXPO_ACCESS_TOKEN: env.EXPO_ACCESS_TOKEN,
  EXPO_PUSH_ENABLED: env.EXPO_PUSH_ENABLED ?? !env.KORTIX_INSTANCE_ID,
  PUSH_NOTIFICATIONS_ENABLED: env.PUSH_NOTIFICATIONS_ENABLED,
  MAILPIT_API_URL: env.MAILPIT_API_URL,
  MAILTRAP_API_TOKEN: env.MAILTRAP_API_TOKEN,
  MAILTRAP_FROM_EMAIL: env.MAILTRAP_FROM_EMAIL,
  MAILTRAP_FROM_NAME: env.MAILTRAP_FROM_NAME,
  DEMO_LEAD_NOTIFY_EMAIL:
    env.DEMO_LEAD_NOTIFY_EMAIL ??
    (env.INTERNAL_KORTIX_ENV === 'prod' ? 'marko@kortix.ai,hey@kortix.ai' : ''),
  DEMO_LEAD_FROM_EMAIL: env.DEMO_LEAD_FROM_EMAIL,

  // ─── Mailtrap contact sync (signup → automation lists) ────────────────────
  MAILTRAP_ACCOUNT_ID: env.MAILTRAP_ACCOUNT_ID,
  MAILTRAP_SIGNUPS_LIST_ID: env.MAILTRAP_SIGNUPS_LIST_ID,
  MAILTRAP_BUSINESS_SIGNUPS_LIST_ID: env.MAILTRAP_BUSINESS_SIGNUPS_LIST_ID,

  // ─── Signup webhook (signup → sales factory) ──────────────────────────────
  SIGNUP_WEBHOOK_URL: env.SIGNUP_WEBHOOK_URL,
  SIGNUP_WEBHOOK_SECRET: env.SIGNUP_WEBHOOK_SECRET,

  // ─── Stray env vars (centralized from other files) ────────────────────────
  CORS_ALLOWED_ORIGINS: env.CORS_ALLOWED_ORIGINS,
  KORTIX_MAX_REQUEST_BODY_BYTES: env.KORTIX_MAX_REQUEST_BODY_BYTES,

  // ─── Helper Methods ────────────────────────────────────────────────────────

  isProviderEnabled(name: SandboxProviderName): boolean {
    if (!this.ALLOWED_SANDBOX_PROVIDERS.includes(name)) return false;
    switch (name) {
      case 'daytona':
        return !!this.DAYTONA_API_KEY;
      case 'platinum':
        return !!this.PLATINUM_API_KEY;
      default: {
        const exhaustive: never = name;
        return exhaustive;
      }
    }
  },

  /**
   * Default sandbox provider for new sessions. First entry of
   * ALLOWED_SANDBOX_PROVIDERS, with 'platinum' as the safety belt for an
   * empty list. The ordering is the automatic-selection preference; callers
   * that explicitly choose a provider bypass that preference.
   */
  getDefaultProvider(): SandboxProviderName {
    return this.ALLOWED_SANDBOX_PROVIDERS[0] ?? 'platinum';
  },

  isPlatinumEnabled(): boolean {
    return this.ALLOWED_SANDBOX_PROVIDERS.includes('platinum') && !!this.PLATINUM_API_KEY;
  },
};

// ─── Tool Pricing (Router) ──────────────────────────────────────────────────

interface ToolPricing {
  baseCost: number;
  perResultCost: number;
  markupMultiplier: number;
}

const TOOL_PRICING: Record<string, ToolPricing> = {
  web_search_basic: {
    baseCost: 0.005,
    perResultCost: 0,
    markupMultiplier: 1.5,
  },
  web_search_advanced: {
    baseCost: 0.025,
    perResultCost: 0,
    markupMultiplier: 1.5,
  },
  image_search: {
    baseCost: 0.001,
    perResultCost: 0,
    markupMultiplier: 2.0,
  },
  proxy_tavily: {
    baseCost: 0.005,
    perResultCost: 0,
    markupMultiplier: 1.5,
  },
  proxy_serper: {
    baseCost: 0.001,
    perResultCost: 0,
    markupMultiplier: 1.5,
  },
  proxy_firecrawl: {
    baseCost: 0.01,
    perResultCost: 0,
    markupMultiplier: 1.5,
  },
  // Crawl status polls cost nothing upstream, so they cost nothing here.
  proxy_firecrawl_status: {
    baseCost: 0,
    perResultCost: 0,
    markupMultiplier: 1,
  },
  proxy_context7: {
    baseCost: 0.001,
    perResultCost: 0,
    markupMultiplier: 1.5,
  },
};

export function getToolCost(toolName: string, resultCount = 0): number {
  const pricing = TOOL_PRICING[toolName];
  if (!pricing) {
    return 0.01;
  }

  const base = pricing.baseCost * pricing.markupMultiplier;
  const perResult = pricing.perResultCost * pricing.markupMultiplier * resultCount;
  return base + perResult;
}
