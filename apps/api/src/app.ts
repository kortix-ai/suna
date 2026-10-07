import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { config } from './config';
import { auth, errors, json } from './openapi';
import { combinedAuth, supabaseAuth } from './middleware/auth';
import { getPlatformRole } from './shared/platform-roles';

// ─── Sub-Service Imports ────────────────────────────────────────────────────

import { accessControlApp } from './access-control';
import { accountsRouter } from './accounts';
import { accountInvitesRouter } from './accounts/invites';
import { adminApp } from './admin';
import { authRouter } from './auth';
import { headlessAuthRouter } from './auth/headless';
import { authEmailHookApp, registerSendEmailHookRoutes } from './auth/send-email-hook';
import { accountDeletionApp, billingApp } from './billing';
import { notificationsApp } from './notifications/routes';
import {
  emailWebhookApp,
  registerEmailWebhookRoutes,
  registerSlackWebhookRoutes,
  registerTeamsWebhookRoutes,
  slackIdentityApp,
  slackOauthApp,
  slackWebhookApp,
  teamsIdentityApp,
  teamsOauthApp,
  teamsWebhookApp,
  telegramWebhookApp,
} from './channels';
import { connectorApp } from './connectors';
import { nativeOAuth2CallbackApp } from './connectors/oauth2-callback';
import { edgeApp } from './edge/tls-check';
// STATIC, not `await import(...)`. See the note at the mount site: a top-level
// await anywhere above the last `app.route(...)` leaves the route table, the
// error handler and the 404 handler unregistered for any importer that observes
// `app` before it settles.
import { gitProxyApp } from './git-proxy';
import { mountLlmGateway } from './llm-gateway/wire';
import { marketplaceApp } from './marketplace';
import { createMcpApp } from './mcp';
import { oauthApp } from './oauth';
import { opsApp } from './ops';
import { platformApp } from './platform';
import { sandboxWebhooksApp } from './platform/webhooks/routes';
import { projectWebhooksApp, projectsApp, registerAllProjectRoutes } from './projects';
import { router } from './router';
import { runtimeAssetsApp } from './runtime-assets';
import { sandboxProxyApp } from './sandbox-proxy';
import { registerScimRoutes, scimRouter } from './scim';
import { setupApp } from './setup';
import { skillsApp } from './skills';
import { tunnelApp } from './tunnel';
import { installHttpMiddleware } from './http-middleware';
import { installHttpErrors } from './http-errors';
import { registerSystemRoutes } from './routes/system';
import { registerPlatformEndpoints } from './routes/platform-endpoints';
import { dispatchInProcess } from './inbound-dispatch';

// ─── App Setup ──────────────────────────────────────────────────────────────

const app = new OpenAPIHono();
// Exported so tooling/tests can introspect the route table (app.routes) without
// booting the server. See the import.meta.main guard around startup below.
export { app };

installHttpMiddleware(app);

registerSystemRoutes(app);

registerPlatformEndpoints(app);

// /v1/accounts/* — account & member management lives in ./accounts router.
app.route('/v1/accounts', accountsRouter);
// /v1/auth/* — auth-side server endpoints (logout for now). Audit
// events for login/logout/failed-login live in the auth middleware
// + this router so SOC2 reviews see the full auth lifecycle.
// Headless regular auth (signup / sign-in / magic link / social / refresh /
// reset) — public, mounted BEFORE the bearer-gated auth router on the same prefix.
app.route('/v1/auth', headlessAuthRouter);
app.route('/v1/auth', authRouter);
// SCIM 2.0 — separate auth (per-account bearer tokens, not Supabase JWT).
// Mounted outside /v1 so IdPs configure the documented protocol URL.
registerScimRoutes();
app.route('/scim/v2', scimRouter);

// /v1/account-invites/* — accept/decline/describe pending team invitations.
app.route('/v1/account-invites', accountInvitesRouter);

app.route('/v1/ops', opsApp);

app.openapi(
  createRoute({
    method: 'get',
    path: '/v1/user-roles',
    tags: ['system'],
    summary: 'The caller’s platform role (admin gate)',
    ...auth,
    middleware: [supabaseAuth] as const,
    responses: {
      200: json(
        z.object({ isAdmin: z.boolean(), role: z.string().nullable() }).openapi('UserRoles'),
        'Platform role',
      ),
      ...errors(401),
    },
  }),
  async (c: any) => {
    const accountId = c.get('userId') as string;
    const role = await getPlatformRole(accountId);
    const isAdmin = role === 'admin' || role === 'super_admin';

    return c.json({ isAdmin, role });
  },
);

// ─── Mount Sub-Services ─────────────────────────────────────────────────────
// All services follow the pattern: /v1/{serviceName}/...

app.route('/v1/router', router); // /v1/router/chat/completions, /v1/router/models, /v1/router/web-search, /v1/router/tavily/*, etc.

// LLM gateway surfaces: in-API /v1/llm (full pipeline), /internal/gateway
// control-plane RPC, and the /v1/llm-gateway reverse proxy. See ./llm-gateway/wire.
//
// STATIC, not `await import(...)`. A top-level await here suspends the rest of
// this module — including `app.route('/v1/projects', projectsApp)` 30 lines
// below — so any importer that observes `app` before the await settles gets a
// PARTIALLY MOUNTED app and a 404 on every route registered after this point.
// Under `bun test` that is exactly what happened: `import { app } from '../index'`
// returned an app with 313 of 1,386 routes, and every project-route integration
// test 404'd instead of exercising its gate.
mountLlmGateway(app);

// OpenRouter-parity read endpoints, scoped to the authenticated account.
import { generationApp } from './router/routes/generation';
import { usageApp } from './router/routes/usage';
app.route('/v1/generation', generationApp); // GET /v1/generation?id=<requestId> — single gateway-call forensics
app.route('/v1/usage', usageApp); // GET /v1/usage[?start&end&group_by] — account usage rollup

app.route('/v1/billing', billingApp); // /v1/billing/account-state, /v1/billing/webhooks/*
app.route('/v1/account', accountDeletionApp); // account deletion status/request/cancel/immediate
app.route('/v1/notifications', notificationsApp); // POST/DELETE /v1/notifications/device-token — mobile push registration
// Auth for the platform routes that need an identity. Scoped to these exact
// paths, not `/v1/platform/*`: the mount point, `/sandbox/version` and the
// github-app setup callbacks are deliberately unauthenticated and would break.
//
// Without this the route was unreachable. `auth` from openapi/index.ts is
// `{ security: [{ bearerAuth: [] }] }` — OpenAPI METADATA, not middleware — so
// `authType` was never set and the handler's `authType !== 'apiKey'` guard
// returned 403 for every relay. The daemon fire-and-forgets this call, so it
// failed silently and no in-guest boot timeline was ever recorded.
// supabaseAuth is the middleware carrying the sandbox-token path allowlist
// (middleware/auth.ts), which already lists `/boot-timeline`.
app.use('/v1/platform/boot-timeline', supabaseAuth);
// Same wiring, same reason, for the daemon's runtime-projection push. A route
// mounted without this is not "insecure" — it is UNREACHABLE, answering 403 to
// every fire-and-forget push, in silence. That is the exact defect
// `__tests__/unit-boot-timeline-auth-mount.test.ts` exists to pin, and it now
// pins this route too.
app.use('/v1/platform/runtime-projection', supabaseAuth);
app.route('/v1/platform', platformApp); // /v1/platform, /v1/platform/sandbox/version
registerAllProjectRoutes();
app.route('/v1/projects', projectsApp); // /v1/projects — Git-backed Kortix projects
// /v1/mcp — the hosted MCP server, bound to the caller's token like the CLI.
// It answers its own 401 with an OAuth challenge, so no auth middleware here.
// dispatchInProcess takes the assembled app as its second argument (it
// falls back to app.fetch), so the mount binds it here instead of importing
// the app back — that would cycle app.ts and inbound-dispatch.ts.
app.route('/v1/mcp', createMcpApp((req) => dispatchInProcess(req, app)));
app.route('/v1/marketplace', marketplaceApp); // /v1/marketplace — browse the registry catalog

// /v1/skills — the kortix-managed system skills (how Kortix itself works), served
// straight out of @kortix/starter so the text always matches this deploy. This is
// what lets an agent in ANY harness, holding only the `kortix` binary and a token,
// read the platform's own instructions with no repo checkout and no sandbox.
// combinedAuth (not supabaseAuth) so a CLI `kortix_pat_` and the in-sandbox
// KORTIX_TOKEN works; see ./skills/index.ts for the full auth rationale.
app.use('/v1/skills', combinedAuth);
app.use('/v1/skills/*', combinedAuth);
app.route('/v1/skills', skillsApp); // GET /v1/skills, /v1/skills/:name[?full=1], /v1/skills/:name/file?path=

// /v1/runtime-assets — the sandbox runtime assets THIS deploy was built with:
// the `kortix-agent` daemon and `kortix` CLI binaries it bakes into snapshots,
// and the managed-skill overlay. A live sandbox reconciles against these on
// every session start/restart/resume, which is what stops an old box from
// running a daemon or CLI that predates the routes it calls. combinedAuth for
// the same reason as /v1/skills above: the callers are a `kortix_pat_` CLI and
// the in-sandbox KORTIX_TOKEN. The `/*` wildcard is what puts every payload
// route behind auth — a new one must be added to runtimeAssetsApp, never mounted
// beside it.
app.use('/v1/runtime-assets/*', combinedAuth);
app.route('/v1/runtime-assets', runtimeAssetsApp); // GET /manifest, /cli, /agent, /managed-skills

// Universal git smart-HTTP proxy — every git-backed project's client origin.
// Auth is handled inside (git sends Basic/Bearer, not combinedAuth's Bearer),
// so it is intentionally NOT wrapped in combinedAuth.
{
  app.route('/v1/git', gitProxyApp); // /v1/git/:projectId(.git)/{info/refs,git-upload-pack,git-receive-pack}
}

// Connector — unified connector layer. Gateway routes (/catalog, /call) use
// KORTIX_TOKEN (validated inside the router); admin routes
// (/projects/:id/connectors*) need user auth, so combinedAuth runs first.
{
  app.use('/v1/connectors/projects/*', combinedAuth);
  app.use('/v1/connectors/connect-status', combinedAuth); // deployment capability flag (authed)
  app.route('/v1/connectors', connectorApp);
}

app.route('/v1/webhooks', projectWebhooksApp); // /v1/webhooks/:triggerId — signed project trigger fires

app.route('/v1/webhooks/slack/oauth', slackOauthApp); // /v1/webhooks/slack/oauth/callback — OAuth dance
registerSlackWebhookRoutes();
app.route('/v1/webhooks/slack', slackWebhookApp); // /v1/webhooks/slack/:projectId — raw Slack events (BYO mode)
app.route('/v1/webhooks/teams/oauth', teamsOauthApp); // /v1/webhooks/teams/oauth/callback — admin-consent + catalog publish
registerTeamsWebhookRoutes();
app.route('/v1/webhooks/teams', teamsWebhookApp); // /v1/webhooks/teams/messages — Bot Framework activities
app.route('/v1/channels/slack/identity', slackIdentityApp); // /v1/channels/slack/identity/bind — authed /login bind
app.route('/v1/channels/teams/identity', teamsIdentityApp); // /v1/channels/teams/identity/bind — authed login bind
app.route('/v1/webhooks/telegram', telegramWebhookApp); // /v1/webhooks/telegram/:projectId — Telegram updates
registerEmailWebhookRoutes();
app.route('/v1/webhooks/email', emailWebhookApp); // /v1/webhooks/email/agentmail — AgentMail inbound email (Svix-signed)
registerSendEmailHookRoutes();
app.route('/v1/webhooks/auth', authEmailHookApp); // /v1/webhooks/auth/send-email — Supabase Auth send-email hook (Standard Webhooks-signed)

app.route('/v1/webhooks/sandbox', sandboxWebhooksApp); // /v1/webhooks/sandbox/{daytona,platinum} — provider lifecycle → close billing

// Access control — public endpoints for signup gating
app.route('/v1/access', accessControlApp); // /v1/access/signup-status, /v1/access/check-email, /v1/access/request-access

// Apps edge — UNAUTHENTICATED. The self-host reverse proxy calls
// /v1/apps/edge/tls-check?domain=<host> as its on-demand-TLS `ask` before
// issuing a per-App certificate; 200 only for a real App host. Public by design
// (Caddy cannot present a bearer token); it discloses only whether a hostname
// maps to an App. Not an App public host itself (Host = kortix-api), so it is
// served by Hono, never intercepted by handleAppPublicRequest.
// One on-demand-TLS gate for every wildcard family this instance serves (Apps
// and sandbox previews). Caddy allows a single global `ask`, so both families
// share one handler — mounted at BOTH paths. `/v1/apps/edge/tls-check` is where
// every already-installed Caddyfile points, and it keeps working: an instance
// that updates its assets before its API image still gets a correct answer for
// App hosts, and preview hosts simply have no certificate until the API is new.
// `/v1/edge/tls-check` is the name that describes what it now does.
// See edge/tls-check.ts.
app.route('/v1/apps/edge', edgeApp); // GET /v1/apps/edge/tls-check?domain=<host>
app.route('/v1/edge', edgeApp); // GET /v1/edge/tls-check?domain=<host>

// Setup links — PUBLIC, token-gated. An agent-minted (encrypted, short-lived,
// value-only) token is the bearer capability, so a human can fill in a secret
// or 1-click a Pipedream connect from a Slack link with no login. The mint half
// is authenticated, on projectsApp (/v1/projects/:id/{secret,connect}-requests).
import { setupLinksPublicApp } from './setup-links/public-app';
app.route('/v1/setup-links', setupLinksPublicApp); // /v1/setup-links/{secret,connector}/:token

// Approval links — AUTHENTICATED, unlike the setup links above. The token names
// which pending decision is being asked for; it never confers the right to make
// it (see setup-links/approval-app.ts for why an approval must not be a bearer
// capability). supabaseAuth 401s an anonymous hit so the page can bounce the
// human through login and return them here.
import { approvalLinksApp } from './setup-links/approval-app';
app.use('/v1/approval-links/*', supabaseAuth);
app.route('/v1/approval-links', approvalLinksApp); // GET /v1/approval-links/:token

// Public session shares — PUBLIC, share-id-gated. Anonymous, read-only
// session title + sanitized transcript for a valid session public-share
// (any resource type SESS-13's CRUD creates); exposed through the SDK's
// `getPublicSessionShare` / `getPublicSessionShareMessages`. The web app has
// no page for it. No auth, no client-side sandbox access — the API reads the
// sandbox's OpenCode daemon server-side.
import { publicSessionSharesApp } from './public-session-shares';
app.route('/v1/public/session-shares', publicSessionSharesApp); // /v1/public/session-shares/:shareId[/messages]

// Setup — local/self-hosted only. Hidden when billing is enabled so the admin
// surface isn't exposed on managed/cloud deployments.
if (!config.KORTIX_BILLING_INTERNAL_ENABLED) {
  app.route('/v1/setup', setupApp); // /v1/setup/install-status (public), rest (auth inside router)
}
// /v1/admin/* — admin console (accounts/users/ledger/credits). supabaseAuth +
// requireAdmin enforced inside the router. Backs apps/web/src/app/admin/.
app.route('/v1/admin', adminApp);

// OAuth2 provider — public token endpoint, auth on authorize/consent
app.route('/v1/oauth', oauthApp);
app.route('/v1/connectors/oauth2', nativeOAuth2CallbackApp);

// TUNNEL_ENABLED=false: the relay never starts, so every tunnel route answers
// 503. The web hides its computer surfaces when the machine list fails.
app.use('/v1/tunnel/*', async (c, next) => {
  if (config.TUNNEL_ENABLED) return next();
  return c.json({ error: 'Computers are disabled on this deployment', code: 'tunnel_disabled' }, 503);
});

// Public device-auth endpoints (no auth — CLI uses these)
import { createDeviceAuthPublicRouter } from './tunnel/routes/device-auth';
app.route('/v1/tunnel/device-auth', createDeviceAuthPublicRouter());
// Machine self-unpair: authenticated by the machine's own token, not a user.
import { createTunnelSelfRouter } from './tunnel/routes/connections';
app.route('/v1/tunnel/self', createTunnelSelfRouter());

app.use('/v1/tunnel/*', async (c, next) => {
  // Skip auth for public device-auth routes: POST /device-auth and GET /device-auth/:code/status
  if (c.req.path === '/v1/tunnel/self') return next();
  const path = c.req.path.replace('/v1/tunnel/device-auth', '');
  if (c.req.path.startsWith('/v1/tunnel/device-auth')) {
    if (c.req.method === 'POST' && (path === '' || path === '/')) return next();
    if (c.req.method === 'GET' && path.endsWith('/status')) return next();
  }
  return combinedAuth(c, next);
});
app.route('/v1/tunnel', tunnelApp);

// Preview Proxy — unified route for sandbox HTTP access.
// Pattern: /v1/p/{sandboxId}/{port}/* — sandboxId is the provider external ID,
// resolved to a reachable upstream URL via the provider ingress contract.
// Auth: unified previewProxyAuth (accepts Supabase JWT and kortix_ tokens).
// MUST be after all explicit routes (wildcard catch-all).
app.route('/v1/p', sandboxProxyApp);

installHttpErrors(app);
