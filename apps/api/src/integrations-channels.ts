import { optStr, optStrDefault, optUrl, optBoolTrue, optBoolFalse } from "./env-schema-helpers";
import { SLACK_BOT_SCOPES } from "./channels/slack-manifest";
export const integrations_channelsSchema = {
  TAVILY_API_URL: optUrl('https://api.tavily.com'),
  TAVILY_API_KEY: optStr,
  SERPER_API_URL: optUrl('https://google.serper.dev'),
  SERPER_API_KEY: optStr,
  FIRECRAWL_API_URL: optUrl('https://api.firecrawl.dev'),
  FIRECRAWL_API_KEY: optStr,
  CONTEXT7_API_URL: optUrl('https://context7.com'),
  CONTEXT7_API_KEY: optStr,
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
  AGENTMAIL_API_URL: optUrl('https://api.agentmail.to/v0'),
  AGENTMAIL_API_KEY: optStr,
  AGENTMAIL_WEBHOOK_SECRET: optStr,
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

};
