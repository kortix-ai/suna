import { z } from "zod";
import { optStr, optStrDefault, optUrl, optInt, optBoolTrue } from "./env-schema-helpers";
export const platform_servicesSchema = {
  // Public API base URL, without a route suffix. Auto-derived from PORT in local mode.
  KORTIX_URL: optStr,
  ALLOWED_SANDBOX_PROVIDERS: optStrDefault('daytona'),
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
  INTERNAL_SERVICE_KEY: optStr,
  FRONTEND_URL: optUrl('http://localhost:3000'),
  PIPEDREAM_CLIENT_ID: optStr,
  PIPEDREAM_CLIENT_SECRET: optStr,
  PIPEDREAM_PROJECT_ID: optStr,
  PIPEDREAM_ENVIRONMENT: optStrDefault('production'),
  PIPEDREAM_WEBHOOK_SECRET: optStr,
  COMPOSIO_API_KEY: optStr,
  // Optional: required only when importing a public Postman workspace URL.
  // Exported collection JSON and Postman-managed Git repositories need no key.
  POSTMAN_API_KEY: optStr,
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
  SANDBOX_VERSION: optStr, // dev override: skip npm registry lookup for latest version
  GITHUB_TOKEN: optStr, // optional: authenticated GitHub API calls for changelog
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
  // The email automations themselves live in Mailtrap's Automations UI; the
  // API only registers each new signup as a contact. Sync is active iff
  // MAILTRAP_API_TOKEN + MAILTRAP_ACCOUNT_ID are both set.
  MAILTRAP_ACCOUNT_ID: optStr,
  // Contact list every signup joins (automation trigger: "added to list").
  MAILTRAP_SIGNUPS_LIST_ID: optStr,
  // Additional list for work-email signups (founder "book a call" flow).
  MAILTRAP_BUSINESS_SIGNUPS_LIST_ID: optStr,
};
