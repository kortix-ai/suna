/**
 * Agent-minted SETUP LINKS — the authenticated half.
 *
 * The in-sandbox agent (its `KORTIX_TOKEN` is a
 * session-scoped PAT, accepted by supabaseAuth) calls these to mint a
 * short-lived link it can hand to a human to (a) enter a project secret value,
 * or (b) 1-click connect a Pipedream app.
 * The link itself is resolved/submitted by the PUBLIC app at /v1/setup-links/*.
 *
 * See ../../setup-links/token.ts for the stateless token model and
 * .kortix/opencode/skills/kortix-system/references/kortix/credentials-and-setup-links.md
 * for the agent-facing flow.
 */
import { auth, errors, json } from '../../openapi';
import { config } from '../../config';
import { createRoute, z } from '@hono/zod-openapi';
import { connectLinkEligibility } from '../../connectors/db-deps';
import { pipedreamConfigured } from '../../connectors/pipedream';
import { composioConfigured } from '../../connectors/composio';
import { mintSetupLink, type SecretFieldSpec } from '../../setup-links/token';
import { isValidSecretName } from '../secrets';
import { sessionWithheldSecrets, withheldSecretsFix } from '../lib/session-secret-reach';
import { assertProjectCapability, loadProjectForUser, projectCapabilityAllowed } from '../lib/access';
import { AnyObject, projectsApp } from '../lib/app';
import { parseConnectorConnectOwner } from '../lib/connection-access';
import { PROJECT_ACTIONS } from '../../iam';
import { CODEX_AUTH_JSON_SECRET_NAME, normalizeString } from '../lib/serializers';
import { readJsonObject } from '../../shared/http-body';

function frontendBase(): string {
  return (config.FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/, '');
}

// POST /v1/projects/:projectId/secret-requests
// Mint a link the human opens to enter one or more secret VALUES. The agent
// never sees the value — only the names it requested. Requires manage (the
// same gate as POST /secrets).
projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/secret-requests',
    tags: ['secrets'],
    summary: 'POST /:projectId/secret-requests — mint a secret-entry link',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: {
      200: json(z.any(), 'A secret-entry link'),
      ...errors(400, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const body = await readJsonObject(c);
    // Floor 'read'; project.secret.write is the real gate — the same leaf as
    // POST /secrets. Was 'manage' → project.write, so unchecking secret.write
    // did nothing here.
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_SECRET_WRITE);

    // Accept `names: [...]` or a single `name`.
    const rawNames: unknown[] = Array.isArray(body.names)
      ? body.names
      : body.name != null
        ? [body.name]
        : [];
    const names = rawNames
      .map((n) => normalizeString(n)?.toUpperCase())
      .filter((n): n is string => !!n);
    if (names.length === 0) return c.json({ error: 'names is required (one or more env var names)' }, 400);

    const labels = (body.labels ?? {}) as Record<string, unknown>;
    const descriptions = (body.descriptions ?? {}) as Record<string, unknown>;

    const fields: SecretFieldSpec[] = [];
    const seen = new Set<string>();
    for (const name of names) {
      if (seen.has(name)) continue;
      seen.add(name);
      if (!isValidSecretName(name)) {
        return c.json({ error: `"${name}" is not a valid env var name (A-Z, 0-9, _; max 64 chars)` }, 400);
      }
      if (name.startsWith('KORTIX_')) {
        return c.json({ error: 'KORTIX_* names are reserved for platform/runtime-managed variables' }, 400);
      }
      if (name === CODEX_AUTH_JSON_SECRET_NAME) {
        return c.json({ error: `${CODEX_AUTH_JSON_SECRET_NAME} is managed by ChatGPT subscription onboarding` }, 400);
      }
      fields.push({
        name,
        label: normalizeString(labels[name]) ?? undefined,
        description: normalizeString(descriptions[name]) ?? undefined,
      });
    }

    const requestedScope = normalizeString(body.scope);
    if (requestedScope && requestedScope !== 'runtime' && requestedScope !== 'connector') {
      return c.json({ error: 'scope must be "runtime" or "connector"' }, 400);
    }
    // Setup links are commonly minted by connector tooling. Omission must not
    // turn a server-side credential into plaintext sandbox environment state.
    // Runtime delivery remains available only through an explicit opt-in.
    const scope = requestedScope === 'runtime' ? 'runtime' : 'connector';
    const sessionId = (c.get('sessionId') as string | undefined) ?? null;
    const { token, expiresAt } = mintSetupLink(
      projectId,
      { kind: 'secret', fields, scope, uid: loaded.userId, sid: sessionId },
      { expiresInMinutes: typeof body.expires_in_minutes === 'number' ? body.expires_in_minutes : undefined },
    );

    // A runtime value this session's agent is not granted is saved and then
    // never delivered. Say so now, while the agent can still tell the human the
    // one extra step, instead of after they fill the form and nothing arrives.
    // Only names the agent itself just requested are judged, against its own
    // grant, so this reveals nothing about which secrets exist.
    const requested = fields.map((f) => f.name);
    const reach = scope === 'runtime' && sessionId ? await sessionWithheldSecrets(sessionId, requested) : null;

    return c.json({
      kind: 'secret',
      url: `${frontendBase()}/secret-intake/${token}`,
      names: requested,
      scope,
      expires_at: new Date(expiresAt).toISOString(),
      ...(reach
        ? {
            agent: reach.agent,
            withheld: reach.withheld,
            withheld_fix: withheldSecretsFix(reach.agent, reach.withheld),
          }
        : {}),
    });
  },
);

// POST /v1/projects/:projectId/connect-requests
// Mint a link the human opens to 1-click connect a Pipedream app (Quick
// Connect). Requires manage. The link is durable for its TTL; the public page
// mints a FRESH Pipedream connect token each time it's opened so it never
// hands out a stale (minutes-old) Pipedream token.
projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/connect-requests',
    tags: ['connectors'],
    summary: 'POST /:projectId/connect-requests — mint a Pipedream Quick Connect link',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: {
      200: json(z.any(), 'A connect link'),
      ...errors(400, 404, 409, 501),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const body = await readJsonObject(c);
    // Floor 'read'; project.connector.write is the real gate (minting a Pipedream
    // Quick Connect link is a connector operation). Was 'manage' → project.write.
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE);

    // Provider-neutral: a setup link is a hosted authorization page, and both
    // Composio and Pipedream have one. Gating on Pipedream alone is what sent a
    // Composio connector down the fallback path where the agent pastes a raw
    // provider URL into chat — losing the button, the modal and the resume.
    if (!composioConfigured() && !pipedreamConfigured()) {
      return c.json(
        { error: 'No hosted connector authorization provider is configured on this deployment' },
        501,
      );
    }

    const slug = normalizeString(body.slug);
    if (!slug) return c.json({ error: 'slug is required' }, 400);

    const eligibility = await connectLinkEligibility(projectId, slug);
    if (!eligibility.ok) {
      // Each reason has a different person and a different fix behind it, and
      // the old single message named the wrong one for two of the three.
      if (eligibility.reason === 'unsupported_provider') {
        return c.json(
          {
            error:
              `"${slug}" is a ${eligibility.providerType} connector, and setup links are hosted ` +
              'authorization pages, which only Composio and Pipedream connectors have. It is ' +
              'already on this project — connect it the way that provider is connected rather ' +
              'than adding it to kortix.yaml again.',
            code: 'CONNECTOR_PROVIDER_UNSUPPORTED',
          },
          409,
        );
      }
      if (eligibility.reason === 'no_app') {
        return c.json(
          {
            error: `"${slug}" is a connector on this project but names no provider app, so no connect link can be built for it.`,
            code: 'CONNECTOR_PIPEDREAM_APP_MISSING',
          },
          409,
        );
      }
      return c.json(
        { error: `"${slug}" is not a connector on this project. Add it to kortix.yaml first.` },
        404,
      );
    }
    const conn = eligibility;
    // WHOSE account the link authorizes is the caller's explicit choice, never
    // derived from the connector (see projects/lib/connection-access.ts) — the
    // old `authorizationStrategy==='user'` branch this replaced is what left a
    // private-only connector with no connect flow anywhere in the product.
    const owner = parseConnectorConnectOwner(body.owner);
    if (!owner) return c.json({ error: 'owner must be "me" or "project"' }, 400);
    // `me` authorizes the caller themselves and needs no member id beyond the
    // signed-in caller already asserted above (loaded.userId).
    if (owner === 'me' && !loaded.userId) {
      return c.json(
        {
          error: 'A private connector link can only be minted for a signed-in member',
          code: 'CONNECTOR_AUTHORIZATION_REQUIRES_MEMBER',
        },
        409,
      );
    }
    // Minting a link that authorizes the SHARED account is administration —
    // the same capability the project-owned connection create (connections.ts) asserts
    // (PROJECT_CONNECTOR_CONNECTIONS_MANAGE), not just connector.write.
    if (owner === 'project') {
      const mayManage = await projectCapabilityAllowed(
        c,
        loaded.userId,
        loaded.row.accountId,
        projectId,
        PROJECT_ACTIONS.PROJECT_CONNECTOR_CONNECTIONS_MANAGE,
      );
      if (!mayManage) return c.json({ error: 'Forbidden' }, 403);
    }

    const { token, expiresAt } = mintSetupLink(
      projectId,
      {
        kind: 'connector',
        slug,
        app: conn.app,
        uid: loaded.userId,
        sid: (c.get('sessionId') as string | undefined) ?? null,
        owner,
      },
      { expiresInMinutes: typeof body.expires_in_minutes === 'number' ? body.expires_in_minutes : undefined },
    );

    return c.json({
      kind: 'connector',
      url: `${frontendBase()}/connect/${token}`,
      slug,
      app: conn.app,
      owner,
      expires_at: new Date(expiresAt).toISOString(),
    });
  },
);
