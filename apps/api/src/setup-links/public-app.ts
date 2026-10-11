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
import { createHash, randomUUID } from 'node:crypto';
import { requestClientKey } from '../middleware/client-ip';
import { connectorConnections, connectors, projectSecrets, projectSessions, projects } from '@kortix/db';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { createRoute, z } from '@hono/zod-openapi';
import { type Context, type Next } from 'hono';
import { errors, json, lenientBody, makeOpenApiApp } from '../openapi';
import { connectorAccountLandedSince, credentialExists } from '../connectors/credentials';
import {
  pipedreamConfigured,
} from '../connectors/pipedream';
import type { ConnectorConnectOwner } from '../projects/lib/connection-access';
import { propagateProjectSecretsToActiveSandboxes } from '../projects/lib/sandbox-env-sync';
import {
  sessionWithheldSecrets,
  withheldSecretsFix,
  type SessionWithheldSecrets,
} from '../projects/lib/session-secret-reach';
import { isValidSecretName, projectSecretsDeletedSince, writeSharedProjectSecret } from '../projects/secrets';
import { clearSecretAudience, setSecretAudience } from '../projects/lib/secret-audience';
import { resolveUserIdentities } from '../projects/lib/user-identity';
import { db, withDbTransaction } from '../shared/db';
import { projectAccountMembershipRows } from '../iam/membership-read';
import { TokenBucketRateLimiter } from '../shared/rate-limit';
import { enforceRateLimit } from '../middleware/rate-limit';
import { RATE_LIMIT_EXCEEDED_ACTION } from '../shared/rate-limit-audit';
import { resolveSetupLink } from './token';
import { watchConnectorCompletion } from './connector-completion-watch';
import { composioConfigured, composioToolkitLogo } from '../connectors/composio';
import { connectorConnectedPrompt, notifyConnectorSession } from '../connectors/notify-session';
import { readJsonObject } from '../shared/http-body';

// The connector half of the notification moved to connectors/notify-session.ts so the
// in-session Connect button's finalize can reuse it. Re-exported: this module is where
// the prompt text has always been asserted from.
export { connectorConnectedPrompt };

const setupLinksPublicApp = makeOpenApiApp();

// Unauthenticated on purpose: the token in the path IS the capability.
const TokenParams = z.object({ token: z.string() });
const LinkErrors = errors(400, 404, 410);
/** Statuses a SECRET link adds to a link error: the link can also name a
 *  secret the owner removed after the token was minted (409 — see the
 *  tombstone check in the two secret routes). */
const SecretLinkErrors = errors(400, 404, 409, 410);
/** Statuses `resolveConnectorLink` adds to a link error. */
const ConnectorLinkErrors = errors(400, 404, 409, 410, 501, 502);

const SecretLinkSchema = z.object({
  kind: z.literal('secret'),
  project_name: z.string(),
  requester: z.object({ label: z.string().nullable() }).nullable(),
  fields: z.array(
    z.object({ name: z.string(), label: z.string().nullable(), description: z.string().nullable() }),
  ),
  expires_at: z.string(),
});

const SecretLinkSubmitSchema = z.object({
  ok: z.literal(true),
  saved: z.array(z.string()),
  /** Set when the requesting agent cannot receive every saved value. */
  agent: z.string().optional(),
  withheld: z.array(z.object({ name: z.string(), reason: z.string() })).optional(),
});

const ConnectorLinkSchema = z.object({
  kind: z.literal('connector'),
  project_id: z.string(),
  project_name: z.string(),
  label: z.string().nullable(),
  owner: z.enum(['me', 'project']),
  slug: z.string(),
  app: z.string().nullable(),
  name: z.string().nullable(),
  icon_url: z.string().nullable(),
  /** Omitted for a token minted before `iat` existed. */
  connected: z.boolean().optional(),
  expires_at: z.string(),
});

const ConnectorStartSchema = z.object({
  connect_url: z.string().nullable(),
  connected: z.boolean().optional(),
  already_connected: z.boolean().optional(),
});

const ConnectorFinalizeSchema = z.object({
  connected: z.boolean(),
  connected_as: z.string().nullable().optional(),
  connection_id: z.string().optional(),
  label: z.string().nullable().optional(),
});

// Same shape as createPublicSessionShareRateLimitMiddleware (public-session-shares):
// no authenticated identity to key on, so key on the bearer token itself — every
// legitimate use of one link shares that bucket. `ksl_...` is the wire prefix
// minted in ./token.ts; anything not shaped like a real token falls back to the
// client IP so a flood of garbage tokens (each a distinct, never-colliding key)
// can't allocate unbounded rate-limit buckets or dodge the limit entirely.
const TOKEN_LIKE_REGEX = /^ksl_[A-Za-z0-9_-]{8,512}$/;
// replica-local: limit × API replicas (shared/rate-limit.ts).
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

/**
 * The person whose session minted this link, when they belong to the project's
 * account — the one principal an anonymous link holder may keep the values to.
 * Their display name only: the link page is public, so never their email.
 */
async function linkRequester(
  projectId: string,
  uid: string | null | undefined,
): Promise<{ id: string; label: string | null } | null> {
  if (!uid) return null;
  // Optional: a failed lookup offers no "only the person who asked" choice
  // rather than breaking the link page.
  try {
    return await lookupLinkRequester(projectId, uid);
  } catch {
    return null;
  }
}

async function lookupLinkRequester(projectId: string, uid: string): Promise<{ id: string; label: string | null } | null> {
  const result = await projectAccountMembershipRows(projectId, uid);
  const rows = (result as unknown as { rows?: Array<{ found: number }> }).rows ?? result;
  if ((rows as Array<{ found: number }>).length === 0) return null;
  const identity = (await resolveUserIdentities([uid])).get(uid);
  return { id: uid, label: identity?.displayName ?? null };
}

async function projectAccount(projectId: string): Promise<string | null> {
  const [row] = await db
    .select({ accountId: projects.accountId })
    .from(projects)
    .where(eq(projects.projectId, projectId))
    .limit(1);
  return row?.accountId ?? null;
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

/**
 * The one message a link whose target secret was removed after minting
 * answers with, on the intake page (GET) and on the submit (POST): what
 * happened, which secret, and the way out. 409, not 410: the link itself did
 * not expire — the state it pointed at did, and only a fresh link fixes it.
 */
function deadSecretLinkMessage(names: string[]): string {
  const list = names.join(', ');
  const was = names.length === 1 ? 'was' : 'were';
  return `This link is no longer valid: ${list} ${was} removed from the project after the link was issued. Ask the agent for a fresh link.`;
}

// GET /v1/setup-links/secret/:token — what fields does this link ask for?
setupLinksPublicApp.openapi(createRoute({
  method: 'get',
  path: '/secret/{token}',
  tags: ['setup-links'],
  summary: 'Read what a secret setup link asks for',
  request: { params: TokenParams },
  responses: { 200: json(SecretLinkSchema, 'The requested fields'), ...SecretLinkErrors },
}), async (c) => {
  const resolved = resolveSetupLink(c.req.param('token'));
  if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status);
  if (resolved.payload.kind !== 'secret') return c.json({ error: 'Wrong link type' }, 400);

  const [project] = await db.select({ name: projects.name, status: projects.status })
    .from(projects).where(eq(projects.projectId, resolved.projectId)).limit(1);
  if (!project || project.status === 'archived') {
    return c.json({ error: 'This link is unavailable' }, 404);
  }
  // A secret the owner removed after this token was minted must not look
  // collectable: the form would take values the submit then has to refuse.
  // Tokens minted before `iat` carry no mint time, so 0 — any deletion of a
  // requested name kills them (an unknown mint time is the oldest possible).
  const dead = await projectSecretsDeletedSince(
    resolved.projectId,
    resolved.payload.fields.map((f) => f.name),
    resolved.payload.iat ?? 0,
  );
  if (dead.length > 0) return c.json({ error: deadSecretLinkMessage(dead) }, 409);

  const requester = await linkRequester(resolved.projectId, resolved.payload.uid);
  return c.json({
    kind: 'secret' as const,
    project_name: project.name,
    requester: requester ? { label: requester.label } : null,
    fields: resolved.payload.fields.map((f) => ({
      name: f.name,
      label: f.label ?? null,
      description: f.description ?? null,
    })),
    expires_at: new Date(resolved.payload.exp).toISOString(),
  });
});

// POST /v1/setup-links/secret/:token — { values: { NAME: value } }
setupLinksPublicApp.openapi(createRoute({
  method: 'post',
  path: '/secret/{token}',
  tags: ['setup-links'],
  summary: 'Submit the values a secret setup link asks for',
  request: {
    params: TokenParams,
    body: { content: { 'application/json': { schema: lenientBody({
      values: z.record(z.string(), z.string()).openapi({ description: 'Values keyed by secret name.' }),
      only_requester: z.boolean().optional().openapi({ description: 'Keep the values to the member who asked.' }),
    }) } } },
  },
  responses: { 200: json(SecretLinkSubmitSchema, 'Saved'), ...SecretLinkErrors },
}), async (c) => {
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
  const payload = resolved.payload;
  const result = await withDbTransaction(async () => {
    // The archive UPDATE takes the same row lock: either all values commit
    // before deletion, or this submission sees archived and writes nothing.
    const [project] = await db.select({ status: projects.status }).from(projects)
      .where(eq(projects.projectId, resolved.projectId)).limit(1).for('update');
    if (!project || project.status === 'archived') {
      return c.json({ error: 'This link is unavailable' }, 404);
    }
    // Same tombstone check as the page, now inside the write transaction and
    // after the same project-row lock: either this submission commits before
    // an unset deletes the row, or the unset's tombstone is already visible
    // here and the submission is refused. A link can never re-create what the
    // owner removed after minting it (KRTX-2056).
    const dead = await projectSecretsDeletedSince(
      resolved.projectId,
      payload.fields.map((f) => f.name),
      payload.iat ?? 0,
    );
    if (dead.length > 0) return c.json({ error: deadSecretLinkMessage(dead) }, 409);
    // "Only the person who asked" — the one audience a link holder may choose.
    // It can only narrow: the default is everyone in the project.
    // The minter must still be in the account: a removed member's links die with them.
    if (payload.uid && !(await linkRequester(resolved.projectId, payload.uid))) {
      return c.json({ error: 'This link is no longer valid — ask the agent for a fresh one' }, 410);
    }
    const requester = body?.only_requester === true ? await linkRequester(resolved.projectId, payload.uid) : null;
    if (body?.only_requester === true && !requester) {
      return c.json({ error: 'This link cannot keep the values to one person' }, 400);
    }
    const accountId = requester ? await projectAccount(resolved.projectId) : null;

    // Single use per key, without a table: a key written after the link was
    // minted is spent. The shared (non-personal) row's updated_at is the marker.
    const mintedAt = new Date(payload.iat ?? payload.exp - 7 * 24 * 60 * 60_000);
    let spent = 0;
    const saved: string[] = [];
    for (const [rawName, rawValue] of Object.entries(values)) {
      const name = rawName.toUpperCase();
      // Value-only: silently ignore anything the token didn't ask for, and never
      // let a leaked token write to a key it doesn't name.
      if (!allowed.has(name) || !isValidSecretName(name)) continue;
      const value = typeof rawValue === 'string' ? rawValue : '';
      if (!value) continue;
      const [written] = await db.select({ id: projectSecrets.secretId }).from(projectSecrets)
        .where(and(
          eq(projectSecrets.projectId, resolved.projectId),
          eq(projectSecrets.identifier, name),
          isNull(projectSecrets.ownerUserId),
          gt(projectSecrets.updatedAt, mintedAt),
        )).limit(1);
      if (written) { spent++; continue; }
      const audience =
        requester && accountId
          ? { accountId, projectId: resolved.projectId, principals: [{ principal_type: 'user' as const, principal_id: requester.id }], grantedBy: requester.id }
          : null;
      // Audience first, under the id a NEW row will get (secret-audience.ts).
      const pendingId = audience ? randomUUID() : undefined;
      if (audience && pendingId) await setSecretAudience({ ...audience, secretId: pendingId, pending: true });
      const secretId = await writeSharedProjectSecret({
        projectId: resolved.projectId,
        name,
        value,
        scope: payload.scope,
        createdBy: payload.uid,
        ...(pendingId ? { secretId: pendingId } : {}),
      });
      if (audience && pendingId && secretId !== pendingId) {
        // The key already existed: drop the pending grants. A link never narrows an existing row's audience.
        await clearSecretAudience({ accountId: audience.accountId, projectId: audience.projectId, secretId: pendingId });
      }
      saved.push(name);
    }

    if (saved.length === 0) {
      if (spent > 0) return c.json({ error: 'This link was already used — ask the agent for a fresh one' }, 409);
      return c.json({ error: 'No values provided for the requested keys' }, 400);
    }

    return saved;
  });
  if (result instanceof Response) return result as never;
  const saved = result;

  // Live-propagate so an active session sees the new value without a restart.
  void propagateProjectSecretsToActiveSandboxes(resolved.projectId);

  // Notify the requesting session that the secret was submitted, so the agent
  // can immediately retry whatever needed the credential instead of re-minting
  // a link on its next loop run. The session ID is sealed into the token at
  // mint time (setup-links.ts passes c.get('sessionId')).
  const sid = (resolved.payload as { sid?: string | null }).sid;
  const reach = sid && resolved.payload.scope === 'runtime' ? await sessionWithheldSecrets(sid, saved) : null;
  if (sid) {
    void notifyRequestingSession(sid, resolved.projectId, resolved.payload.uid, saved, reach);
  }

  // A saved value the requesting agent cannot receive is the one outcome the
  // human must act on, and this form is the only moment they are here.
  return c.json({ ok: true as const, saved, ...(reach ? { agent: reach.agent, withheld: reach.withheld } : {}) });
});

// GET /v1/setup-links/connectors/:token — which app does this link connect?
setupLinksPublicApp.openapi(createRoute({
  method: 'get',
  path: '/connectors/{token}',
  tags: ['setup-links'],
  summary: 'Read which app a connector setup link connects',
  request: { params: TokenParams },
  responses: { 200: json(ConnectorLinkSchema, 'The connector'), ...LinkErrors },
}), async (c) => {
  const resolved = resolveSetupLink(c.req.param('token'));
  if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status);
  if (resolved.payload.kind !== 'connector') return c.json({ error: 'Wrong link type' }, 400);

  const [name, identity] = await Promise.all([
    projectName(resolved.projectId),
    connectorIdentity(resolved.projectId, resolved.payload.slug, resolved.payload.app),
  ]);
  // Whether the account this link asked for has landed, so a card that is
  // reloaded stays settled instead of asking again. Omitted for a token minted
  // before `iat`: there is no moment to measure from, and the card keeps its
  // own answer. Never "a credential exists" — a link adds an account even when
  // the connector already has one.
  const { iat, uid } = resolved.payload;
  const connected =
    typeof iat !== 'number'
      ? undefined
      : identity.connectorId
        ? await connectorAccountLandedSince(identity.connectorId, uid, new Date(iat))
        : false;
  return c.json({
    kind: 'connector' as const,
    // The in-app dialog creates the account through the project's own routes,
    // as the signed-in member, so it needs the project the link belongs to.
    project_id: resolved.projectId,
    project_name: name,
    // The agent's suggested name for a new account, or null.
    label: resolved.payload.label ?? null,
    // Whose account the agent meant; the dialog preselects it. Older tokens: `me`.
    owner: resolved.payload.owner === 'project' ? ('project' as const) : ('me' as const),
    slug: resolved.payload.slug,
    app: resolved.payload.app,
    name: identity.name,
    icon_url: identity.iconUrl,
    ...(connected === undefined ? {} : { connected }),
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
): Promise<{ connectorId: string | null; name: string | null; iconUrl: string | null }> {
  const [row] = await db
    .select({ connectorId: connectors.connectorId, name: connectors.name, config: connectors.config })
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
  return { connectorId: row?.connectorId ?? null, name: row?.name ?? null, iconUrl };
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
setupLinksPublicApp.openapi(createRoute({
  method: 'post',
  path: '/connectors/{token}/start',
  tags: ['setup-links'],
  summary: 'Mint a hosted authorization URL for a connector setup link',
  request: { params: TokenParams },
  responses: { 200: json(ConnectorStartSchema, 'The URL, or already connected'), ...ConnectorLinkErrors },
}), async (c) => {
  const link = await resolveConnectorLink(c);
  if ('error' in link) return link.error as never;

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
setupLinksPublicApp.openapi(createRoute({
  method: 'post',
  path: '/connectors/{token}/finalize',
  tags: ['setup-links'],
  summary: 'Record the account a connector setup link connected',
  request: {
    params: TokenParams,
    body: { content: { 'application/json': { schema: lenientBody({
      connection_id: z.string().optional().openapi({ description: 'The named account the dialog created.' }),
    }) } } },
  },
  responses: { 200: json(ConnectorFinalizeSchema, 'Whether the account is connected'), ...ConnectorLinkErrors, ...errors(403) },
}), async (c) => {
  const link = await resolveConnectorLink(c);
  if ('error' in link) return link.error as never;

  // The in-app dialog creates a NEW named account through the project's own
  // routes and then names it here, so the session is told about THAT account.
  const body = await readJsonObject(c);
  if (body.connection_id !== undefined) {
    if (typeof body.connection_id !== 'string' || !body.connection_id) {
      return c.json({ error: 'connection_id must be a string' }, 400);
    }
    return finalizeNamedAccount(c, link, body.connection_id);
  }

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

/**
 * Finalize ONE named account a link's dialog created, and tell the requesting
 * session its name. The account must be on this link's project and connector;
 * a private one must belong to the member the link was minted for, the only
 * member whose session can run as it.
 */
async function finalizeNamedAccount(
  c: Context,
  link: Exclude<Awaited<ReturnType<typeof resolveConnectorLink>>, { error: Response }>,
  connectionId: string,
) {
  const [account] = await db
    .select({
      connectionId: connectorConnections.connectionId,
      projectId: connectorConnections.projectId,
      connectorId: connectorConnections.connectorId,
      ownerType: connectorConnections.ownerType,
      ownerId: connectorConnections.ownerId,
      label: connectorConnections.label,
    })
    .from(connectorConnections)
    .where(eq(connectorConnections.connectionId, connectionId))
    .limit(1);
  if (!account || account.projectId !== link.projectId || account.connectorId !== link.connectorId) {
    return c.json({ error: 'Connection not found' }, 404);
  }
  if (account.ownerType !== 'project' && (account.ownerType !== 'member' || account.ownerId !== link.uid)) {
    return c.json({ error: 'This account is not the requesting member\'s' }, 403);
  }

  let connected = false;
  let connectedAs: string | null = null;
  try {
    const { dbConnectorRouterDeps } = await import('../connectors/db-deps');
    const result = await dbConnectorRouterDeps.connectorFinalize?.(
      link.projectId,
      link.slug,
      link.uid ?? '',
      { connectionId: account.connectionId },
      account.ownerType === 'project' ? 'project' : 'me',
    );
    if (!result) return c.json({ error: 'This connector has no hosted authorization' }, 404);
    connected = result.connected;
    connectedAs = result.connectedAs ?? null;
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Failed to finalize connect' }, 502);
  }
  if (!connected) return c.json({ connected: false }, 200);

  if (link.sid) {
    void notifyConnectorSession(link.sid, link.projectId, link.uid, link.slug, link.app, {
      connectionId: account.connectionId,
      label: account.label,
    });
  }
  return c.json({
    connected: true,
    connected_as: connectedAs,
    connection_id: account.connectionId,
    label: account.label,
  }, 200);
}

/** Exported for tests. The text delivered to the requesting session's agent. */
export function secretSubmittedPrompt(
  saved: string[],
  reach?: SessionWithheldSecrets | null,
): string {
  const plural = saved.length === 1 ? 'value' : 'values';
  const text =
    `The secret ${plural} for ${saved.join(', ')} ${saved.length === 1 ? 'was' : 'were'} just ` +
    'submitted through the intake link and saved to this project. Sync is in flight — run ' +
    '`kortix secrets sync` if a variable is not visible in your environment yet, then continue ' +
    'the task that was blocked on it. Do not mint a new intake link for these names.';
  if (!reach || reach.withheld.length === 0) return text;
  return (
    `${text} ${withheldSecretsFix(reach.agent, reach.withheld)} ` +
    'Do not report these secrets as unset: the value is saved. Tell the human this exact fix.'
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
  reach: SessionWithheldSecrets | null,
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
    // A key per submission only so the kick can target this row: an untargeted
    // kick delivers whichever row is oldest-due.
    const idempotencyKey = `secret-submitted:${sessionId}:${crypto.randomUUID()}`;
    await enqueueContinueSessionCommand({
      source: 'system:secret-submitted',
      projectId,
      accountId: session.accountId,
      sessionId,
      actorUserId,
      text: secretSubmittedPrompt(saved, reach),
      idempotencyKey,
    });
    drainSessionLifecycleQueue({ idempotencyKey, burst: false }).catch(() => {});
    console.info('[setup-links] secret submitted, session notified', { sessionId, saved });
  } catch (err) {
    console.warn('[setup-links] failed to notify session of secret submission:', err);
  }
}

export { setupLinksPublicApp };
