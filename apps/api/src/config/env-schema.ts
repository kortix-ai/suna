import { z } from 'zod';
import { PLATFORM_DEFAULT_MODEL_ID } from '@kortix/llm-catalog';
import { SLACK_BOT_SCOPES } from '../channels/slack-manifest';
import {
  DEFAULT_LLM_GATEWAY_FALLBACK_POLICIES,
  parseFallbackPolicies,
} from '../llm-gateway/routing/policy-config';

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

/** Optional decimal with a default — money, unlike optInt's counts. A
 *  non-numeric or negative value falls back to the default rather than
 *  silently becoming a cap of NaN (which compares false against everything and
 *  would disable the limit it was set to enforce). */
const optNum = (def: number) =>
  z
    .string()
    .optional()
    .default(String(def))
    .transform((v) => {
      const n = Number.parseFloat(v);
      return Number.isFinite(n) && n >= 0 ? n : def;
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

/**
 * Morph direct is OFF by default (2026-09-27). Its deepseek-v4.1-flash endpoint
 * ran at 78.9% uptime over 30 min on OpenRouter's public stats while our users
 * waited 18-75 s per call: the gateway fails over only on errors and a 90 s
 * header timeout, never on a slow first byte. Managed models are served by
 * their OpenRouter pool instead. Re-enable per environment by setting
 * MORPH_MANAGED_MODELS to a comma-separated list of managed model ids.
 */
export const MORPH_MANAGED_MODELS_DEFAULT = '';

export function parseMorphManagedModels(value: string): string[] {
  return value.split(',').map((id) => id.trim()).filter(Boolean);
}

const envSchema = z.object({
  // ── Core (required) ──────────────────────────────────────────────────────
  PORT: optInt(8008),

  // ── Database (REQUIRED) ──────────────────────────────────────────────────
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required — cannot start without a database'),

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
    .refine((v) => v === '' || /^https?:\/\//.test(v), { message: 'SUPABASE_PUBLIC_URL must be a valid HTTP(S) URL' })
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
  // Legacy symmetric (HS256) JWT secret of the Supabase project. When set, the
  // API checks an HS256 access token's signature and expiry locally instead of
  // asking GoTrue on every request (shared/jwt-verify.ts). Optional: without it
  // HS256 tokens keep the per-request GoTrue round trip.
  SUPABASE_JWT_SECRET: optStr,
  // How long a GoTrue confirmation that an HS256 token's session is still live
  // is reused, per token, per replica. This is the upper bound on how long a
  // signed-out or deleted user's still-unexpired HS256 token keeps working on a
  // replica that already confirmed it. 0 = confirm with GoTrue on every request
  // (the pre-2026-09-23 behavior).
  SUPABASE_JWT_LIVENESS_TTL_MS: optInt(30_000),

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
  // Global background-worker switch. API-only and migration-shadow deployments
  // keep request handling active while disabling every recurring write loop.
  KORTIX_WORKERS_ENABLED: optBoolTrue,
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
  /** Websocket relay, gated separately so it can roll out behind the HTTP leg. */
  KORTIX_RELAY_WS_ENABLED: optBoolTrue,
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
  // EXPERIMENTAL: the "Use this template" install feature — the /v1/templates
  // routes plus the use-case-page button + install wizard. Single kill-switch;
  // off by default so it stays hidden in prod while templates are authored.
  KORTIX_TEMPLATES_ENABLED: optBoolTrue,
  // Serve the public OpenAPI spec (/v1/openapi.json) + Scalar docs UI (/v1/docs).
  // On by default — the base API surface is meant to be discoverable. Internal
  // routers (/v1/admin, /v1/ops) are ALWAYS stripped from the spec regardless
  // (see openapi/index.ts filterSpecPaths); this flag lets a hardened self-host
  // deployment turn the whole docs/spec surface OFF so no route shapes publish.
  OPENAPI_PUBLIC_DOCS: optBoolTrue,
  // Self-host enterprise license: when the operator has purchased/holds a
  // Kortix Enterprise license, this bypasses the sales-assigned `enterprise`
  // tier check and unlocks every enterprise entitlement (SSO, SCIM, RBAC,
  // audit access) regardless of the account's billing tier — see
  // getAccountEntitlements()/accountHasEntitlement() in
  // billing/services/entitlements.ts. Off by default; billing is irrelevant
  // for a self-host license check, unlike the `demoEnterprise` per-account
  // preview toggle this mirrors.
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
  CONTEXT7_API_URL: optUrl('https://context7.com'),
  CONTEXT7_API_KEY: optStr,

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
  SLACK_BOT_TOKEN: optStr,
  SLACK_SIGNING_SECRET: optStr,
  SLACK_TEAM_ID: optStr,
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
  OPENROUTER_API_URL: optUrl('https://openrouter.ai/api/v1'),
  // OpenRouter remains available for the router and project BYOK connections.
  OPENROUTER_API_KEY: optStr,
  MORPH_API_URL: optUrl('https://api.morphllm.com/v1'),
  MORPH_API_KEY: optStr,
  // Managed model IDs that use Morph direct as their first candidate.
  // An empty value disables Morph for every managed model — the default since
  // 2026-09-27 (see MORPH_MANAGED_MODELS_DEFAULT).
  MORPH_MANAGED_MODELS: z.string().default(MORPH_MANAGED_MODELS_DEFAULT).transform(parseMorphManagedModels),
  // Whether a session's sandbox gets the `kortix-connectors` OpenCode MCP
  // server (KORTIX_CONNECTORS_MCP_ENABLED in the guest). It exposes the
  // connector meta-tools plus `secret_call`, the only way to use an
  // HTTPS-broker secret — those have no env var and no readable value, so
  // without a tool the model has to find a shell command in a prompt file.
  //
  // ON by default: the tools are the discoverable surface for capabilities the
  // agent already has. This is the operator kill switch — it takes the MCP
  // server away fleet-wide without a code change.
  //
  // optBoolTrue disables on the literal string `false` ONLY: `0`, `no` and
  // `off` all leave it ON. Write `CONNECTORS_MCP_ENABLED=false`.
  //
  // The email channel sets the guest variable itself from durable session
  // metadata (session-channel-env.ts) and keeps the face either way — that
  // channel was the only consumer before this flag, so turning this off
  // restores the previous behaviour rather than regressing email sessions.
  CONNECTORS_MCP_ENABLED: optBoolTrue,
  // Managed LLM gateway (/v1/llm) — the `kortix` OpenCode provider routes every
  // sandbox model call here. Off by default.
  LLM_GATEWAY_ENABLED: optBoolFalse,
  // CLOUD-ONLY. Whether KORTIX's own managed model lineup exists on this
  // deployment. The lineup routes through Kortix's shared Bedrock and
  // OpenRouter credentials. Kortix bills each route as platform credits.
  // This flag is independent of
  // LLM_GATEWAY_ENABLED above: a self-host still runs the gateway for its own
  // BYOK routing (every sandbox model call goes through `/v1/llm`), it just
  // must never see or route to Kortix's shared credentials. When unset it
  // follows KORTIX_BILLING_INTERNAL_ENABLED (derived below): billing on =
  // managed cloud where the managed lineup is the product; billing off =
  // self-host where it must stay dark. An explicit true/false always wins.
  // See RUNTIME_MANAGED_MODELS (managed-models.ts) and managedCandidates()
  // (descriptors.ts) — both are gated on this and read no managed credentials
  // when off.
  KORTIX_MANAGED_PROVIDER_ENABLED: optBoolUnset,
  // Fleet default for projects with no explicit per-project override. Defaults
  // ON: wherever the gateway is available (master switch above), the managed
  // gateway is the default routing mechanism and every project inherits it
  // unless it explicitly opts out. Turning the per-project flag OFF is a
  // fully supported first-class path (native OpenCode provider management:
  // provider keys injected into the sandbox env, native `provider/model`
  // refs, no gateway URL in the box) — the deliberate lever for deployments
  // like SampleCo that want their own keys end to end. The master switch
  // still wins — LLM_GATEWAY_ENABLED=false forces native OpenCode for
  // everyone regardless of this value — and an operator can set
  // LLM_GATEWAY_DEFAULT_ENABLED=false to opt a whole environment back to
  // native-by-default.
  LLM_GATEWAY_DEFAULT_ENABLED: optBoolTrue,
  // Empty = the in-API gateway at `${KORTIX_URL}/v1/llm`. Set to a standalone
  // gateway's public base (…/v1/llm) to route every sandbox model call there.
  LLM_GATEWAY_BASE_URL: optStr,
  // Runtime routing is control-plane configuration, not a model-catalog
  // constant baked into the gateway binary. Operators can replace the default
  // and define any number of exact-match fallback policies without code changes.
  LLM_GATEWAY_DEFAULT_MODEL: optStrDefault(PLATFORM_DEFAULT_MODEL_ID),
  // Image-capable managed model used when the default receives an image.
  LLM_GATEWAY_VISION_MODEL: optStrDefault('deepseek-v4.1-flash'),
  LLM_GATEWAY_FALLBACK_POLICIES: optFallbackPolicies,
  // Optional JSON array replacing the platform managed-model overlay (transport,
  // upstream id, pricing ref, capabilities). Empty uses the bundled last-known
  // defaults; managed routes are otherwise fully operator-defined.
  LLM_GATEWAY_MANAGED_MODELS: optStr,
  // Runtime source for provider/model metadata. The API keeps the last known
  // snapshot if this source is temporarily unavailable.
  LLM_GATEWAY_CATALOG_URL: optUrl('https://models.dev/api.json'),
  // BYOK resilience: when a user's own provider key hits a rate-limit / quota /
  // billing error (429/402/403), fall over to THIS managed model (billed as
  // Kortix credits) so the turn survives instead of erroring. Empty disables.
  LLM_GATEWAY_BYOK_FALLBACK_MODEL: optStrDefault('deepseek-v4.1-flash'),
  // Dev: reverse-proxy /v1/llm-gateway/* to a standalone gateway on this port,
  // so sandboxes reach it through the API's own tunnel (no separate tunnel).
  LLM_GATEWAY_PROXY_PORT: optInt(0),
  // Where the /v1/llm-gateway/* reverse-proxy forwards. Defaults to
  // 127.0.0.1:LLM_GATEWAY_PROXY_PORT (local, gateway same host). In K8s set to
  // the in-cluster gateway service, e.g. http://kortix-gateway:8090, so the
  // gateway stays internal and sandboxes reach it via the API's public origin.
  LLM_GATEWAY_PROXY_TARGET: optStr,
  OPENAI_API_URL: optUrl('https://api.openai.com/v1'),
  OPENAI_API_KEY: optStr,
  // xAI / Gemini / Groq route their TEXT models through OpenRouter (see
  // router/config/proxy-services.ts), so only base URLs are read there.
  XAI_API_URL: optUrl('https://api.x.ai/v1'),
  GEMINI_API_URL: optUrl('https://generativelanguage.googleapis.com/v1beta'),
  GROQ_API_URL: optUrl('https://api.groq.com/openai/v1'),
  // ── LiveKit — the voice channel's transport (see channels/voice/livekit.ts) ──
  // A room per call, an agents-js worker doing STT->LLM->TTS, a plain LiveKit
  // client page a human opens directly. Defaults match the project's local dev
  // server (ws://localhost:7880, devkey/secret are LiveKit's own published
  // dev-mode credentials, not a real secret) — every real deployment overrides
  // all three.
  LIVEKIT_URL: optStrDefault('ws://localhost:7880'),
  LIVEKIT_API_KEY: optStrDefault('devkey'),
  LIVEKIT_API_SECRET: optStrDefault('secret'),
  // ── Billing — Stripe (optional, only for cloud billing) ──────────────────
  STRIPE_SECRET_KEY: optStr,
  STRIPE_WEBHOOK_SECRET: optStr,

  // ── Billing — RevenueCat (optional) ──────────────────────────────────────
  REVENUECAT_WEBHOOK_SECRET: optStr,

  // ── Daytona — Sandbox provisioning (conditional: required if daytona provider enabled) ──
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
  // Pi worker pool (harness/worker split P1.8): keep this many PARKED boxes of
  // the shared pi-worker snapshot per environment, claimed at session create
  // (a claim skips provider create + box boot, ~4s of the cold path measured
  // on dev 2026-08-27). 0 = off. Pure accelerator: claim failure falls back to
  // an ordinary cold create.
  KORTIX_PI_WORKER_POOL_TARGET: optInt(0),
  // Parked boxes older than this are reaped and replaced; also the Daytona
  // auto-stop backstop a parked box is created with, so an orphaned box
  // reclaims itself even if every API instance dies.
  KORTIX_PI_WORKER_POOL_MAX_AGE_MINUTES: optInt(60),
  // The fresh-session Git fast path: KORTIX_SESSION_FRESH, the base-tip +
  // scaffold-delta hint (inline or remote bundle), and the OpenCode config-dir
  // hint that lets the daemon spawn OpenCode before the checkout. Default ON;
  // `false` restores the pre-2026-08-27 create-time contract. The daemon side
  // is additive and falls back to the clone path without these hints.
  KORTIX_FAST_GIT_BOOT_ENABLED: optBoolTrue,
  // Experimental compiled boot path. The API builds a verified checkout and
  // OpenCode launcher for one exact Git SHA. `off` preserves the clone and
  // baked-agent path. `shadow` verifies both artifacts without using them.
  // `prefer` uses both artifacts with legacy fallback. `required` fails closed.
  KORTIX_COMPILED_BOOT_MODE: z
    .enum(['off', 'shadow', 'prefer', 'required'])
    .optional()
    .default('off'),
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

  // ── Config releases (optional) ──────────────────────────────────────────
  // Operator kill switch for the whole config-release feature (the
  // `config_releases` per-project flag). Default ON: a session runs the base branch's current
  // config. Set to false and the flag is unavailable platform-wide — the
  // Settings row disappears, both routes answer 403 `feature_disabled` for
  // every project, no convergence is scheduled, and every session falls back
  // to reading its workspace config dir, whatever a project chose.
  CONFIG_RELEASES_ENABLED: optBoolFalse,
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
  // Required when CONFIG_RELEASES_ENABLED is on — see the conditional check in
  // validateEnv(); without it every archive request rebuilds from the mirror.
  KORTIX_CONFIG_ARCHIVE_S3_BUCKET: optStr,
  KORTIX_CONFIG_ARCHIVE_S3_REGION: optStr,
  /** S3-compatible endpoint. Empty = the AWS regional endpoint. */
  KORTIX_CONFIG_ARCHIVE_S3_ENDPOINT: optUrl(''),
  KORTIX_CONFIG_ARCHIVE_S3_FORCE_PATH_STYLE: optBoolFalse,
  KORTIX_CONFIG_ARCHIVE_S3_ACCESS_KEY_ID: optStr,
  KORTIX_CONFIG_ARCHIVE_S3_SECRET_ACCESS_KEY: optStr,
  /** Key prefix inside the bucket. Keeps config archives apart from snapshots. */
  KORTIX_CONFIG_ARCHIVE_S3_PREFIX: optStr.transform((v) => (v.trim() ? v.trim() : 'config-releases')),
  /** Archives kept per project. Older ones are deleted after a publish. */
  KORTIX_CONFIG_ARCHIVE_RETAIN_PER_PROJECT: optInt(20),
  // The endpoint the SANDBOX reaches the store through, when it differs from
  // the API's. Download URLs are presigned for this host and the archive route
  // answers 302 to them. Unset = presign for the API's own endpoint, and the
  // route streams the bytes when that host is loopback or private.
  KORTIX_CONFIG_ARCHIVE_PUBLIC_URL: optUrl(''),

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

  // ── E2B — sandbox provisioning (conditional: required if enabled) ────────
  // E2B_DOMAIN is the base E2B domain without a protocol. The default uses
  // E2B Cloud. A self-hosted deployment uses its own base domain.
  // E2B_TEMPLATE is an optional ready fallback template. Project-specific
  // templates built by the shared snapshot system take precedence.
  E2B_API_KEY: optStr,
  E2B_DOMAIN: optStrDefault('e2b.dev'),
  E2B_TEMPLATE: optStr,

  // ── Sandbox Platform ──────────────────────────────────────────────────────
  // Public API base URL, without a route suffix. Auto-derived from PORT in local mode.
  KORTIX_URL: optStr,
  ALLOWED_SANDBOX_PROVIDERS: optStrDefault('daytona'),

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
  KORTIX_SANDBOX_TRIGGER_AUTOSTOP_MINUTES: optInt(5),
  KORTIX_SANDBOX_AUTOARCHIVE_MINUTES: optInt(720), // 12 hours
  KORTIX_SANDBOX_AUTODELETE_MINUTES: optInt(-1), // never auto-delete
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
  KORTIX_PUBLIC_SESSION_SHARE_REQS_PER_MIN: optInt(60),
  KORTIX_DEMO_REQUEST_REQS_PER_MIN: optInt(10),
  KORTIX_VOICE_JOIN_LINK_REQS_PER_MIN: optInt(30),
  // Higher than the resolve step above on purpose: the /voice page polls the
  // call transcript for the whole call, so this is per-listener-per-minute
  // traffic, not a one-shot handshake.
  KORTIX_VOICE_TRANSCRIPT_REQS_PER_MIN: optInt(120),
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
  // Where public demo-request / "book a demo" lead notifications are sent.
  // Comma-separated list; every address gets every submission.
  DEMO_LEAD_NOTIFY_EMAIL: optStrDefault('marko@kortix.ai,hey@kortix.ai'),
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

  // ── Better Stack Observability (optional — graceful degradation) ────────
  BETTERSTACK_API_LOG_TOKEN: optStr, // Logtail source token for structured logs
  BETTERSTACK_API_LOG_HOST: optStr, // Logtail ingesting host (e.g. s1234.us-east-9.betterstackdata.com)
  BETTERSTACK_API_SENTRY_DSN: optStr, // Sentry DSN for error tracking (Better Stack compatible)

  // ── Stray env vars used directly in other files (centralized here) ───────
  CORS_ALLOWED_ORIGINS: optStr,
  KORTIX_MASTER_URL: optStr,
  OPENCODE_URL: optStr,
  KORTIX_DATA_DIR: optStr,
});

export { envSchema };
