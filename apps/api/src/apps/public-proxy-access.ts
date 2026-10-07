import type { AgentGrant } from '@kortix/db';
import { config } from '../config';
import { validateAccountToken, validateAccountTokenById } from '../repositories/account-tokens';
import { validateServiceAccountToken } from '../repositories/service-accounts';
import { isAccountToken, isServiceAccountToken } from '../shared/crypto';
import { annotateAuditEvent, bindAuditPrincipal } from '../shared/audit-scope';
import { appAccessibleToAgentSession, appAccessibleToUser, appAccessCookie, appAccessCookieName, appAccessSecret, cookieValue, createAppAccessToken, isAppAgentAssertion, verifyAppAccessToken, verifyAppAgentAssertion, type AppAccessMode, type AppAgentSessionPrincipal } from './access';
import { escapeHtml } from '../shared/html';
import { appBrowserNavigation, appFrameAncestors, PROXY_PAGE_SYMBOL, PROXY_PAGE_TOKENS } from './public-proxy-status';
import { APP_VIEWER_HEADER, APP_VIEWER_TOKEN_HEADER, appViewerSecret, encodeAppViewerContext, mintAppViewerToken, normalizeViewerTokenScope, resolveAppViewerIdentity } from './viewer';

function accessTokenMatchesMode(
  token: ReturnType<typeof verifyAppAccessToken>,
  app: { accessMode: string; accessRevision: number },
): boolean {
  if (!token || token.revision !== app.accessRevision) return false;
  return app.accessMode === 'password' ? token.kind === 'password' : token.kind === 'kortix';
}

export type AppAccessRow = {
  appId: string;
  accountId: string;
  projectId: string;
  name: string;
  /** The App slug — what an agent's `apps` grant lists (spec §2.5). */
  slug?: string | null;
  accessMode: string;
  accessPasswordHash: string | null;
  accessRevision: number;
  createdBy: string | null;
  updatedAt: Date;
  /** Judge a governed agent session as the agent (§2.5). Absent = human decision. */
  agentPrincipal?: boolean;
};

type AppUserAccessVerifier = (
  app: AppAccessRow,
  userId: string,
  actingTokenId?: string,
) => Promise<boolean>;

type AppAgentAccessVerifier = (
  app: AppAccessRow,
  principal: AppAgentSessionPrincipal,
) => Promise<boolean>;

async function accessTokenAuthorizesRequest(
  token: ReturnType<typeof verifyAppAccessToken>,
  app: AppAccessRow,
  verifyUserAccess: AppUserAccessVerifier,
): Promise<boolean> {
  if (!accessTokenMatchesMode(token, app)) return false;
  if (token!.kind === 'password') return true;
  return Boolean(token!.userId && await verifyUserAccess(app, token!.userId));
}

function safeAppReturnTo(value: string): string {
  return value.startsWith('/') && !value.startsWith('//') ? value : '/';
}

function appAccessResponse(
  request: Request,
  app: { appId: string; projectId: string; name: string; accessMode: string },
  invalidPassword = false,
  returnTo = safeAppReturnTo(new URL(request.url).pathname + new URL(request.url).search),
): Response {
  const mode = app.accessMode as AppAccessMode;
  if (!appBrowserNavigation(request)) {
    return Response.json(
      { error: 'App authentication required', code: 'app_auth_required', access_mode: mode },
      { status: 401, headers: { 'cache-control': 'no-store' } },
    );
  }
  const name = escapeHtml(app.name);
  const isPassword = mode === 'password';
  const action = isPassword
    ? `<form method="post" action="/_kortix/access/password"><label for="password">Password</label><input id="password" name="password" type="password" minlength="8" required autocomplete="current-password"><input type="hidden" name="return_to" value="${escapeHtml(returnTo)}"><button type="submit">Open App</button>${invalidPassword ? '<p class="error" role="alert">The password is incorrect.</p>' : ''}</form>`
    : `<a class="button" href="${escapeHtml(`${config.FRONTEND_URL.replace(/\/$/, '')}/projects/${app.projectId}/apps?open_app=${app.appId}`)}">Continue with Kortix</a>`;
  const message = isPassword
    ? 'Enter the password configured by the App owner.'
    : 'Sign in with a Kortix account that can access this App.';
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Access ${name}</title><style>${PROXY_PAGE_TOKENS}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:var(--background);color:var(--foreground);font:14px/1.5 var(--font-sans)}.card{width:min(100%,420px);padding:24px;border:1px solid var(--border);border-radius:12px;background:var(--card)}.mark{display:flex;align-items:center;gap:9px;margin-bottom:28px;font-weight:600}.symbol{display:block;width:auto}h1{margin:0 0 6px;font-size:20px;letter-spacing:-.02em}p{margin:0 0 20px;color:var(--muted-foreground)}form{display:grid;gap:10px}label{font-size:12px;font-weight:600}input{width:100%;height:42px;padding:0 12px;border:1px solid var(--border);border-radius:8px;background:transparent;color:inherit;font:inherit}button,.button{display:flex;align-items:center;justify-content:center;height:42px;padding:0 16px;border:0;border-radius:999px;background:var(--primary);color:var(--primary-foreground);font:inherit;font-weight:600;text-decoration:none;cursor:pointer}.error{margin:0;color:var(--destructive);font-size:12px}</style></head><body><main class="card"><div class="mark">${PROXY_PAGE_SYMBOL}Kortix Apps</div><h1>${name}</h1><p>${escapeHtml(message)}</p>${action}</main></body></html>`, {
    status: 401,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; ${appFrameAncestors()}`,
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    },
  });
}


/**
 * A Kortix credential presented as a bearer token, resolved to the identity it
 * carries — or null when there is no usable one.
 *
 * WHY THE GATEWAY NEEDS THIS
 *
 * Every other way into a non-public App is a browser flow: a five-minute
 * exchange URL, an eight-hour cookie, an HTML password form. That makes
 * `project` access and programmatic access mutually exclusive, and the two are
 * wanted together constantly — an agent publishing to its own App, a connector
 * built from the App's OpenAPI document, CI checking a deploy. The only way to
 * have both was to make the App `public` and re-implement authorization inside
 * it, which is exactly the thing an access mode is supposed to save you from.
 *
 * A PAT already carries the minting user's identity and a service-account token
 * its own principal, and both are exactly what the App access policy is written
 * in terms of — so the decision below is the SAME `verifyUserAccess` the cookie
 * path uses. This adds a way to present an identity, not a way to skip one.
 *
 * `password` mode is deliberately excluded: there the secret IS the password,
 * and a Kortix credential is not it.
 */
interface AppBearerPrincipal {
  userId: string;
  /**
   * The token the caller presented. Carried through to `authorize` so the
   * decision sees the credential's OWN limits — project binding, agent grant —
   * and not just the identity behind it. Reducing a PAT to a bare user id here
   * let a project-scoped token from project A open a non-public App in project
   * B, because token-scope is only evaluated when this id is supplied.
   */
  actingTokenId: string;
  /** Set for a session token (`account_tokens.session_id`). */
  sessionId?: string | null;
  /** The token's project binding. */
  projectId?: string | null;
  /** The running agent's grant, for an agent-session token. */
  agentGrant?: AgentGrant | null;
  /** A direct service-account bearer: `userId` is the service account's id. */
  serviceAccount?: boolean;
}

/**
 * The header that carries a Kortix credential for the App gate WITHOUT taking
 * `Authorization` from the App (spec 2026-09-22 §2.5). An App that authorizes
 * its own API with `Authorization: Bearer <app key>` keeps that header; the
 * caller's Kortix identity travels here. `appUpstreamHeaders` deletes it, so
 * the App never sees it.
 */
export const APP_AUTHORIZATION_HEADER = 'x-kortix-app-authorization';

/**
 * Bearer values a request offers the gate, in the order they are tried:
 * `X-Kortix-App-Authorization` first (it exists only for the gate), then
 * `Authorization` (which may equally be the App's own key — a value that is
 * not a Kortix credential resolves to no identity).
 */
export function appCredentialFromRequest(
  request: Request,
  opts: { agentPrincipal: boolean },
): Array<{ token: string; via: 'x-kortix-app-authorization' | 'authorization' }> {
  const out: Array<{ token: string; via: 'x-kortix-app-authorization' | 'authorization' }> = [];
  // Flag OFF = today's gate byte for byte: only `Authorization` is read, so a
  // bearer or a connector assertion in `X-Kortix-App-Authorization` is ignored
  // (the header is still deleted before the request reaches the App).
  const headers = opts.agentPrincipal
    ? ([APP_AUTHORIZATION_HEADER, 'authorization'] as const)
    : (['authorization'] as const);
  for (const via of headers) {
    const header = request.headers.get(via) ?? '';
    if (!/^bearer /i.test(header)) continue;
    const token = header.slice(7).trim();
    if (token) out.push({ token, via });
  }
  return out;
}

function principalFromTokenResult(
  pat: Awaited<ReturnType<typeof validateAccountToken>>,
): AppBearerPrincipal | null {
  return pat.isValid && pat.userId && pat.tokenId
    ? {
        userId: pat.userId,
        actingTokenId: pat.tokenId,
        sessionId: pat.sessionId ?? null,
        projectId: pat.projectId ?? null,
        agentGrant: pat.agentGrant ?? null,
      }
    : null;
}

async function resolveOneCredential(
  token: string,
  via: 'x-kortix-app-authorization' | 'authorization',
  app: Pick<AppAccessRow, 'appId' | 'projectId' | 'agentPrincipal'>,
): Promise<AppBearerPrincipal | null> {
  try {
    if (isAppAgentAssertion(token)) {
      // Minted only by the connector gateway, and only for this header.
      if (via !== APP_AUTHORIZATION_HEADER || !app.agentPrincipal) return null;
      const verified = verifyAppAgentAssertion(token, { appId: app.appId, projectId: app.projectId });
      if (!verified) return null;
      const principal = principalFromTokenResult(await validateAccountTokenById(verified.tokenId));
      // An assertion stands for a live SESSION token of this App's project.
      if (!principal?.sessionId || principal.projectId !== app.projectId) return null;
      return principal;
    }
    if (isServiceAccountToken(token)) {
      const account = await validateServiceAccountToken(token);
      // A direct service-account bearer has no `account_tokens` row; its own
      // id is the acting id, and the engine scopes it by its policies.
      return account.isValid && account.serviceAccountId
        ? {
            userId: account.serviceAccountId,
            actingTokenId: account.serviceAccountId,
            serviceAccount: true,
          }
        : null;
    }
    if (isAccountToken(token)) {
      return principalFromTokenResult(await validateAccountToken(token));
    }
  } catch {
    // A malformed or revoked credential is "no identity", not a 500.
  }
  return null;
}

async function kortixCredentialUser(
  request: Request,
  app: Pick<AppAccessRow, 'appId' | 'projectId' | 'agentPrincipal'>,
): Promise<AppBearerPrincipal | null> {
  for (const { token, via } of appCredentialFromRequest(request, { agentPrincipal: Boolean(app.agentPrincipal) })) {
    const principal = await resolveOneCredential(token, via, app);
    if (principal) return principal;
  }
  return null;
}

/**
 * True when this principal is judged as an AGENT (spec §2.5) rather than as
 * the human behind the token: a session token carrying an agent grant.
 * Everything else — a null grant (ungoverned project), a laptop PAT, a service
 * account — keeps the existing member/group decision.
 */
function judgedAsAgent(
  app: AppAccessRow,
  principal: AppBearerPrincipal,
): principal is AppBearerPrincipal & { sessionId: string; agentGrant: AgentGrant } {
  return Boolean(app.agentPrincipal && principal.sessionId && principal.agentGrant);
}

async function credentialMayOpenApp(
  app: AppAccessRow,
  principal: AppBearerPrincipal,
  verifyUserAccess: AppUserAccessVerifier,
  verifyAgentAccess: AppAgentAccessVerifier,
): Promise<boolean> {
  if (judgedAsAgent(app, principal)) {
    return verifyAgentAccess(app, {
      userId: principal.userId,
      actingTokenId: principal.actingTokenId,
      sessionId: principal.sessionId,
      projectId: principal.projectId ?? null,
      agentGrant: principal.agentGrant,
    });
  }
  return verifyUserAccess(app, principal.userId, principal.actingTokenId);
}

/**
 * The user id behind the gate's browser session, or null.
 *
 * Reads the SAME cookie `authorizeAppRequest` just validated, so it is one
 * HMAC verification and no database work. `password` mode carries no identity
 * by construction (the secret is the password, not a person), and a `public`
 * App has no session at all — both answer null.
 */
export function resolveAppViewerUserId(
  request: Request,
  url: URL,
  app: Pick<AppAccessRow, 'appId' | 'accessMode' | 'accessRevision'>,
): string | null {
  // A PUBLIC App still recognises whoever the gate signed in.
  //
  // This used to bail here for `public`, so the cookie was never even read and
  // `public` quietly meant two things: "anyone with the link may open this" AND
  // "nobody is ever recognised". Only the first is what public is for. An App
  // shared with an outside client still wants to know its own team when they
  // open it, without shutting the client out.
  //
  // Identity is not authorization. A public App already authorizes everyone;
  // this only answers WHO, and only when the gate's own signed, revision-bound
  // cookie says so. A visitor with no cookie stays anonymous, which is what
  // keeps the bare shared link working.
  //
  // `password` needs no special case: its cookie proves knowledge of a shared
  // secret rather than a person, and the `kind !== 'kortix'` check below is
  // already what keeps it out.
  const localHttp = url.protocol === 'http:' && url.hostname.endsWith('.apps.localhost');
  const raw = cookieValue(request, appAccessCookieName(localHttp));
  if (!raw) return null;
  const payload = verifyAppAccessToken(raw, app.appId, appAccessSecret());
  if (!payload || payload.kind !== 'kortix' || payload.revision !== app.accessRevision) return null;
  return payload.userId ?? null;
}

export interface AppViewerHeaders {
  /** Signed identity — always present when a viewer is signed in. */
  context: string;
  /** The viewer's App-scoped Kortix token. Only for `viewer_token_scope: 'api'`. */
  token: string | null;
}

/**
 * What the container is told about this request's viewer: a signed identity,
 * and — for an `api`-scoped App — the token to act as them with. Null when the
 * App shares nothing (`off`) or nobody is signed in.
 *
 * The token mint is cached in-process per (App, viewer), so this costs one
 * `Map` lookup and one token-row read on the hot path after the first request
 * of each hour. The read is what keeps a token revoked elsewhere off the wire.
 */
export async function appViewerContextHeader(
  request: Request,
  url: URL,
  app: AppAccessRow & { accountId: string; name?: string; viewerTokenScope?: string | null },
): Promise<AppViewerHeaders | null> {
  const scope = normalizeViewerTokenScope(app.viewerTokenScope);
  if (scope === 'off') return null;
  const userId = resolveAppViewerUserId(request, url, app);
  if (!userId) return null;
  const [identity, minted] = await Promise.all([
    resolveAppViewerIdentity(userId, app.accountId),
    scope === 'api'
      ? mintAppViewerToken(
          {
            appId: app.appId,
            accountId: app.accountId,
            name: app.name ?? 'Kortix App',
            viewerTokenScope: scope,
          },
          userId,
        ).catch((error) => {
          // An App must not go dark because a token could not be minted: the
          // identity header still lands and the App can still authorize its own
          // data. `/_kortix/viewer` surfaces the failure when it is asked.
          console.warn(`[apps] viewer token mint failed for ${app.appId}:`, error);
          return null;
        })
      : Promise.resolve(null),
  ]);
  return {
    context: encodeAppViewerContext(
      {
        appId: app.appId,
        userId,
        email: identity.email,
        name: identity.name ?? null,
        picture: identity.picture ?? null,
        groupIds: identity.groupIds,
        groups: identity.groups ?? [],
        role: identity.role ?? null,
        projectId: app.projectId,
        accountId: app.accountId,
        accessMode: app.accessMode,
      },
      appViewerSecret(app.appId),
    ),
    token: minted?.accessToken ?? null,
  };
}

/**
 * Who is calling a `/_kortix/*` endpoint: the browser's Kortix cookie, or a
 * server-side Kortix credential that passes the App's access policy. An agent
 * session is admitted as the AGENT (`agentViewer`). A 401 Response when nobody.
 */
async function resolveEndpointViewer(
  request: Request,
  url: URL,
  app: AppAccessRow,
): Promise<{ userId: string; agentViewer: boolean } | Response> {
  const noStore = { 'cache-control': 'no-store' };
  let userId = resolveAppViewerUserId(request, url, app);
  let agentViewer = false;
  if (!userId && app.accessMode !== 'password') {
    // A server-side caller inside the App can present its own Kortix credential
    // instead of a browser cookie. It still has to pass the App's access policy.
    const principal = await kortixCredentialUser(request, app);
    if (
      principal &&
      (await credentialMayOpenApp(app, principal, appAccessibleToUser, appAccessibleToAgentSession))
    ) {
      userId = principal.userId;
      // An agent session is admitted as the AGENT. Minting an `api` viewer
      // token would hand it the launching human's own App authority, so it
      // gets the identity and no token.
      agentViewer = judgedAsAgent(app, principal);
    }
  }
  if (!userId) {
    return Response.json(
      {
        error: 'no_viewer_identity',
        error_description:
          app.accessMode === 'public' || app.accessMode === 'password'
            ? `A ${app.accessMode} App has no signed-in Kortix viewer.`
            : 'No Kortix session on this request.',
        access_mode: app.accessMode,
      },
      { status: 401, headers: noStore },
    );
  }
  return { userId, agentViewer };
}

/**
 * `GET /_kortix/backend-token?backend=<name>` — a Kortix sign-in token for one
 * of the project's backends, naming this viewer. The App's Convex client sends
 * it (`client.setAuth`), and the backend's functions read the member with
 * `ctx.auth.getUserIdentity()`. Same viewer rules as `/_kortix/viewer`.
 */
export async function appBackendTokenResponse(
  request: Request,
  url: URL,
  app: AppAccessRow & { viewerTokenScope?: string | null; backends?: string[] | null },
  verifyUserAccess: AppUserAccessVerifier = appAccessibleToUser,
): Promise<Response> {
  const noStore = { 'cache-control': 'no-store' };
  if (normalizeViewerTokenScope(app.viewerTokenScope) === 'off') {
    return Response.json(
      { error: 'viewer_disabled', error_description: 'This App does not receive viewer identity.' },
      { status: 404, headers: noStore },
    );
  }
  const name = url.searchParams.get('backend') ?? 'main';
  // An App acts as its viewer only on the backends it lists (`apps.backends`).
  // Code in an App that has nothing to do with a backend gets no token for it.
  if (!(app.backends ?? []).includes(name)) {
    return Response.json(
      {
        error: 'backend_not_listed',
        error_description: `This App does not list the backend "${name}". Add it to the App's backends: kortix apps set <app> --backends ${name}.`,
      },
      { status: 403, headers: noStore },
    );
  }
  const viewer = await resolveEndpointViewer(request, url, app);
  if (viewer instanceof Response) return viewer;
  if (viewer.agentViewer) {
    // As on /_kortix/viewer: an agent session must not act as the human who launched it.
    return Response.json(
      { error: 'agent_viewer', error_description: 'An agent session mints a token naming the agent: POST /v1/projects/{projectId}/backends/{backendId}/token.' },
      { status: 403, headers: noStore },
    );
  }
  // A public App lets every request through, so nothing re-checked the gate
  // cookie: a member removed after redeeming a link kept minting backend
  // tokens for the cookie's 8 h. A token is a credential, so re-check access.
  if (app.accessMode === 'public' && !(await verifyUserAccess(app, viewer.userId))) {
    return Response.json(
      { error: 'no_viewer_identity', error_description: 'The signed-in viewer no longer has access to this App.', access_mode: app.accessMode },
      { status: 401, headers: noStore },
    );
  }
  // Loaded on use: the backends service pulls the project graph, which the App
  // gate's hot path (and every hand-written module mock of it) does not need.
  const { backendMemberToken, backendsEnabled, getRunningBackendByName } = await import('../backends/provision');
  if (!(await backendsEnabled(app.projectId))) {
    const { featureDisabledBody } = await import('../feature-flags/gate');
    return Response.json(featureDisabledBody('backends'), { status: 403, headers: noStore });
  }
  const backend = await getRunningBackendByName(app.projectId, name);
  if (!backend) {
    return Response.json(
      { error: 'backend_not_found', error_description: `No running backend named "${name}" in this project.` },
      { status: 404, headers: noStore },
    );
  }
  const identity = await resolveAppViewerIdentity(viewer.userId, app.accountId);
  const minted = backendMemberToken(backend, { userId: viewer.userId, ...identity });
  if (!minted) {
    return Response.json(
      { error: 'backend_auth_unavailable', error_description: 'This backend predates Kortix sign-in.' },
      { status: 409, headers: noStore },
    );
  }
  return Response.json({ token: minted.token, expires_at: minted.expiresAt.toISOString() }, { headers: noStore });
}

/** `GET /_kortix/viewer` — the App asks the gate who is looking, and for a token to act with. */
export async function appViewerEndpointResponse(
  request: Request,
  url: URL,
  app: AppAccessRow & { accountId: string; name: string; viewerTokenScope?: string | null },
): Promise<Response> {
  const noStore = { 'cache-control': 'no-store' };
  const scope = normalizeViewerTokenScope(app.viewerTokenScope);
  if (scope === 'off') {
    return Response.json(
      { error: 'viewer_disabled', error_description: 'This App does not receive viewer identity.' },
      { status: 404, headers: noStore },
    );
  }
  const viewer = await resolveEndpointViewer(request, url, app);
  if (viewer instanceof Response) return viewer;
  const { userId, agentViewer } = viewer;
  const [identity, minted] = await Promise.all([
    resolveAppViewerIdentity(userId, app.accountId),
    agentViewer
      ? Promise.resolve(null)
      : mintAppViewerToken(
          { appId: app.appId, accountId: app.accountId, name: app.name, viewerTokenScope: scope },
          userId,
        ),
  ]);
  return Response.json(
    {
      app_id: app.appId,
      access_mode: app.accessMode,
      account_id: app.accountId,
      project_id: app.projectId,
      user_id: userId,
      email: identity.email,
      name: identity.name ?? null,
      picture: identity.picture ?? null,
      group_ids: identity.groupIds,
      groups: identity.groups ?? [],
      role: identity.role ?? null,
      scopes: minted?.scopes ?? [],
      access_token: minted?.accessToken ?? null,
      expires_at: minted?.expiresAt.toISOString() ?? null,
    },
    { headers: noStore },
  );
}

/**
 * The audit actor for a Kortix credential presented to the App gate. A
 * service-account bearer's `userId` is the service account, never a user;
 * an agent-session token is the agent.
 */
function bindAppBearerPrincipal(app: AppAccessRow, principal: AppBearerPrincipal): void {
  if (principal.serviceAccount) {
    bindAuditPrincipal({
      actorType: 'service_account',
      actorUserId: null,
      authoritativeSource: 'automation',
      authMethod: { kind: 'service_account', service_account_id: principal.userId },
    });
    return;
  }
  const tokenAuth = {
    kind: 'account_token',
    token_id: principal.actingTokenId,
    ...(principal.sessionId ? { session_id: principal.sessionId } : {}),
  };
  bindAuditPrincipal(
    judgedAsAgent(app, principal)
      ? { actorType: 'agent', actorUserId: null, authoritativeSource: 'agent', authMethod: tokenAuth }
      : { actorType: 'human', actorUserId: principal.userId, authoritativeSource: 'api_key', authMethod: tokenAuth },
  );
}

/**
 * Name the Kortix user the App's signed session proves. Called once the gate
 * has let the request through, for public Apps too: a public App still
 * recognises a signed-in viewer, and that viewer is audited. An anonymous
 * visitor binds nothing and is not audited (shared/audit.ts).
 */
export function bindAppViewerSession(userId: string): void {
  bindAuditPrincipal({
    actorType: 'human',
    actorUserId: userId,
    authoritativeSource: 'human',
    authMethod: { kind: 'app_session' },
  });
}

async function passwordAccessResponse(
  request: Request,
  app: AppAccessRow,
  secret: string,
  localHttp: boolean,
): Promise<Response> {
  const form = await request.formData().catch(() => null);
  const password = String(form?.get('password') ?? '');
  if (app.accessPasswordHash && await Bun.password.verify(password, app.accessPasswordHash)) {
    const session = createAppAccessToken({
      appId: app.appId,
      kind: 'password',
      revision: app.accessRevision,
      expiresAt: new Date(Date.now() + 8 * 60 * 60_000),
    }, secret);
    const location = safeAppReturnTo(String(form?.get('return_to') ?? '/'));
    return new Response(null, {
      status: 303,
      headers: {
        location,
        'set-cookie': appAccessCookie(session, 8 * 60 * 60, localHttp),
      },
    });
  }
  return appAccessResponse(
    request,
    app,
    true,
    safeAppReturnTo(String(form?.get('return_to') ?? '/')),
  );
}

export async function authorizeAppRequest(
  request: Request,
  url: URL,
  app: AppAccessRow,
  verifyUserAccess: AppUserAccessVerifier = appAccessibleToUser,
  verifyAgentAccess: AppAgentAccessVerifier = appAccessibleToAgentSession,
): Promise<Response | null> {
  const localHttp = url.protocol === 'http:' && url.hostname.endsWith('.apps.localhost');
  const secret = appAccessSecret();
  // The App is the resource. Its account is resolved from the project when
  // the audit row is written.
  annotateAuditEvent({ resourceType: 'app', resourceId: app.appId });
  bindAuditPrincipal({ projectId: app.projectId });
  const queryToken = url.searchParams.get('__kortix_access');
  // NOTE the public App does not return early here any more. It still redeems
  // an access link — that exchange is the only way its identity cookie can ever
  // exist — and only the DENIAL paths below are skipped for it. See the guard
  // after this block.
  if (queryToken && (request.method === 'GET' || request.method === 'HEAD')) {
    const verified = verifyAppAccessToken(queryToken, app.appId, secret);
    if (await accessTokenAuthorizesRequest(verified, app, verifyUserAccess)) {
      const session = createAppAccessToken({
        appId: app.appId,
        kind: verified!.kind,
        userId: verified!.userId,
        revision: app.accessRevision,
        expiresAt: new Date(Date.now() + 8 * 60 * 60_000),
      }, secret);
      url.searchParams.delete('__kortix_access');
      return new Response(null, {
        status: 303,
        headers: {
          location: `${url.pathname}${url.search}`,
          'set-cookie': appAccessCookie(session, 8 * 60 * 60, localHttp),
        },
      });
    }
  }
  // A public App is never gated. Everything from here down decides whether to
  // REFUSE, and refusing is exactly what public means not doing — so it lets
  // the request through, with or without an identity. A visitor who redeemed a
  // link above is now carrying the cookie; the client who was sent the bare URL
  // simply stays anonymous.
  if (app.accessMode === 'public') return null;

  const browserToken = cookieValue(request, appAccessCookieName(localHttp));
  if (
    browserToken &&
    await accessTokenAuthorizesRequest(
      verifyAppAccessToken(browserToken, app.appId, secret),
      app,
      verifyUserAccess,
    )
  ) {
    return null;
  }
  // A Kortix credential, for callers that are not browsers. Checked after the
  // cookie so the common path stays one HMAC verification with no database
  // work, and before the challenge so an API client gets its answer instead of
  // an HTML login page it cannot read.
  if (app.accessMode !== 'password') {
    const principal = await kortixCredentialUser(request, app);
    // Name the caller before the decision, so a refused credential is audited.
    if (principal) bindAppBearerPrincipal(app, principal);
    if (principal && await credentialMayOpenApp(app, principal, verifyUserAccess, verifyAgentAccess)) {
      return null;
    }
  }

  if (app.accessMode === 'password' && request.method === 'POST' && url.pathname === '/_kortix/access/password') {
    return passwordAccessResponse(request, app, secret, localHttp);
  }
  return appAccessResponse(request, app);
}
