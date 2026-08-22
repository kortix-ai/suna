// Agent-scope CRUD — the dashboard surface for the inheritance PYRAMID's first
// step: bind specific secrets + connectors to a specific agent. Writes the
// `[[agents]].env` / `.connectors` allowlists straight into the manifest (same
// git round-trip the connector/policy editors use), so a non-technical admin
// never hand-edits config. The agent's declared scope is what members assigned
// to it (Members → Resource access) inherit.
//
// NOTE: `applyAgentScope` (agents.ts) operates on the `[[agents]]` array shape
// — a legacy v1 kortix.toml manifest. A v2 kortix.yaml's `agents:` map isn't
// an array, so `manifest.raw.agents` here reads as `[]` and this route 404s
// with "agent not found" for v2 projects (see below).
//
// Manager-gated: an agent's scope decides what flows to everyone who inherits
// it, so it's a governance control, not an editor convenience.
//
// `kortix_cli` is intentionally NOT editable here — granting Kortix-CLI powers
// is a sharper escalation; it stays a manifest change.
//
// Second route in this file: POST /:projectId/secrets/:identifier/grant, the
// single-secret widening the secrets page calls. Same authz and manifest
// round-trip; see its own comment for why it is not just a /scope call.

import { createRoute, z } from '@hono/zod-openapi';
import { projectSecrets } from '@kortix/db';
import { GrantSecretToAgentInputSchema, GrantSecretToAgentResultSchema } from '@kortix/api-contract';
import { and, eq, isNull, or } from 'drizzle-orm';
import { auth, errors, json } from '../../openapi';
import { applyAgentScope, extractAgents } from '../agents';
import {
  applyAgentScopeV2,
  grantSecretToAgentV2,
  normalizeRequiredConnectorAliases,
} from '../lib/agent-config-v2';
import { assertProjectCapability, loadProjectForUser } from '../lib/access';
import { projectsApp } from '../lib/app';
import { PROJECT_ACTIONS } from '../../iam';
import { isProjectSessionPrincipal } from '../../iam/agent-scope';
import { db } from '../../shared/db';
import { isValidIdentifier } from '../secrets';
import { commitManifest, loadManifestForEdit } from '../lib/triggers';

// `'all'` = every item the launcher can see; a list = an explicit allowlist;
// `[]` = none. Mirrors the AgentSpec GrantSet.
const GrantSetSchema = z.union([z.literal('all'), z.array(z.string().min(1).max(200)).max(500)]);

const AgentScopeBody = z.object({
  env: GrantSetSchema.optional(),
  connectors: GrantSetSchema.optional(),
  connectors_required: z.array(z.string().trim().min(1).max(200)).max(500).optional(),
  connectors_personal: z.array(z.string().trim().min(1).max(200)).max(500).optional(),
});

projectsApp.openapi(
  createRoute({
    method: 'put',
    path: '/{projectId}/agents/{agentName}/scope',
    tags: ['projects'],
    summary: 'PUT /:projectId/agents/:agentName/scope',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), agentName: z.string() }),
      body: { content: { 'application/json': { schema: AgentScopeBody } } },
    },
    responses: {
      200: json(z.any(), 'Updated agent scope'),
      ...errors(400, 403, 404, 409, 502),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const agentName = c.req.param('agentName');
    // Floor 'read' (membership); the real gate is project.agent.write below.
    // Scoping an agent edits its `[[agents]]` manifest entry (binding its
    // connectors AND secrets), so it's an agent-config edit — agent.write is the
    // precise leaf (a single connector/secret leaf wouldn't cover both). Was
    // 'manage' → project.write, so unchecking agent.write did nothing here.
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_AGENT_WRITE,
    );

    const parsed = AgentScopeBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Invalid body', code: 'invalid_body' }, 400);
    const { env, connectors, connectors_required, connectors_personal } = parsed.data;
    const normalizedRequired = normalizeRequiredConnectorAliases({
      connectors_required,
      connectors_personal,
    });
    if (!normalizedRequired.ok) {
      return c.json({ error: normalizedRequired.error, code: 'invalid_body' }, 400);
    }
    const connectorsRequired = normalizedRequired.block.connectors_required as string[] | undefined;
    if (env === undefined && connectors === undefined && connectorsRequired === undefined) {
      return c.json(
        { error: 'Provide env, connectors and/or connectors_required', code: 'nothing_to_update' },
        400,
      );
    }

    let manifest;
    try {
      manifest = await loadManifestForEdit(loaded.row);
    } catch (e) {
      return c.json(
        { error: (e as Error).message || 'failed to read manifest', code: 'manifest_read' },
        400,
      );
    }

    // The agent must already be declared — this route SCOPES an existing agent,
    // it doesn't create the roster entry (that's the fuller /config editor). v1
    // stores agents as a `[[agents]]` array; v2 (kortix.yaml) as an `agents:`
    // map. The v1-only path treated a v2 map as an empty array, so EVERY scope
    // edit on a YAML project 404'd "agent not found" — branch on the schema.
    if (manifest.schemaVersion >= 2) {
      const applied = applyAgentScopeV2(manifest, agentName, {
        env,
        connectors,
        connectorsRequired,
      });
      if (!applied.ok) {
        return applied.notFound
          ? c.json({ error: applied.error, code: 'agent_not_found' }, 404)
          : c.json({ error: applied.error, code: 'invalid_scope', issues: applied.issues }, 400);
      }
      manifest.raw = applied.raw;
    } else {
      const current = Array.isArray(manifest.raw.agents)
        ? (manifest.raw.agents as Record<string, unknown>[])
        : [];
      if (connectorsRequired !== undefined) {
        return c.json(
          {
            error: 'connectors_required requires a v2 (kortix.yaml) manifest',
            code: 'unsupported_in_v1',
          },
          400,
        );
      }
      const applied = applyAgentScope(current, agentName, { env, connectors }, manifest.path);
      if (!applied.ok) return c.json({ error: applied.error, code: 'agent_not_found' }, 404);
      manifest.raw.agents = applied.agents;
    }

    // Shape-validate through the real parser before committing — a malformed
    // grant set is a clean 400, never a broken manifest.
    const check = extractAgents(manifest);
    const problem = check.errors.find((e) => e.name === agentName);
    if (problem) return c.json({ error: problem.error, code: 'invalid_scope' }, 400);

    const committed = await commitManifest(
      loaded.row,
      manifest,
      `chore: scope agent ${agentName} (secrets/connectors)`,
    );
    if ('error' in committed) {
      return c.json({ error: committed.error }, committed.status as 400 | 409 | 502);
    }

    const spec = check.specs.find((s) => s.name === agentName);
    return c.json({
      ok: true,
      agent: agentName,
      env: spec?.env ?? 'all',
      connectors: spec?.connectors ?? [],
      connectors_required: spec?.connectorsRequired ?? [],
    });
  },
);

// POST /:projectId/secrets/:identifier/grant
//
// The one-click fix behind the secrets page's "No agent can receive this
// secret" warning (`delivery_blocked_reason: 'no_agent_grant'`, see
// `secretDeliveryBlockedReason` in ../lib/serializers.ts). An `egress`/`broker`
// row is delivered ONLY when some agent's `secrets:` list names its identifier
// — `'all'` does not count (../../secrets/strategy.ts) — so before this route
// the warning was a dead end that only a hand-edit of kortix.yaml could clear.
//
// Deliberately narrower than PUT /agents/:agentName/scope above: that route
// REPLACES a grant set and 404s an agent the manifest does not declare, which
// is the wrong shape for "make this one secret reach this one agent". This one
// only widens, and upserts the agent entry when the roster omits it.
//
// Lives in this file because it is the same manifest round-trip as the scope
// route — same authz, same loadManifestForEdit/commitManifest pair.
projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/secrets/{identifier}/grant',
    tags: ['secrets'],
    summary: 'POST /:projectId/secrets/:identifier/grant',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), identifier: z.string() }),
      body: { content: { 'application/json': { schema: GrantSecretToAgentInputSchema } } },
    },
    responses: {
      200: json(GrantSecretToAgentResultSchema, 'Secret granted to the agent'),
      ...errors(400, 403, 404, 409, 502),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const identifierParam = c.req.param('identifier')?.trim();
    if (!identifierParam || !isValidIdentifier(identifierParam)) {
      return c.json({ error: 'Invalid secret identifier', code: 'invalid_identifier' }, 400);
    }
    const parsed = GrantSecretToAgentInputSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Invalid body', code: 'invalid_body' }, 400);
    const agentName = parsed.data.agent;

    // Same gate as the scope route above: membership floor, then agent.write as
    // the precise leaf — this writes the agent's `[[agents]]`/`agents:` entry.
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_AGENT_WRITE,
    );
    // BOTH leaves, because this route straddles two boundaries. Writing the
    // agent entry is `project.agent.write`, but deciding what to write means
    // reading secret metadata, and the secrets list itself is gated on
    // `project.secret.read` (r3.ts). They are separate entries in
    // kortix.role_permissions, so a role can hold one without the other — and with
    // only the write leaf the 404/409/200 split below would answer "does this
    // identifier exist, and is its delivery denied?" for a caller deliberately
    // kept off the secrets surface. Assert the read leaf before the lookup.
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_SECRET_READ,
    );
    // Belt over the central agent-grant fold, which is not enough here: that
    // fold passes an agent session whose grant is NULL (an ungoverned project —
    // `agentMayPerform(null)` is true), and an ungoverned project is exactly the
    // case this route serves. A running session must never widen its own secret
    // grant, so refuse every project-session principal outright.
    if (isProjectSessionPrincipal(c)) {
      return c.json(
        { error: 'Agent sessions cannot grant a secret to an agent', code: 'agent_session_forbidden' },
        403,
      );
    }

    // Scoped to the rows this caller can actually see (shared, plus their own
    // override) — the same slice `loadSecretViewsForUser` builds the secrets
    // page from. Without the owner filter the 404 boundary would answer "does
    // another member hold a private secret under this identifier".
    const rows = await db
      .select({
        identifier: projectSecrets.identifier,
        ownerUserId: projectSecrets.ownerUserId,
        strategy: projectSecrets.strategy,
      })
      .from(projectSecrets)
      .where(
        and(
          eq(projectSecrets.projectId, projectId),
          eq(projectSecrets.identifier, identifierParam),
          or(isNull(projectSecrets.ownerUserId), eq(projectSecrets.ownerUserId, loaded.userId)),
        ),
      );
    // One identifier can carry a shared row AND a per-user override row. The
    // delivery policy the warning is about is the shared row's, exactly as
    // `buildSecretView` (../lib/serializers.ts) reads it — shared first, the
    // personal row only when no shared row exists.
    const target = rows.find((row) => row.ownerUserId === null) ?? rows[0];
    if (!target) return c.json({ error: 'Not found' }, 404);
    const identifier = target.identifier;
    if (target.strategy === 'denied') {
      return c.json(
        {
          error: 'This secret is denied delivery. Change its delivery policy before granting it.',
          code: 'secret_not_grantable',
        },
        409,
      );
    }

    let manifest;
    try {
      manifest = await loadManifestForEdit(loaded.row);
    } catch (e) {
      return c.json(
        { error: (e as Error).message || 'failed to read manifest', code: 'manifest_read' },
        400,
      );
    }

    // What `secrets: all` currently resolves to — the helper writes this out
    // when it has to turn an `'all'` grant into an explicit list. Deliberately
    // NOT owner-filtered like the lookup above: `'all'` covers another member's
    // private override too, and dropping it here would revoke it from the agent.
    // Read unconditionally so the helper stays pure; one indexed SELECT is noise
    // next to the git commit this route performs.
    const projectIdentifiers = (
      await db
        .selectDistinct({ identifier: projectSecrets.identifier })
        .from(projectSecrets)
        .where(eq(projectSecrets.projectId, projectId))
    ).map((row) => row.identifier);

    const applied = grantSecretToAgentV2(manifest, agentName, identifier, projectIdentifiers);
    if (!applied.ok) {
      return applied.unsupportedV1
        ? c.json({ error: applied.error, code: 'manifest_v1_unsupported' }, 400)
        : c.json({ error: applied.error, code: 'invalid_grant', issues: applied.issues }, 400);
    }
    if (applied.alreadyGranted) {
      return c.json({
        identifier,
        agent: agentName,
        already_granted: true,
        adopted_governance: false,
      });
    }
    manifest.raw = applied.raw;

    const committed = await commitManifest(
      loaded.row,
      manifest,
      `chore(agents): grant ${identifier} to ${agentName}`,
    );
    if ('error' in committed) {
      return c.json({ error: committed.error }, committed.status as 400 | 409 | 502);
    }

    return c.json({
      identifier,
      agent: agentName,
      already_granted: false,
      adopted_governance: applied.adoptedGovernance,
    });
  },
);
