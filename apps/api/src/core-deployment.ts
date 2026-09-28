import { z } from "zod";
import { optStr, optInt, optBoolTrue, optBoolFalse } from "./env-schema-helpers";
export const core_deploymentSchema = {
  PORT: optInt(8008),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required — cannot start without a database'),
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
  // `direct` (default): the client PUTs each file once to a signed Storage URL.
  // `chunked`: the client PUTs bounded chunks through the API. Only for a
  // deployment whose public edge drops large request bodies (the PR preview).
  PROMPT_ATTACHMENT_UPLOAD_MODE: z.enum(['direct', 'chunked']).optional().default('direct'),
  // Bytes per chunk. Read only in `chunked` mode.
  PROMPT_ATTACHMENT_CHUNK_BYTES: optInt(65536).refine((bytes) => bytes > 0, {
    message: 'PROMPT_ATTACHMENT_CHUNK_BYTES must be a positive integer',
  }),
  API_KEY_SECRET: z.string().min(1, 'API_KEY_SECRET is required — API key hashing will fail'),
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

};
