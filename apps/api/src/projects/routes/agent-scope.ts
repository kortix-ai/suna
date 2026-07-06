// Agent-scope CRUD — the dashboard surface for the inheritance PYRAMID's first
// step: bind specific secrets + connectors to a specific agent. Writes the
// `[[agents]].env` / `.connectors` allowlists straight into kortix.toml (same
// git round-trip the connector/policy editors use), so a non-technical admin
// never hand-edits config. The agent's declared scope is what members assigned
// to it (Members → Resource access) inherit.
//
// Manager-gated: an agent's scope decides what flows to everyone who inherits
// it, so it's a governance control, not an editor convenience.
//
// `kortix_cli` is intentionally NOT editable here — granting Kortix-CLI powers
// is a sharper escalation; it stays a kortix.toml change.

import { createRoute, z } from '@hono/zod-openapi';
import { auth, errors, json } from '../../openapi';
import { applyAgentScope, extractAgents } from '../agents';
import { loadProjectForUser } from '../lib/access';
import { projectsApp } from '../lib/app';
import { commitManifest, loadManifestForEdit } from '../lib/triggers';

// `'all'` = every item the launcher can see; a list = an explicit allowlist;
// `[]` = none. Mirrors the AgentSpec GrantSet.
const GrantSetSchema = z.union([z.literal('all'), z.array(z.string().min(1).max(200)).max(500)]);

const AgentScopeBody = z.object({
  env: GrantSetSchema.optional(),
  connectors: GrantSetSchema.optional(),
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
    responses: { 200: json(z.any(), 'Updated agent scope'), ...errors(400, 403, 404) },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const agentName = c.req.param('agentName');
    const loaded = await loadProjectForUser(c, projectId, 'manage');
    if (!loaded) return c.json({ error: 'Not found' }, 404);

    const parsed = AgentScopeBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Invalid body', code: 'invalid_body' }, 400);
    const { env, connectors } = parsed.data;
    if (env === undefined && connectors === undefined) {
      return c.json({ error: 'Provide env and/or connectors', code: 'nothing_to_update' }, 400);
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

    // The agent must already be declared — this route scopes an existing
    // `[[agents]]`, it doesn't create the roster entry (that's a fuller edit).
    const current = Array.isArray(manifest.raw.agents)
      ? (manifest.raw.agents as Record<string, unknown>[])
      : [];
    const applied = applyAgentScope(current, agentName, { env, connectors }, manifest.path);
    if (!applied.ok) return c.json({ error: applied.error, code: 'agent_not_found' }, 404);
    manifest.raw.agents = applied.agents;

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
      return c.json({ error: committed.error }, (committed.status as 400) ?? 400);
    }

    const spec = check.specs.find((s) => s.name === agentName);
    return c.json({
      ok: true,
      agent: agentName,
      env: spec?.env ?? 'all',
      connectors: spec?.connectors ?? [],
    });
  },
);
