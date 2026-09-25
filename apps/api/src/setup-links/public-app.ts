/**
 * Setup-link PUBLIC app — the unauthenticated half, mounted at /v1/setup-links.
 *
 * The agent-minted link's bearer capability IS the (encrypted, short-lived,
 * value-only) token, so these routes deliberately require no login: a teammate
 * who taps the link from a Slack message on their phone must be able to fill it
 * in. Resolve returns NO secret values — only the requested field names. Submit
 * can only write the names sealed into the token, into the one project the token
 * is for. Same trust model as a magic link / a Pipedream connect URL.
 */
import { createHash } from 'node:crypto';
import { requestClientKey } from '../shared/client-ip';
import { connectors, projectSessions, projects } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { type Context, Hono, type Next } from 'hono';
import { credentialExists } from '../connectors/credentials';
import {
  pipedreamConfigured,
} from '../connectors/pipedream';
import type { ConnectorConnectOwner } from '../projects/lib/connection-access';
import { propagateProjectSecretsToActiveSandboxes } from '../projects/lib/sandbox-env-sync';
import { isValidSecretName, writeSharedProjectSecret } from '../projects/secrets';
import { db } from '../shared/db';
import { TokenBucketRateLimiter, enforceRateLimit } from '../shared/rate-limit';
import { RATE_LIMIT_EXCEEDED_ACTION } from '../shared/rate-limit-audit';
import { resolveSetupLink } from './token';
import { watchConnectorCompletion } from './connector-completion-watch';
import { composioConfigured, composioToolkitLogo } from '../connectors/composio';
import { connectorConnectedPrompt, notifyConnectorSession } from '../connectors/notify-session';

// The connector half of the notification moved to connectors/notify-session.ts so the
// in-session Connect button's finalize can reuse it. Re-exported: this module is where
// the prompt text has always been asserted from.
export { connectorConnectedPrompt };

const setupLinksPublicApp = new Hono();

// Same shape as createPublicSessionShareRateLimitMiddleware (public-session-shares):
// no authenticated identity to key on, so key on the bearer token itself — every
// legitimate use of one link shares that bucket. `ksl_...` is the wire prefix
// minted in ./token.ts; anything not shaped like a real token falls back to the
// client IP so a flood of garbage tokens (each a distinct, never-colliding key)
// can't allocate unbounded rate-limit buckets or dodge the limit entirely.
const TOKEN_LIKE_REGEX = /^ksl_[A-Za-z0-9_-]{8,512}$/;
const setupLinkLimiter = new TokenBucketRateLimiter('setup_link');

function createSetupLinkRateLimitMiddleware() {
  return async (c: Context, next: Next) => {
    const rawToken = c.req.param('token');
    const key = rawToken && TOKEN_LIKE_REGEX.test(rawToken) ? rawToken : `ip:${requestClientKey(c)}`;
    // Never persist the raw bearer token (it's a live capability) — audit on a
    // truncated hash so hits on the same link/attempt are still correlatable.
    const resourceId = rawToken
      ? `ksl:${createHash('sha256').update(rawToken).digest('hex').slice(0, 16)}`
      : null;
    const denied = await enforceRateLimit(
      c,
      setupLinkLimiter,
      key,
      { limit: 30, windowMs: 60_000 },
      {
        action: RATE_LIMIT_EXCEEDED_ACTION,
        resourceType: 'setup_link',
        resourceId,
        metadata: { limiter: 'setup_link' },
      },
    );
    if (denied) return denied;
    await next();
  };
}

async function projectName(projectId: string): Promise<string> {
  const [row] = await db
    .select({ name: projects.name })
    .from(projects)
    .where(eq(projects.projectId, projectId))
    .limit(1);
  return row?.name ?? 'this project';
}

setupLinksPublicApp.use('/secret/:token', createSetupLinkRateLimitMiddleware());
setupLinksPublicApp.use('/connectors/:token', createSetupLinkRateLimitMiddleware());
setupLinksPublicApp.use('/connectors/:token/start', createSetupLinkRateLimitMiddleware());
setupLinksPublicApp.use('/connectors/:token/finalize', createSetupLinkRateLimitMiddleware());

// GET /v1/setup-links/secret/:token — what fields does this link ask for?
setupLinksPublicApp.get('/secret/:token', async (c) => {
  const resolved = resolveSetupLink(c.req.param('token'));
  if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status);
  if (resolved.payload.kind !== 'secret') return c.json({ error: 'Wrong link type' }, 400);

  return c.json({
    kind: 'secret',
    project_name: await projectName(resolved.projectId),
    fields: resolved.payload.fields.map((f) => ({
      name: f.name,
      label: f.label ?? null,
      description: f.description ?? null,
    })),
    expires_at: new Date(resolved.payload.exp).toISOString(),
  });
});

// POST /v1/setup-links/secret/:token — { values: { NAME: value } }
setupLinksPublicApp.post('/secret/:token', async (c) => {
  const resolved = resolveSetupLink(c.req.param('token'));
  if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status);
  if (resolved.payload.kind !== 'secret') return c.json({ error: 'Wrong link type' }, 400);

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const values = (body?.values ?? {}) as Record<string, unknown>;
  const allowed = new Set(resolved.payload.fields.map((f) => f.name));

  const saved: string[] = [];
  for (const [rawName, rawValue] of Object.entries(values)) {
    const name = rawName.toUpperCase();
    // Value-only: silently ignore anything the token didn't ask for, and never
    // let a leaked token write to a key it doesn't name.
    if (!allowed.has(name) || !isValidSecretName(name)) continue;
    const value = typeof rawValue === 'string' ? rawValue : '';
    if (!value) continue;
    await writeSharedProjectSecret({
      projectId: resolved.projectId,
      name,
      value,
      scope: resolved.payload.scope,
      createdBy: resolved.payload.uid,
    });
    saved.push(name);
  }

  if (saved.length === 0) {
    return c.json({ error: 'No values provided for the requested keys' }, 400);
  }

  // Live-propagate so an active session sees the new value without a restart.
  void propagateProjectSecretsToActiveSandboxes(resolved.projectId);

  // Notify the requesting session that the secret was submitted, so the agent
  // can immediately retry whatever needed the credential instead of re-minting
  // a link on its next loop run. The session ID is sealed into the token at
  // mint time (setup-links.ts passes c.get('sessionId')).
  const sid = (resolved.payload as { sid?: string | null }).sid;
  if (sid) {
    void notifyRequestingSession(sid, resolved.projectId, resolved.payload.uid, saved);
  }

  return c.json({ ok: true, saved });
});

// GET /v1/setup-links/connectors/:token — which app does this link connect?
setupLinksPublicApp.get('/connectors/:token', async (c) => {
  const resolved = resolveSetupLink(c.req.param('token'));
  if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status);
  if (resolved.payload.kind !== 'connector') return c.json({ error: 'Wrong link type' }, 400);

  const [name, identity] = await Promise.all([
    projectName(resolved.projectId),
    connectorIdentity(resolved.projectId, resolved.payload.slug, resolved.payload.app),
  ]);
  return c.json({
    kind: 'connector',
    project_name: name,
    slug: resolved.payload.slug,
    app: resolved.payload.app,
    name: identity.name,
    icon_url: identity.iconUrl,
    expires_at: new Date(resolved.payload.exp).toISOString(),
  });
});

/**
 * The display name and logo the in-chat card shows, so a connect link reads
 * "Connect Google Calendar" with its logo instead of a generic plug.
 *
 * The name comes from the project's connector row. The logo is the row's
 * `config.icon_url` when set, else the Composio catalogue logo for the link's
 * app — the same image the connectors catalogue shows. Connectors an agent adds
 * store no `icon_url`, so the catalogue is the source for almost every link.
 * Both are `null` when nothing is known; the card then shows a monogram.
 */
async function connectorIdentity(
  projectId: string,
  slug: string,
  app: string | null,
): Promise<{ name: string | null; iconUrl: string | null }> {
  const [row] = await db
    .select({ name: connectors.name, config: connectors.config })
    .from(connectors)
    .where(and(eq(connectors.projectId, projectId), eq(connectors.slug, slug)))
    .limit(1);
  const stored = (row?.config as { icon_url?: unknown } | null | undefined)?.icon_url;
  const iconUrl =
    typeof stored === 'string' && stored.length > 0
      ? stored
      : app
        ? await composioToolkitLogo(app)
        : null;
  return { name: row?.name ?? null, iconUrl };
}

/**
 * Shared gate for the two connector consume routes: resolve the token, confirm
 * it is a connector link this deployment can act on, and load the connector it
 * names. Returns the caller's error Response, or the resolved link + connector.
 */
async function resolveConnectorLink(c: Context): Promise<
  | { error: Response }
  | {
      projectId: string;
      slug: string;
      app: string;
      sid: string | null;
      uid: string | null;
      connectorId: string;
      owner: ConnectorConnectOwner;
    }
> {
  const resolved = resolveSetupLink(c.req.param('token'));
  if (!resolved.ok) return { error: c.json({ error: resolved.error }, resolved.status) };
  if (resolved.payload.kind !== 'connector') {
    return { error: c.json({ error: 'Wrong link type' }, 400) };
  }
  if (!composioConfigured() && !pipedreamConfigured()) {
    return {
      error: c.json(
        { error: 'No hosted connector authorization provider is configured on this deployment' },
        501,
      ),
    };
  }
  if (!resolved.payload.app) {
    return { error: c.json({ error: 'This connector has no provider app bound' }, 400) };
  }
  const [connector] = await db
    .select({
      connectorId: connectors.connectorId,
      providerType: connectors.providerType,
    })
    .from(connectors)
    .where(
      and(
        eq(connectors.projectId, resolved.projectId),
        eq(connectors.slug, resolved.payload.slug),
      ),
    )
    .limit(1);
  // Provider-neutral, same as the mint route and the /start + /finalize
  // handlers. This check was missed when those were opened up, so a Composio
  // connector produced a link whose own intake page then answered
  // "Connector not found" — the button worked and the modal behind it 404'd.
  if (!connector || (connector.providerType !== 'pipedream' && connector.providerType !== 'composio')) {
    return { error: c.json({ error: 'Connector not found' }, 404) };
  }
  // Links minted before `owner` existed decode without it. Every one of them
  // authorized the caller's own account, so `me` is the faithful default.
  const owner: ConnectorConnectOwner =
    resolved.payload.owner === 'project' ? 'project' : 'me';
  // An `me` link authorizes the member the token was minted for, so it must
  // carry a `uid`. Without one there is nobody to own the resulting connection.
  // The old blanket refusal of every non-`project` STRATEGY is what made private
  // accounts unauthorizable from a session at all.
  if (owner === 'me' && !resolved.payload.uid) {
    return {
      error: c.json(
        {
          error: 'This private connector link names no member to authorize',
          code: 'CONNECTOR_AUTHORIZATION_REQUIRES_MEMBER',
        },
        409,
      ),
    };
  }
  return {
    projectId: resolved.projectId,
    slug: resolved.payload.slug,
    app: resolved.payload.app,
    // Tokens minted before the connector payload carried `sid` decode without
    // it, so this is `undefined` in the wild despite the type — hence `?? null`.
    sid: resolved.payload.sid ?? null,
    uid: resolved.payload.uid ?? null,
    connectorId: connector.connectorId,
    owner,
  };
}

// POST /v1/setup-links/connectors/:token/start — mint a FRESH hosted
// authorization URL from whichever provider backs this connector. Completing on Pipedream's hosted page also fires the connect
// webhook (connectors/pipedream.ts createConnectToken webhook_uri + db-deps
// pipedreamWebhook), but that path is AUXILIARY redundancy only: the client
// polls .../finalize below, which is the authoritative persist + notify path.
setupLinksPublicApp.post('/connectors/:token/start', async (c) => {
  const link = await resolveConnectorLink(c);
  if ('error' in link) return link.error;

  try {
    // The same provider-neutral dep the connector router uses, so Composio and
    // Pipedream reach their hosted page through one path. It also records which
    // session asked, which is what lets finalize below resume that agent.
    // `requestingSessionId` is deliberately NOT passed. The token already carries
    // the session that asked (`link.sid`), and /finalize below notifies from it.
    // Stamping it on the connection too would make `connectorFinalize` notify a
    // second time and hand the agent the same follow-up twice.
    // Imported lazily: this module is the PUBLIC, unauthenticated app, and
    // db-deps pulls in the whole connector + sandbox graph. Loading it at module
    // scope made an unrelated import (`SANDBOX_VERSION`) a hard requirement of
    // every test that mounts these routes.
    const { dbConnectorRouterDeps } = await import('../connectors/db-deps');
    const started = await dbConnectorRouterDeps.connectorConnect?.(
      link.projectId,
      link.slug,
      link.uid ?? '',
      undefined,
      null,
      link.owner,
    );
    if (!started) return c.json({ error: 'This connector has no hosted authorization' }, 404);
    // No url, but connected: either a no-auth toolkit (authorized the moment it
    // is asked for) or a slot whose Composio entity already holds an active
    // account, which start reuses rather than re-authorizing. Both are
    // success. `already_connected` tells the intake page which one, so it can
    // say "Already connected" instead of the old "Could not start the connect
    // flow." false error.
    if (!started.connectUrl) {
      return started.connected
        ? c.json({ connect_url: null, connected: true, already_connected: started.isNoAuth !== true })
        : c.json({ error: 'The provider did not return a connect URL' }, 502);
    }
    // Start the server-side half now the human has a page to complete. Closing
    // the modal kills the browser poll, and without this that is the end of it:
    // the account lands at the provider and the agent is never told.
    watchConnectorCompletion({
      projectId: link.projectId,
      slug: link.slug,
      app: link.app,
      sid: link.sid,
      uid: link.uid,
      owner: link.owner,
    });
    return c.json({ connect_url: started.connectUrl });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Failed to start connect' }, 502);
  }
});

// POST /v1/setup-links/connectors/:token/finalize — the AUTHORITATIVE persist.
//
// The hosted Pipedream page has no callback into us, so the client that opened
// it polls this route. It is the one place that both persists the credential
// and tells the requesting session, because only the token knows which session
// asked for the connector. Idempotent: already-connected returns connected
// WITHOUT re-notifying, so a poll that races the first success can't spam the
// agent with duplicate prompts.
setupLinksPublicApp.post('/connectors/:token/finalize', async (c) => {
  const link = await resolveConnectorLink(c);
  if ('error' in link) return link.error;

  // A `project`-owned link's credential is scoped to the shared row (userId
  // null). A `me`-owned link's is scoped to the member's own row — reusing the
  // shared-row check here would make a private link report "connected" off a
  // completely different account's credential.
  const credentialOwnerId = link.owner === 'project' ? null : link.uid;
  // `connected_as` names who the account was authorized as, so the human
  // sees it on the success screen. This short-circuit makes no provider call,
  // so the identity is unknown here.
  if (await credentialExists(link.connectorId, credentialOwnerId)) {
    return c.json({ connected: true, connected_as: null });
  }

  let connected = false;
  let connectedAs: string | null = null;
  try {
    const { dbConnectorRouterDeps } = await import('../connectors/db-deps');
    const result = await dbConnectorRouterDeps.connectorFinalize?.(
      link.projectId,
      link.slug,
      link.uid ?? '',
      undefined,
      link.owner,
    );
    if (!result) return c.json({ error: 'This connector has no hosted authorization' }, 404);
    connected = result.connected;
    connectedAs = result.connectedAs ?? null;
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Failed to finalize connect' }, 502);
  }
  // Not connected yet is the NORMAL state while the user is still on
  // Pipedream's page — the client keeps polling, so this is 200, not an error.
  if (!connected) return c.json({ connected: false });

  // This route owns the notification for the token flow: the token is the only
  // thing that knows which session minted the link, and /start deliberately
  // leaves `requesting_session_id` unset so this is the single sender.
  if (link.sid) {
    void notifyConnectorSession(link.sid, link.projectId, link.uid, link.slug, link.app);
  }
  return c.json({ connected: true, connected_as: connectedAs });
});

/** Exported for tests. The text delivered to the requesting session's agent. */
export function secretSubmittedPrompt(saved: string[]): string {
  const plural = saved.length === 1 ? 'value' : 'values';
  return (
    `The secret ${plural} for ${saved.join(', ')} ${saved.length === 1 ? 'was' : 'were'} just ` +
    'submitted through the intake link and saved to this project. Sync is in flight — run ' +
    '`kortix secrets sync` if a variable is not visible in your environment yet, then continue ' +
    'the task that was blocked on it. Do not mint a new intake link for these names.'
  );
}

/**
 * Best-effort resolve-on-set: hand the requesting agent a durable follow-up
 * prompt via the session-lifecycle queue (same path as approval-resume), so
 * the loop that minted the link learns the credential arrived instead of
 * re-minting and re-posting a fresh link every run.
 *
 * Gated on `running`: a stopped/hibernated session reads the secret from the
 * store on its next run anyway, and a public, unauthenticated submit must
 * never boot a sandbox. Failures only warn — the secret is already saved and
 * propagated regardless.
 */
async function notifyRequestingSession(
  sessionId: string,
  projectId: string,
  actorUserId: string | null,
  saved: string[],
): Promise<void> {
  try {
    const [session] = await db
      .select({
        status: projectSessions.status,
        accountId: projectSessions.accountId,
        metadata: projectSessions.metadata,
      })
      .from(projectSessions)
      .where(eq(projectSessions.sessionId, sessionId))
      .limit(1);
    if (session?.status !== 'running') return;
    const meta = (session.metadata ?? {}) as Record<string, unknown>;
    if (typeof meta.deletedAt === 'string') return;
    const { enqueueContinueSessionCommand, drainSessionLifecycleQueue } = await import(
      '../projects/session-lifecycle'
    );
    await enqueueContinueSessionCommand({
      source: 'system:secret-submitted',
      projectId,
      accountId: session.accountId,
      sessionId,
      actorUserId,
      text: secretSubmittedPrompt(saved),
    });
    drainSessionLifecycleQueue({ limit: 1 }).catch(() => {});
    console.info('[setup-links] secret submitted, session notified', { sessionId, saved });
  } catch (err) {
    console.warn('[setup-links] failed to notify session of secret submission:', err);
  }
}

export { setupLinksPublicApp };
