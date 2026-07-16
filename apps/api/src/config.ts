import { z } from 'zod';
import { SLACK_BOT_SCOPES } from './channels/slack-manifest';
import {
  DEFAULT_LLM_GATEWAY_FALLBACK_POLICIES,
  parseFallbackPolicies,
} from './llm-gateway/routing/policy-config';

/**
 * Running sandbox version.
 *
 * Source of truth: SANDBOX_VERSION env var, injected at container start
 * by deploy-zero-downtime.sh (extracted from the Docker image tag).
 * Falls back to 'unknown' only if the env var is missing.
 */
export const SANDBOX_VERSION = process.env.SANDBOX_VERSION || 'unknown';

// ─── Types ──────────────────────────────────────────────────────────────────

export type SandboxProviderName = 'daytona' | 'platinum' | 'e2b';
type InternalKortixEnv = 'dev' | 'staging' | 'prod' | 'preview';

// ─── Zod Helpers ────────────────────────────────────────────────────────────

/** Optional string — defaults to empty string when missing or empty. */
const optStr = z.string().optional().default('');

/** Optional string with a custom default value. */
const optStrDefault = (def: string) => z.string().optional().default(def);

/** Optional URL string with a custom default. Not required, just validated if present. */
const optUrl = (def: string) =>
  z.string().optional().default(def).refine(
    (v) => v === '' || /^https?:\/\//.test(v),
    { message: 'Must be a valid HTTP(S) URL' },
  );

/** Optional int with a default. */
const optInt = (def: number) =>
  z.string().optional().default(String(def)).transform((v) => {
    const n = parseInt(v, 10);
    return Number.isNaN(n) ? def : n;
  });

/** Optional boolean. optBoolFalse accepts the common truthy spellings
 * (case-insensitive) so a "1" / "yes" / "on" from a k8s env or secret bundle
 * isn't silently dropped. optBoolTrue keeps its original 'anything but false'
 * rule. */
const optBoolTrue = z.string().optional().default('true').transform((v) => v !== 'false');
const optBoolFalse = z
  .string()
  .optional()
  .default('false')
  .transform((v) => ['true', '1', 'yes', 'on'].includes(v.trim().toLowerCase()));

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
  PORT:                        optInt(8008),

  // ── Database (REQUIRED) ──────────────────────────────────────────────────
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required — cannot start without a database'),

  // ── Supabase (REQUIRED) ──────────────────────────────────────────────────
  SUPABASE_URL: z.string().min(1, 'SUPABASE_URL is required').refine(
    (v) => /^https?:\/\//.test(v),
    { message: 'SUPABASE_URL must be a valid HTTP(S) URL' },
  ),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, 'SUPABASE_SERVICE_ROLE_KEY is required'),

  // ── API Key Hashing (REQUIRED) ───────────────────────────────────────────
  API_KEY_SECRET: z.string().min(1, 'API_KEY_SECRET is required — API key hashing will fail'),

  // ── Internal Deployment Controls (optional, safe defaults for self-hosted) ─
  // `preview` = ephemeral per-PR API on EKS (shares the dev data plane, never
  // migrates it, workers off, allows preview frontends in CORS). See ensure-schema.ts + the CORS block in index.ts.
  INTERNAL_KORTIX_ENV:              z.enum(['dev', 'staging', 'prod', 'preview']).optional().default('dev'),
  // Master switch: turns on real billing (Stripe + credit ledger), makes
  // KORTIX_URL fatal-required, mounts the proxy-auth gate, hides /v1/setup.
  // Set to true on managed/cloud deployments; leave false for self-host + dev.
  KORTIX_BILLING_INTERNAL_ENABLED:  optBoolFalse,
  // EXPERIMENTAL: the "Use this template" install feature — the /v1/templates
  // routes plus the use-case-page button + install wizard. Single kill-switch;
  // off by default so it stays hidden in prod while templates are authored.
  KORTIX_TEMPLATES_ENABLED:         optBoolTrue,
  // Self-host enterprise license: when the operator has purchased/holds a
  // Kortix Enterprise license, this bypasses the sales-assigned `enterprise`
  // tier check and unlocks every enterprise entitlement (SSO, SCIM, RBAC,
  // audit access) regardless of the account's billing tier — see
  // getAccountEntitlements()/accountHasEntitlement() in
  // billing/services/entitlements.ts. Off by default; billing is irrelevant
  // for a self-host license check, unlike the `demoEnterprise` per-account
  // preview toggle this mirrors.
  ENTERPRISE_LICENSE_AVAILABLE:     optBoolFalse,

  // ── Search Providers (optional — features degrade gracefully) ────────────
  TAVILY_API_URL:              optUrl('https://api.tavily.com'),
  TAVILY_API_KEY:              optStr,
  SERPER_API_URL:              optUrl('https://google.serper.dev'),
  SERPER_API_KEY:              optStr,
  APIFY_API_URL:               optUrl('https://api.apify.com'),
  APIFY_TOKEN:                 optStr,

  // ── Proxy Providers (optional) ───────────────────────────────────────────
  FIRECRAWL_API_URL:           optUrl('https://api.firecrawl.dev'),
  FIRECRAWL_API_KEY:           optStr,
  REPLICATE_API_URL:           optUrl('https://api.replicate.com'),
  REPLICATE_API_TOKEN:         optStr,
  CONTEXT7_API_URL:            optUrl('https://context7.com'),
  CONTEXT7_API_KEY:            optStr,

  // ── Managed git (provider-agnostic via the git proxy) ────────────────────
  // MANAGED_GIT_PROVIDER selects the backend NEW managed repos provision on
  // ('github' default; only active managed backend). The GitHub backend creates
  // repos under MANAGED_GIT_GITHUB_OWNER (a Kortix-owned org) via the Kortix App
  // installed there (MANAGED_GIT_GITHUB_INSTALL_ID). Reuses KORTIX_GITHUB_APP_*
  // for the App JWT. Each backend's isConfigured() checks its own vars, so
  // leaving these blank keeps the managed-git path inert.
  MANAGED_GIT_PROVIDER:            optStr,
  MANAGED_GIT_GITHUB_OWNER:        optStr,
  MANAGED_GIT_GITHUB_INSTALL_ID:   optStr,
  // Optional straight org PAT for the managed org (the "one server-side key"
  // model). When set it takes precedence
  // over the GitHub App for managed-org admin ops (create/delete repo, invite
  // collaborator). Leave blank to use the App installation instead.
  MANAGED_GIT_GITHUB_TOKEN:        optStr,
  // When true, runtime clients (sandbox + `kortix` CLI) use the Kortix git
  // proxy as their git origin (auth = KORTIX_TOKEN) instead of the real host —
  // so a real GitHub credential never reaches a sandbox. Requires a
  // daemon snapshot that returns KORTIX_TOKEN for the proxy host (back-compat:
  // OFF leaves the direct clone-credential token flow untouched).
  KORTIX_GIT_PROXY:                optBoolFalse,
  // ── Pause / resume tuning ─────────────────────────────────────────────────
  // The sandbox idle→stop / stop→archive / →delete intervals live below as
  // KORTIX_SANDBOX_AUTOSTOP_MINUTES / AUTOARCHIVE_MINUTES / AUTODELETE_MINUTES
  // (consumed by daytonaLifecycle()). Main's 3-day auto-archive default already
  // keeps a hibernated box in the fast-resume "stopped" tier far longer than the
  // earlier 120m, so the pause/resume win is subsumed there.
  // Pre-resume: on a user returning to a project, proactively provider.start
  // their most-recently-stopped session(s) so the ~8s resume overlaps the
  // user's navigation and the session is ready by the time they open it. Reuses
  // resumeStoppedSandbox (idempotent with the on-open resume). GATED OFF by
  // default (speculative compute — starts a box the user might not open). Enable
  // after validating; tune how many recent sessions to pre-resume per project.
  KORTIX_PRERESUME_ENABLED:         optBoolFalse,
  KORTIX_PRERESUME_MAX_PER_PROJECT: optInt(1),

  // Lock a session to the agent it booted with: the preview proxy 409s a prompt
  // that asks OpenCode to run a different agent. GATED OFF by default — it was
  // added for a future per-agent executor-token auth model that isn't built yet,
  // and meanwhile it blocks legitimate in-session agent switching and
  // false-positives on new sessions (the picker can send the first agent in the
  // list before the session's real default resolves). TODO(marko): re-enable once
  // the executor token is re-minted per requested agent before tool execution.
  KORTIX_ENFORCE_SESSION_AGENT_LOCK: optBoolFalse,

  // Mandatory declared agents (docs/specs/2026-07-05-agent-first-config-unification.md
  // §2.1/§3 Phase 2). GATED OFF platform-wide by default — flipping it on would
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
  SLACK_BOT_TOKEN:             optStr,
  SLACK_SIGNING_SECRET:        optStr,
  SLACK_TEAM_ID:               optStr,
  SLACK_CLIENT_ID:             optStr,
  SLACK_CLIENT_SECRET:         optStr,
  SLACK_REDIRECT_URI:          optStr,
  // Derived from the SINGLE scope source of truth (SLACK_BOT_SCOPES in
  // channels/slack-manifest.ts) so OAuth always grants exactly what the manifest
  // declares — no hand-synced drift. 100% bot-token scopes; the integration
  // never requests a user token (no user_scope= param).
  SLACK_OAUTH_SCOPES:          optStrDefault(SLACK_BOT_SCOPES.join(',')),
  // Optional banner image rendered at the top of the App Home tab. Must be a
  // public HTTPS URL Slack can fetch (no auth). Recommended 1600×400 PNG.
  SLACK_HOME_HERO_URL:         optStr,
  // Per-Slack-user identity. Default-on: each sender must link their own Kortix
  // account via `/kortix login` and the agent runs AS them; unlinked senders
  // are blocked. Set explicitly to "false" only for legacy fallback where
  // Slack messages should run as the bound project owner.
  SLACK_REQUIRE_USER_IDENTITY: optBoolTrue,

  // ── Channels — AgentMail email adapter (optional) ────────────────────────
  AGENTMAIL_API_URL:           optUrl('https://api.agentmail.to/v0'),
  AGENTMAIL_API_KEY:           optStr,
  AGENTMAIL_WEBHOOK_SECRET:    optStr,

  // ── Channels — Recall.ai meeting bot (optional) ──────────────────────────
  // MEET_ENABLED is the operator master switch (the global gate): when false the
  // Google Meet experimental feature is unavailable platform-wide regardless of
  // any per-project choice. RECALL_BASE_URL is the regional gateway (us-west-2 =
  // pay-as-you-go default; us-east-1 / eu-central-1 / ap-northeast-1 also exist).
  // The key is sent server-side as `Authorization: Token <key>`; never in a sandbox.
  MEET_ENABLED:                optBoolFalse,
  RECALL_BASE_URL:             optUrl('https://us-west-2.recall.ai/api/v1'),
  RECALL_API_KEY:              optStr,
  // ElevenLabs TTS — gives the meeting bot a voice (the agent speaks in-call).
  ELEVENLABS_BASE_URL:         optUrl('https://api.elevenlabs.io'),
  ELEVENLABS_API_KEY:          optStr,

  // ── Channels — Microsoft Teams adapter (optional) ────────────────────────
  // One Kortix-owned multi-tenant Azure AD bot app. The same app id/password
  // serve every tenant; the per-conversation tenant id arrives on each inbound
  // activity. Outbound auth is a short-lived AAD token minted per scope at call
  // time (channels/teams-auth.ts) — there is no static bot token to store.
  MICROSOFT_APP_ID:            optStr,
  MICROSOFT_APP_PASSWORD:      optStr,
  // The bot's home tenant. Multi-tenant bots authenticate against the shared
  // `botframework.com` tenant; single-tenant deployments set their own.
  MICROSOFT_APP_TENANT:        optStrDefault('botframework.com'),
  // OpenID metadata used to validate the signed JWT on every inbound activity
  // (the Teams analog of Slack signature verification).
  MICROSOFT_BOT_OPENID_METADATA: optUrl('https://login.botframework.com/v1/.well-known/openidconfiguration'),
  TEAMS_REQUIRE_USER_IDENTITY: optBoolTrue,
  TEAMS_CHANNEL_ENABLED: optBoolFalse,
  TEAMS_APP_NAME: optStrDefault('Kortix'),

  // ── LLM Providers (optional — only needed in cloud mode) ─────────────────
  OPENROUTER_API_URL:          optUrl('https://openrouter.ai/api/v1'),
  // Single OpenRouter key for BOTH the router (/v1/router) and the managed LLM
  // gateway (/v1/llm). The gateway used to read a separate KORTIX_OPENROUTER_API_KEY
  // — consolidated onto this one var.
  OPENROUTER_API_KEY:          optStr,
  // Managed LLM gateway (/v1/llm) — the `kortix` OpenCode provider routes every
  // sandbox model call here. Off by default; needs OPENROUTER_API_KEY when on.
  LLM_GATEWAY_ENABLED:         optBoolFalse,
  // CLOUD-ONLY. Whether KORTIX's own managed model lineup (Claude/GLM/Qwen/
  // DeepSeek/…, routed through Kortix's SHARED Bedrock/OpenRouter credentials
  // and billed as platform credits — "Managed · Included with your plan" in
  // the picker) exists at all on this deployment. Independent of
  // LLM_GATEWAY_ENABLED above: a self-host still runs the gateway for its own
  // BYOK routing (every sandbox model call goes through `/v1/llm`), it just
  // must never see or route to Kortix's shared credentials. Off by default;
  // Kortix Cloud sets this true in its own env. See RUNTIME_MANAGED_MODELS
  // (managed-models.ts) and managedCandidates() (descriptors.ts) — both are
  // gated on this and read NEITHER AWS_BEDROCK_API_KEY NOR OPENROUTER_API_KEY
  // for managed routing when it's off.
  KORTIX_MANAGED_PROVIDER_ENABLED: optBoolFalse,
  // Fleet default for projects with no explicit per-project override. Defaults
  // ON: wherever the gateway is available (master switch above), the managed
  // gateway is the default routing mechanism and every project inherits it
  // unless it explicitly opts out. The master switch still wins —
  // LLM_GATEWAY_ENABLED=false forces native OpenCode for everyone regardless of
  // this value — and an operator can set LLM_GATEWAY_DEFAULT_ENABLED=false to
  // opt a whole environment back to native-by-default.
  LLM_GATEWAY_DEFAULT_ENABLED: optBoolTrue,
  // Empty = the in-API gateway at `${KORTIX_URL}/v1/llm`. Set to a standalone
  // gateway's public base (…/v1/llm) to route every sandbox model call there.
  LLM_GATEWAY_BASE_URL:        optStr,
  // Runtime routing is control-plane configuration, not a model-catalog
  // constant baked into the gateway binary. Operators can replace the default
  // and define any number of exact-match fallback policies without code changes.
  LLM_GATEWAY_DEFAULT_MODEL:   optStrDefault('codex/gpt-5.6-sol'),
  LLM_GATEWAY_VISION_MODEL:    optStrDefault('claude-sonnet-4.6'),
  LLM_GATEWAY_FALLBACK_POLICIES: optFallbackPolicies,
  // Optional JSON array replacing the platform managed-model overlay (transport,
  // upstream id, pricing ref, capabilities). Empty uses the bundled last-known
  // defaults; managed routes are otherwise fully operator-defined.
  LLM_GATEWAY_MANAGED_MODELS: optStr,
  // Runtime source for provider/model metadata. The API keeps the last known
  // snapshot if this source is temporarily unavailable.
  LLM_GATEWAY_CATALOG_URL:     optUrl('https://models.dev/api.json'),
  // BYOK resilience: when a user's own provider key hits a rate-limit / quota /
  // billing error (429/402/403), fall over to THIS managed model (billed as
  // Kortix credits) so the turn survives instead of erroring. Empty disables.
  LLM_GATEWAY_BYOK_FALLBACK_MODEL: optStrDefault('claude-sonnet-4.6'),
  // Dev: reverse-proxy /v1/llm-gateway/* to a standalone gateway on this port,
  // so sandboxes reach it through the API's own tunnel (no separate tunnel).
  LLM_GATEWAY_PROXY_PORT:      optInt(0),
  // Where the /v1/llm-gateway/* reverse-proxy forwards. Defaults to
  // 127.0.0.1:LLM_GATEWAY_PROXY_PORT (local, gateway same host). In K8s set to
  // the in-cluster gateway service, e.g. http://kortix-gateway:8090, so the
  // gateway stays internal and sandboxes reach it via the API's public origin.
  LLM_GATEWAY_PROXY_TARGET:    optStr,
  // AWS Bedrock — the managed ("Kortix") models route here via a Bedrock API key
  // (bearer). Region selects the bedrock-runtime endpoint; the key is an IAM
  // service-specific credential for bedrock.amazonaws.com.
  AWS_BEDROCK_REGION:          optStr,
  AWS_BEDROCK_API_KEY:         optStr,
  ANTHROPIC_API_URL:           optUrl('https://api.anthropic.com/v1'),
  ANTHROPIC_API_KEY:           optStr,
  OPENAI_API_URL:              optUrl('https://api.openai.com/v1'),
  OPENAI_API_KEY:              optStr,
  // xAI / Gemini / Groq route through OpenRouter (see router/config/proxy-services.ts),
  // so only their base URLs are read — no per-provider API keys.
  XAI_API_URL:                 optUrl('https://api.x.ai/v1'),
  GEMINI_API_URL:              optUrl('https://generativelanguage.googleapis.com/v1beta'),
  GROQ_API_URL:                optUrl('https://api.groq.com/openai/v1'),
  // ── Billing — Stripe (optional, only for cloud billing) ──────────────────
  STRIPE_SECRET_KEY:           optStr,
  STRIPE_WEBHOOK_SECRET:       optStr,

  // ── Billing — RevenueCat (optional) ──────────────────────────────────────
  REVENUECAT_WEBHOOK_SECRET:   optStr,

  // ── Daytona — Sandbox provisioning (conditional: required if daytona provider enabled) ──
  // Note: there is intentionally no DAYTONA_SNAPSHOT here. Every sandbox
  // boots from a per-project snapshot built by the snapshot builder
  // (apps/api/src/snapshots/builder.ts). A shared/global fallback image
  // would silently bypass per-project Dockerfiles and is explicitly
  // disallowed.
  DAYTONA_API_KEY:             optStr,
  DAYTONA_SERVER_URL:          optStr,
  DAYTONA_TARGET:              optStr,
  // Org-level Daytona webhook signing secret (Svix `whsec_…`). When set, the
  // /v1/billing/webhooks/daytona endpoint closes compute billing the instant a
  // box stops; the reaper sweep is the backstop, so this is optional.
  DAYTONA_WEBHOOK_SECRET:      optStr,

  // When a template's content hash changes and a fresh snapshot is built, drop
  // the now-superseded predecessor immediately (reap-on-repoint) instead of
  // leaving it for the lazy, pressure-gated quota GC. Keeps steady state at ~1
  // snapshot per lineage so the org-wide 100-snapshot quota can't fill with
  // stale builds (dev auto-deploys churn the default ~20×/day). Best-effort;
  // only deletes managed (kortix-default-/tpl-/wproj-) names that no other
  // template row still references. On by default; boot auto-heal covers the rare
  // cross-env race where another env's row pointed at the reaped (identical) name.
  KORTIX_SNAPSHOT_REAP_PREDECESSOR: optBoolTrue,

  // ── Platinum — Sandbox provisioning (conditional: required if platinum provider enabled) ──
  // Platinum is our own Cloud Hypervisor microVM API. PLATINUM_API_KEY is a
  // pt_live_… key; PLATINUM_API_URL is the control-plane base
  // (https://api.platinum.dev). PLATINUM_TEMPLATE is a ready Platinum template
  // id to boot sessions from (e.g. kortix-computer) — used as the fallback when
  // a session hasn't built its own per-project Platinum template.
  PLATINUM_API_KEY:            optStr,
  PLATINUM_API_URL:            optStr,
  PLATINUM_TEMPLATE:           optStr,
  // Per-webhook HMAC-SHA-256 secret from Platinum's `POST /v1/webhooks` (shown
  // once at registration). Optional — same backstop story as Daytona's.
  PLATINUM_WEBHOOK_SECRET:     optStr,

  // ── E2B Cloud — sandbox provisioning (conditional: required if enabled) ──
  // E2B_TEMPLATE is an optional ready fallback template. Project-specific
  // templates built by the shared snapshot system take precedence.
  E2B_API_KEY:                 optStr,
  E2B_TEMPLATE:                optStr,

  // ── Sandbox Platform ──────────────────────────────────────────────────────
  // Public API base URL, without a route suffix. Auto-derived from PORT in local mode.
  KORTIX_URL:                  optStr,
  ALLOWED_SANDBOX_PROVIDERS:   optStrDefault('daytona'),
  SANDBOX_IMAGE:               optStr,
  KORTIX_LOCAL_IMAGES:         optBoolFalse,
  SANDBOX_NETWORK:             optStr,

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
  KORTIX_SANDBOX_AUTOSTOP_MINUTES:    optInt(15),
  KORTIX_SANDBOX_TRIGGER_AUTOSTOP_MINUTES: optInt(5),
  KORTIX_SANDBOX_AUTOARCHIVE_MINUTES: optInt(720),    // 12 hours
  KORTIX_SANDBOX_AUTODELETE_MINUTES:  optInt(-1),     // never auto-delete

  // ── Internal Service Key (auto-generated if missing — never fails) ───────
  INTERNAL_SERVICE_KEY:        optStr,

  // ── Frontend (optional) ──────────────────────────────────────────────────
  FRONTEND_URL:                optUrl('http://localhost:3000'),

  // ── Pipedream Connect (optional — powers the Executor's 1-click connectors) ─
  PIPEDREAM_CLIENT_ID:         optStr,
  PIPEDREAM_CLIENT_SECRET:     optStr,
  PIPEDREAM_PROJECT_ID:        optStr,
  PIPEDREAM_ENVIRONMENT:       optStrDefault('production'),
  PIPEDREAM_WEBHOOK_SECRET:    optStr,

  // ── Tunnel (optional, all have sane defaults) ────────────────────────────
  TUNNEL_SIGNING_SECRET:             optStr,
  TUNNEL_ENABLED:                    optBoolTrue,
  TUNNEL_HEARTBEAT_INTERVAL_MS:      optInt(30_000),
  TUNNEL_HEARTBEAT_MAX_MISSED:       optInt(3),
  TUNNEL_RPC_TIMEOUT_MS:             optInt(30_000),
  TUNNEL_RATE_LIMIT_RPC:             optInt(100),
  TUNNEL_RATE_LIMIT_PERM_REQUEST:    optInt(20),
  TUNNEL_RATE_LIMIT_WS_CONNECT:      optInt(5),
  TUNNEL_RATE_LIMIT_PERM_GRANT:      optInt(30),
  TUNNEL_MAX_WS_MESSAGE_SIZE:        optInt(5 * 1024 * 1024),

  // ── Abuse controls (optional, all have sane defaults) ────────────────────
  KORTIX_INVITE_ACCEPT_REQS_PER_MIN:      optInt(20),
  KORTIX_PUBLIC_SESSION_SHARE_REQS_PER_MIN: optInt(60),
  KORTIX_DEMO_REQUEST_REQS_PER_MIN:       optInt(10),
  KORTIX_LLM_ROUTER_REQS_PER_MIN_FREE:    optInt(60),
  KORTIX_LLM_ROUTER_REQS_PER_MIN_PAID:    optInt(600),
  KORTIX_PROXY_REQS_PER_MIN:              optInt(600),
  KORTIX_TRIGGER_MAX_PROVISIONING_SESSIONS_PER_PROJECT: optInt(3),
  KORTIX_TRIGGER_SCHEDULER_ENABLED:        optBoolTrue,
  KORTIX_TRIGGER_SCHEDULER_INTERVAL_MS:    optInt(60_000),

  // ── Version / GitHub (optional) ───────────────────────────────────────────
  SANDBOX_VERSION:             optStr,  // dev override: skip npm registry lookup for latest version
  GITHUB_TOKEN:                optStr,  // optional: authenticated GitHub API calls for changelog

  // ── Mailtrap (optional — provisioning email notifications) ────────────────
  MAILTRAP_API_TOKEN:          optStr,
  MAILTRAP_FROM_EMAIL:         optStrDefault('noreply@kortix.com'),
  MAILTRAP_FROM_NAME:          optStrDefault('Kortix'),
  // Where public demo-request / "book a demo" lead notifications are sent.
  // Comma-separated list; every address gets every submission.
  DEMO_LEAD_NOTIFY_EMAIL:      optStrDefault('marko@kortix.ai,hey@kortix.ai'),
  // Sender for those notifications. kortix.ai (not the global MAILTRAP_FROM_
  // EMAIL on kortix.com) so the send is DKIM-aligned with the kortix.ai
  // recipient inboxes — the kortix.com sender was landing in spam.
  DEMO_LEAD_FROM_EMAIL:        optStrDefault('hi@kortix.ai'),

  // ── Mailtrap contact sync (signup → automation lists) ─────────────────────
  // The email automations themselves live in Mailtrap's Automations UI; the
  // API only registers each new signup as a contact. Sync is active iff
  // MAILTRAP_API_TOKEN + MAILTRAP_ACCOUNT_ID are both set.
  MAILTRAP_ACCOUNT_ID:               optStr,
  // Contact list every signup joins (automation trigger: "added to list").
  MAILTRAP_SIGNUPS_LIST_ID:          optStr,
  // Additional list for work-email signups (founder "book a call" flow).
  MAILTRAP_BUSINESS_SIGNUPS_LIST_ID: optStr,

  // ── Better Stack Observability (optional — graceful degradation) ────────
  BETTERSTACK_API_LOG_TOKEN:   optStr,  // Logtail source token for structured logs
  BETTERSTACK_API_LOG_HOST:    optStr,  // Logtail ingesting host (e.g. s1234.us-east-9.betterstackdata.com)
  BETTERSTACK_API_SENTRY_DSN:  optStr,  // Sentry DSN for error tracking (Better Stack compatible)

  // ── Stray env vars used directly in other files (centralized here) ───────
  CORS_ALLOWED_ORIGINS:        optStr,
  KORTIX_MASTER_URL:           optStr,
  OPENCODE_URL:                optStr,
  KORTIX_DATA_DIR:             optStr,
});

// ─── Validation + Conditional Checks ────────────────────────────────────────

type EnvIssue = { var: string; message: string; level: 'error' | 'warn' };

// Recognised provider names. Source-of-truth for what can legally appear in
// ALLOWED_SANDBOX_PROVIDERS — adding a new provider is a one-place change
// here plus a case in `getProvider()` in platform/providers/index.ts.
const KNOWN_PROVIDERS: readonly SandboxProviderName[] = ['daytona', 'platinum', 'e2b'] as const;

/** Parse comma-separated provider list (e.g. "daytona,platinum"). */
function parseAllowedProviders(raw: string): SandboxProviderName[] {
  if (!raw) return ['daytona'];
  const names = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const valid: SandboxProviderName[] = [];
  for (const n of names) {
    if ((KNOWN_PROVIDERS as readonly string[]).includes(n)) {
      const known = n as SandboxProviderName;
      if (!valid.includes(known)) valid.push(known);
    } else {
      console.warn(`[config] Unknown sandbox provider "${n}" in ALLOWED_SANDBOX_PROVIDERS - ignored`);
    }
  }
  return valid.length > 0 ? valid : ['daytona'];
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

  // ── Conditional: Daytona provider enabled → need Daytona keys ──────────
  const providers = parseAllowedProviders((raw as any).ALLOWED_SANDBOX_PROVIDERS || '');
  if (providers.includes('daytona')) {
    if (!raw.DAYTONA_API_KEY)    issues.push({ var: 'DAYTONA_API_KEY',    message: 'Required when ALLOWED_SANDBOX_PROVIDERS includes "daytona"', level: 'error' });
    if (!raw.DAYTONA_SERVER_URL) issues.push({ var: 'DAYTONA_SERVER_URL', message: 'Required when ALLOWED_SANDBOX_PROVIDERS includes "daytona"', level: 'error' });
    if (!raw.DAYTONA_TARGET)     issues.push({ var: 'DAYTONA_TARGET',     message: 'Required when ALLOWED_SANDBOX_PROVIDERS includes "daytona"', level: 'error' });
  }
  if (providers.includes('platinum')) {
    if (!raw.PLATINUM_API_KEY) issues.push({ var: 'PLATINUM_API_KEY', message: 'Required when ALLOWED_SANDBOX_PROVIDERS includes "platinum"', level: 'error' });
    if (!raw.PLATINUM_API_URL) issues.push({ var: 'PLATINUM_API_URL', message: 'Required when ALLOWED_SANDBOX_PROVIDERS includes "platinum"', level: 'error' });
  }
  if (providers.includes('e2b') && !raw.E2B_API_KEY) {
    issues.push({ var: 'E2B_API_KEY', message: 'Required when ALLOWED_SANDBOX_PROVIDERS includes "e2b"', level: 'error' });
  }

  // ── Conditional: Billing enabled → need Stripe keys ────────────────────
  const billingWillBeEnabled = (raw as any).KORTIX_BILLING_INTERNAL_ENABLED === 'true' || (raw as any).KORTIX_BILLING_INTERNAL_ENABLED === true;
  if (billingWillBeEnabled) {
    if (!raw.STRIPE_SECRET_KEY)    issues.push({ var: 'STRIPE_SECRET_KEY',    message: 'Required when KORTIX_BILLING_INTERNAL_ENABLED=true', level: 'error' });
    if (!raw.STRIPE_WEBHOOK_SECRET) issues.push({ var: 'STRIPE_WEBHOOK_SECRET', message: 'Required when KORTIX_BILLING_INTERNAL_ENABLED=true', level: 'error' });
  }

  // ── Conditional: Tunnel enabled → need signing secret ──────────────────
  const tunnelEnabled = (raw as any).TUNNEL_ENABLED !== 'false' && (raw as any).TUNNEL_ENABLED !== false;
  if (tunnelEnabled && !raw.TUNNEL_SIGNING_SECRET) {
    issues.push({ var: 'TUNNEL_SIGNING_SECRET', message: 'Required when tunnel is enabled — used for HMAC signing key derivation', level: 'error' });
  }

  // ── Conditional: KORTIX_URL — required for sandbox routing ──────────────
  // Auto-derive from PORT for self-host/dev — fatal when billing is enabled
  // (you can't bill against an unreachable origin).
  if (!raw.KORTIX_URL) {
    const port = (raw as any).PORT || '8008';
    if (billingWillBeEnabled) {
      issues.push({ var: 'KORTIX_URL', message: 'Required when KORTIX_BILLING_INTERNAL_ENABLED=true — sandbox routing and health checks will break', level: 'error' });
    } else {
      // Auto-derive so dev/self-host "just works". KORTIX_URL is the public
      // API origin/base; individual callers append /v1, /v1/router, etc.
      const derived = `http://localhost:${port}`;
      process.env.KORTIX_URL = derived;
      if (result.success) (result.data as any).KORTIX_URL = derived;
      console.warn(`[config] KORTIX_URL not set — auto-derived: ${derived}`);
      issues.push({ var: 'KORTIX_URL', message: `Not set — auto-derived to ${derived} (add to .env to silence this)`, level: 'warn' });
    }
  }

  // ── Warnings (non-fatal but worth knowing) ─────────────────────────────
  if (!raw.OPENROUTER_API_KEY) {
    issues.push({ var: 'OPENROUTER_API_KEY', message: 'Not set — primary LLM route will fail with silent 401 errors', level: 'warn' });
    if (raw.LLM_GATEWAY_ENABLED === 'true') {
      issues.push({ var: 'LLM_GATEWAY_ENABLED', message: 'Gateway is on but OPENROUTER_API_KEY is unset — /v1/llm will 500 "openrouterApiKey missing"', level: 'warn' });
    }
  }

  if (raw.MEET_ENABLED === 'true' && !raw.RECALL_API_KEY) {
    issues.push({ var: 'RECALL_API_KEY', message: 'MEET_ENABLED is on but RECALL_API_KEY is unset — the meeting bot cannot join or transcribe', level: 'warn' });
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
    console.error('\x1b[31m  kortix-api: Environment validation FAILED — server cannot start\x1b[0m');
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

  console.log(`[config] Environment validated (${Object.keys(envSchema.shape).length} vars, ${warnings.length} warnings)`);
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
  // Single master switch — see schema docstring above.
  KORTIX_BILLING_INTERNAL_ENABLED: env.KORTIX_BILLING_INTERNAL_ENABLED,
  KORTIX_TEMPLATES_ENABLED: env.KORTIX_TEMPLATES_ENABLED,
  ENTERPRISE_LICENSE_AVAILABLE: env.ENTERPRISE_LICENSE_AVAILABLE,

  // ─── Database ──────────────────────────────────────────────────────────────
  DATABASE_URL: env.DATABASE_URL,

  // ─── Supabase ──────────────────────────────────────────────────────────────
  SUPABASE_URL: env.SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY,

  // ─── API Key Hashing ──────────────────────────────────────────────────────
  API_KEY_SECRET: env.API_KEY_SECRET,

  // ─── Pipedream Connect (Executor 1-click connectors) ──────────────────────
  PIPEDREAM_CLIENT_ID: env.PIPEDREAM_CLIENT_ID,
  PIPEDREAM_CLIENT_SECRET: env.PIPEDREAM_CLIENT_SECRET,
  PIPEDREAM_PROJECT_ID: env.PIPEDREAM_PROJECT_ID,
  PIPEDREAM_ENVIRONMENT: env.PIPEDREAM_ENVIRONMENT,
  PIPEDREAM_WEBHOOK_SECRET: env.PIPEDREAM_WEBHOOK_SECRET,

  // ─── Search Providers ──────────────────────────────────────────────────────
  TAVILY_API_URL: env.TAVILY_API_URL,
  TAVILY_API_KEY: env.TAVILY_API_KEY,
  SERPER_API_URL: env.SERPER_API_URL,
  SERPER_API_KEY: env.SERPER_API_KEY,
  APIFY_API_URL: env.APIFY_API_URL,
  APIFY_TOKEN: env.APIFY_TOKEN,

  // ─── Proxy Providers ──────────────────────────────────────────────────────
  FIRECRAWL_API_URL: env.FIRECRAWL_API_URL,
  FIRECRAWL_API_KEY: env.FIRECRAWL_API_KEY,
  REPLICATE_API_URL: env.REPLICATE_API_URL,
  REPLICATE_API_TOKEN: env.REPLICATE_API_TOKEN,
  CONTEXT7_API_URL: env.CONTEXT7_API_URL,
  CONTEXT7_API_KEY: env.CONTEXT7_API_KEY,

  // ─── Managed git ──────────────────────────────────────────────────────────
  MANAGED_GIT_PROVIDER: env.MANAGED_GIT_PROVIDER,
  MANAGED_GIT_GITHUB_OWNER: env.MANAGED_GIT_GITHUB_OWNER,
  MANAGED_GIT_GITHUB_INSTALL_ID: env.MANAGED_GIT_GITHUB_INSTALL_ID,
  MANAGED_GIT_GITHUB_TOKEN: env.MANAGED_GIT_GITHUB_TOKEN,
  KORTIX_GIT_PROXY: env.KORTIX_GIT_PROXY,
  KORTIX_PRERESUME_ENABLED: env.KORTIX_PRERESUME_ENABLED,
  KORTIX_PRERESUME_MAX_PER_PROJECT: env.KORTIX_PRERESUME_MAX_PER_PROJECT,
  KORTIX_ENFORCE_SESSION_AGENT_LOCK: env.KORTIX_ENFORCE_SESSION_AGENT_LOCK,
  KORTIX_REQUIRE_DECLARED_AGENTS: env.KORTIX_REQUIRE_DECLARED_AGENTS,

  // ─── Legacy migration ─────────────────────────────────────────────────────
  LEGACY_MIGRATION_BACKUP_BUCKET: env.LEGACY_MIGRATION_BACKUP_BUCKET,

  // ─── Channels (Slack) ─────────────────────────────────────────────────────
  SLACK_BOT_TOKEN: env.SLACK_BOT_TOKEN,
  SLACK_SIGNING_SECRET: env.SLACK_SIGNING_SECRET,
  SLACK_TEAM_ID: env.SLACK_TEAM_ID,
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

  // ─── Channels (Recall.ai meeting bot) ────────────────────────────────────
  MEET_ENABLED: env.MEET_ENABLED,
  RECALL_BASE_URL: env.RECALL_BASE_URL,
  RECALL_API_KEY: env.RECALL_API_KEY,
  ELEVENLABS_BASE_URL: env.ELEVENLABS_BASE_URL,
  ELEVENLABS_API_KEY: env.ELEVENLABS_API_KEY,

  // ─── Channels (Microsoft Teams) ───────────────────────────────────────────
  MICROSOFT_APP_ID: env.MICROSOFT_APP_ID,
  MICROSOFT_APP_PASSWORD: env.MICROSOFT_APP_PASSWORD,
  MICROSOFT_APP_TENANT: env.MICROSOFT_APP_TENANT,
  MICROSOFT_BOT_OPENID_METADATA: env.MICROSOFT_BOT_OPENID_METADATA,
  TEAMS_REQUIRE_USER_IDENTITY: env.TEAMS_REQUIRE_USER_IDENTITY,
  TEAMS_CHANNEL_ENABLED: env.TEAMS_CHANNEL_ENABLED,
  TEAMS_APP_NAME: env.TEAMS_APP_NAME,

  // ─── LLM Providers ────────────────────────────────────────────────────────
  OPENROUTER_API_URL: env.OPENROUTER_API_URL,
  OPENROUTER_API_KEY: env.OPENROUTER_API_KEY,
  LLM_GATEWAY_ENABLED: env.LLM_GATEWAY_ENABLED,
  KORTIX_MANAGED_PROVIDER_ENABLED: env.KORTIX_MANAGED_PROVIDER_ENABLED,
  LLM_GATEWAY_DEFAULT_ENABLED: env.LLM_GATEWAY_DEFAULT_ENABLED,
  LLM_GATEWAY_BASE_URL: env.LLM_GATEWAY_BASE_URL,
  LLM_GATEWAY_DEFAULT_MODEL: env.LLM_GATEWAY_DEFAULT_MODEL,
  LLM_GATEWAY_VISION_MODEL: env.LLM_GATEWAY_VISION_MODEL,
  LLM_GATEWAY_FALLBACK_POLICIES: env.LLM_GATEWAY_FALLBACK_POLICIES,
  LLM_GATEWAY_MANAGED_MODELS: env.LLM_GATEWAY_MANAGED_MODELS,
  LLM_GATEWAY_CATALOG_URL: env.LLM_GATEWAY_CATALOG_URL,
  LLM_GATEWAY_BYOK_FALLBACK_MODEL: env.LLM_GATEWAY_BYOK_FALLBACK_MODEL,
  LLM_GATEWAY_PROXY_PORT: env.LLM_GATEWAY_PROXY_PORT,
  LLM_GATEWAY_PROXY_TARGET: env.LLM_GATEWAY_PROXY_TARGET,
  AWS_BEDROCK_REGION: env.AWS_BEDROCK_REGION,
  AWS_BEDROCK_API_KEY: env.AWS_BEDROCK_API_KEY,
  ANTHROPIC_API_URL: env.ANTHROPIC_API_URL,
  ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
  OPENAI_API_URL: env.OPENAI_API_URL,
  OPENAI_API_KEY: env.OPENAI_API_KEY,
  XAI_API_URL: env.XAI_API_URL,
  GEMINI_API_URL: env.GEMINI_API_URL,
  GROQ_API_URL: env.GROQ_API_URL,
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

  // Sandbox lifecycle intervals (minutes) — see schema comment above.
  KORTIX_SANDBOX_AUTOSTOP_MINUTES: env.KORTIX_SANDBOX_AUTOSTOP_MINUTES,
  KORTIX_SANDBOX_TRIGGER_AUTOSTOP_MINUTES: env.KORTIX_SANDBOX_TRIGGER_AUTOSTOP_MINUTES,
  KORTIX_SANDBOX_AUTOARCHIVE_MINUTES: env.KORTIX_SANDBOX_AUTOARCHIVE_MINUTES,
  KORTIX_SANDBOX_AUTODELETE_MINUTES: env.KORTIX_SANDBOX_AUTODELETE_MINUTES,

  PLATINUM_API_KEY: env.PLATINUM_API_KEY,
  PLATINUM_API_URL: env.PLATINUM_API_URL,
  PLATINUM_TEMPLATE: env.PLATINUM_TEMPLATE,
  PLATINUM_WEBHOOK_SECRET: env.PLATINUM_WEBHOOK_SECRET,
  E2B_API_KEY: env.E2B_API_KEY,
  E2B_TEMPLATE: env.E2B_TEMPLATE,

  // ─── Sandbox Provisioning (Platform) ──────────────────────────────────────
  KORTIX_URL: env.KORTIX_URL,
  ALLOWED_SANDBOX_PROVIDERS: allowedProviders,
  SANDBOX_IMAGE: env.SANDBOX_IMAGE || 'kortix/kortix-sandbox:latest',
  KORTIX_LOCAL_IMAGES: env.KORTIX_LOCAL_IMAGES,
  SANDBOX_NETWORK: env.SANDBOX_NETWORK,

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
          resolve(__dirname, '../../.env'),       // from src/config.ts -> ../../.env
          resolve(process.cwd(), '.env'),          // cwd/.env
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
            appendFileSync(envPath, `\n# Auto-generated service key for sandbox auth (do not remove)\nINTERNAL_SERVICE_KEY=${generated}\n`);
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
  KORTIX_PUBLIC_SESSION_SHARE_REQS_PER_MIN: env.KORTIX_PUBLIC_SESSION_SHARE_REQS_PER_MIN,
  KORTIX_DEMO_REQUEST_REQS_PER_MIN: env.KORTIX_DEMO_REQUEST_REQS_PER_MIN,
  KORTIX_LLM_ROUTER_REQS_PER_MIN_FREE: env.KORTIX_LLM_ROUTER_REQS_PER_MIN_FREE,
  KORTIX_LLM_ROUTER_REQS_PER_MIN_PAID: env.KORTIX_LLM_ROUTER_REQS_PER_MIN_PAID,
  KORTIX_PROXY_REQS_PER_MIN: env.KORTIX_PROXY_REQS_PER_MIN,
  KORTIX_TRIGGER_MAX_PROVISIONING_SESSIONS_PER_PROJECT: env.KORTIX_TRIGGER_MAX_PROVISIONING_SESSIONS_PER_PROJECT,
  KORTIX_TRIGGER_SCHEDULER_ENABLED: env.KORTIX_TRIGGER_SCHEDULER_ENABLED,
  KORTIX_TRIGGER_SCHEDULER_INTERVAL_MS: env.KORTIX_TRIGGER_SCHEDULER_INTERVAL_MS,

  // ─── Version / GitHub ──────────────────────────────────────────────────────
  /** Dev override: force a specific sandbox version via env var. */
  SANDBOX_VERSION_OVERRIDE: env.SANDBOX_VERSION,
  GITHUB_TOKEN: env.GITHUB_TOKEN,

  // ─── Mailtrap (Email Notifications) ────────────────────────────────────────
  MAILTRAP_API_TOKEN: env.MAILTRAP_API_TOKEN,
  MAILTRAP_FROM_EMAIL: env.MAILTRAP_FROM_EMAIL,
  MAILTRAP_FROM_NAME: env.MAILTRAP_FROM_NAME,
  DEMO_LEAD_NOTIFY_EMAIL: env.DEMO_LEAD_NOTIFY_EMAIL,
  DEMO_LEAD_FROM_EMAIL: env.DEMO_LEAD_FROM_EMAIL,

  // ─── Mailtrap contact sync (signup → automation lists) ────────────────────
  MAILTRAP_ACCOUNT_ID: env.MAILTRAP_ACCOUNT_ID,
  MAILTRAP_SIGNUPS_LIST_ID: env.MAILTRAP_SIGNUPS_LIST_ID,
  MAILTRAP_BUSINESS_SIGNUPS_LIST_ID: env.MAILTRAP_BUSINESS_SIGNUPS_LIST_ID,

  // ─── Stray env vars (centralized from other files) ────────────────────────
  CORS_ALLOWED_ORIGINS: env.CORS_ALLOWED_ORIGINS,
  KORTIX_MASTER_URL: env.KORTIX_MASTER_URL,
  OPENCODE_URL: env.OPENCODE_URL,
  KORTIX_DATA_DIR: env.KORTIX_DATA_DIR,

  // ─── Helper Methods ────────────────────────────────────────────────────────

  isProviderEnabled(name: SandboxProviderName): boolean {
    if (!this.ALLOWED_SANDBOX_PROVIDERS.includes(name)) return false;
    switch (name) {
      case 'daytona': return !!this.DAYTONA_API_KEY;
      case 'platinum': return !!this.PLATINUM_API_KEY;
      case 'e2b': return !!this.E2B_API_KEY;
      default: {
        const exhaustive: never = name;
        return exhaustive;
      }
    }
  },

  /**
   * Default sandbox provider for new sessions. First entry of
   * ALLOWED_SANDBOX_PROVIDERS, with 'daytona' as the safety belt for an
   * empty list. The ordering is the automatic-selection preference; callers
   * that explicitly choose a provider bypass that preference.
   */
  getDefaultProvider(): SandboxProviderName {
    return this.ALLOWED_SANDBOX_PROVIDERS[0] ?? 'daytona';
  },

  isDaytonaEnabled(): boolean {
    return this.ALLOWED_SANDBOX_PROVIDERS.includes('daytona') && !!this.DAYTONA_API_KEY;
  },

  isPlatinumEnabled(): boolean {
    return this.ALLOWED_SANDBOX_PROVIDERS.includes('platinum') && !!this.PLATINUM_API_KEY;
  },

  isE2BEnabled(): boolean {
    return this.ALLOWED_SANDBOX_PROVIDERS.includes('e2b') && !!this.E2B_API_KEY;
  },

};

// ─── Billing Markup Constants ────────────────────────────────────────────────
//
// Two pricing modes based on whose API key is used:
//   * Kortix keys (user uses our keys):  1.2x provider cost (20% markup)
//   * User's own keys (passthrough):     0.1x provider cost (10% platform fee)

/** Markup when Kortix provides the API key. */
export const KORTIX_MARKUP = 1.2;

/** Platform fee when user provides their own API key. */
export const PLATFORM_FEE_MARKUP = 0.1;

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
  // Apify LinkedIn people-search actor (harvestapi short mode): $0.10 per search
  // page of up to 25 results. Page-priced (not per-result), so a flat per-call
  // cost; with markup the user is charged ~$0.15 per people_search call.
  proxy_apify: {
    baseCost: 0.1,
    perResultCost: 0,
    markupMultiplier: 1.5,
  },
  proxy_firecrawl: {
    baseCost: 0.01,
    perResultCost: 0,
    markupMultiplier: 1.5,
  },
  proxy_replicate: {
    baseCost: 0.005,
    perResultCost: 0,
    markupMultiplier: 1.5,
  },
  proxy_replicate_nano_banana: {
    baseCost: 0.01,
    perResultCost: 0,
    markupMultiplier: 1.5,
  },
  proxy_replicate_gpt_image: {
    baseCost: 0.05,
    perResultCost: 0,
    markupMultiplier: 1.5,
  },
  // Moondream2 vision captioning (image_search enrichment) — cheap per-call model.
  proxy_replicate_moondream: {
    baseCost: 0.002,
    perResultCost: 0,
    markupMultiplier: 1.5,
  },
  // Polling a created prediction's status — billed at zero (the create call already paid).
  proxy_replicate_poll: {
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

export function getToolCost(toolName: string, resultCount: number = 0): number {
  const pricing = TOOL_PRICING[toolName];
  if (!pricing) {
    return 0.01;
  }

  const base = pricing.baseCost * pricing.markupMultiplier;
  const perResult = pricing.perResultCost * pricing.markupMultiplier * resultCount;
  return base + perResult;
}
