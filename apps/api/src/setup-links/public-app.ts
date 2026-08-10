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
import { connectors, projectSessions, projects } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { type Context, Hono, type Next } from 'hono';
import { pipedreamConfigured, pipedreamConnectUrl } from '../connectors/pipedream';
import { propagateWorkspaceSecretsToActiveSandboxes } from '../workspaces/lib/sandbox-env-sync';
import { isValidSecretName, writeSharedWorkspaceSecret } from '../workspaces/secrets';
import { db } from '../shared/db';
import { TokenBucketRateLimiter, enforceRateLimit } from '../shared/rate-limit';
import { resolveSetupLink } from './token';

const setupLinksPublicApp = new Hono();

// Same shape as createPublicSessionShareRateLimitMiddleware (public-session-shares):
// no authenticated identity to key on, so key on the bearer token itself — every
// legitimate use of one link shares that bucket. `ksl_...` is the wire prefix
// minted in ./token.ts; anything not shaped like a real token falls back to the
// client IP so a flood of garbage tokens (each a distinct, never-colliding key)
// can't allocate unbounded rate-limit buckets or dodge the limit entirely.
const TOKEN_LIKE_REGEX = /^ksl_[A-Za-z0-9_-]{8,512}$/;
const setupLinkLimiter = new TokenBucketRateLimiter('setup_link');

function clientIp(c: Context) {
  return c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
    || c.req.header('x-real-ip')
    || 'unknown';
}

function createSetupLinkRateLimitMiddleware() {
  return async (c: Context, next: Next) => {
    const rawToken = c.req.param('token');
    const key = rawToken && TOKEN_LIKE_REGEX.test(rawToken) ? rawToken : `ip:${clientIp(c)}`;
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
        action: `RATE_LIMIT ${c.req.method} ${c.req.path}`,
        resourceType: 'setup_link',
        resourceId,
        metadata: { limiter: 'setup_link' },
      },
    );
    if (denied) return denied;
    await next();
  };
}

async function projectName(workspaceId: string): Promise<string> {
  const [row] = await db
    .select({ name: projects.name })
    .from(projects)
    .where(eq(projects.workspaceId, workspaceId))
    .limit(1);
  return row?.name ?? 'this project';
}

setupLinksPublicApp.use('/secret/:token', createSetupLinkRateLimitMiddleware());
setupLinksPublicApp.use('/connectors/:token', createSetupLinkRateLimitMiddleware());
setupLinksPublicApp.use('/connectors/:token/start', createSetupLinkRateLimitMiddleware());

// GET /v1/setup-links/secret/:token — what fields does this link ask for?
setupLinksPublicApp.get('/secret/:token', async (c) => {
  const resolved = resolveSetupLink(c.req.param('token'));
  if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status);
  if (resolved.payload.kind !== 'secret') return c.json({ error: 'Wrong link type' }, 400);

  return c.json({
    kind: 'secret',
    project_name: await projectName(resolved.workspaceId),
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
    await writeSharedWorkspaceSecret({
      workspaceId: resolved.workspaceId,
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
  void propagateWorkspaceSecretsToActiveSandboxes(resolved.workspaceId);

  // Notify the requesting session that the secret was submitted, so the agent
  // can immediately retry whatever needed the credential instead of re-minting
  // a link on its next loop run. The session ID is sealed into the token at
  // mint time (setup-links.ts passes c.get('sessionId')).
  const sid = (resolved.payload as { sid?: string | null }).sid;
  if (sid) {
    void notifyRequestingSession(sid, resolved.workspaceId, resolved.payload.uid, saved);
  }

  return c.json({ ok: true, saved });
});

// GET /v1/setup-links/connectors/:token — which app does this link connect?
setupLinksPublicApp.get('/connectors/:token', async (c) => {
  const resolved = resolveSetupLink(c.req.param('token'));
  if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status);
  if (resolved.payload.kind !== 'connector') return c.json({ error: 'Wrong link type' }, 400);

  return c.json({
    kind: 'connector',
    project_name: await projectName(resolved.workspaceId),
    slug: resolved.payload.slug,
    app: resolved.payload.app,
    expires_at: new Date(resolved.payload.exp).toISOString(),
  });
});

// POST /v1/setup-links/connectors/:token/start — mint a FRESH Pipedream Quick
// Connect URL. Completing on Pipedream's hosted page fires the connect webhook,
// which persists the credential (see connector/pipedream.ts createConnectToken
// webhook_uri + db-deps pipedreamWebhook), so no explicit finalize is needed.
setupLinksPublicApp.post('/connectors/:token/start', async (c) => {
  const resolved = resolveSetupLink(c.req.param('token'));
  if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status);
  if (resolved.payload.kind !== 'connector') return c.json({ error: 'Wrong link type' }, 400);
  if (!pipedreamConfigured()) return c.json({ error: 'Pipedream is not configured on this deployment' }, 501);
  if (!resolved.payload.app) return c.json({ error: 'This connector has no Pipedream app bound' }, 400);
  const [connector] = await db
    .select({
      providerType: connectors.providerType,
      authorizationStrategy: connectors.authorizationStrategy,
    })
    .from(connectors)
    .where(
      and(
        eq(connectors.workspaceId, resolved.workspaceId),
        eq(connectors.slug, resolved.payload.slug),
      ),
    )
    .limit(1);
  if (!connector || connector.providerType !== 'pipedream') {
    return c.json({ error: 'Connector not found' }, 404);
  }
  if (connector.authorizationStrategy !== 'project') {
    return c.json(
      {
        error: 'Shared connect links require a project authorization strategy',
        code: 'CONNECTOR_AUTHORIZATION_STRATEGY_MISMATCH',
      },
      409,
    );
  }

  try {
    const { connectUrl } = await pipedreamConnectUrl(
      resolved.workspaceId,
      resolved.payload.slug,
      resolved.payload.app,
      null,
    );
    if (!connectUrl) return c.json({ error: 'Pipedream did not return a connect URL' }, 502);
    return c.json({ connect_url: connectUrl });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Failed to start connect' }, 502);
  }
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
  workspaceId: string,
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
      '../workspaces/session-lifecycle'
    );
    await enqueueContinueSessionCommand({
      source: 'system:secret-submitted',
      workspaceId,
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
