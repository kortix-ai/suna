// Full v2 agent-config CRUD — the dashboard "agent builder" surface (spec
// docs/specs/2026-07-05-agent-first-config-unification.md §2.2, "one agent
// block: identity + governance + behavior").
//
// Distinct from ./agent-scope.ts, which writes ONLY the grant subset
// (secrets/connectors) into a v1 `[[agents]]` entry. This route round-trips
// the WHOLE v2 `agents.<name>` block — every OpenCode-parity behavioral field
// (mode/model/temperature/top_p/steps/permission tree/…) plus every governance
// field (connectors/secrets/skills/kortix_cli/workspace) — so the editor can
// present and persist the complete field space.
//
// v2-only by construction: a v1 (`[[agents]]`) manifest has no representation
// for permission trees / per-field governance, so PUT refuses a v1 project with
// a clear 400 (the UI degrades to the limited scope editor + an "upgrade to v2"
// hint instead of ever calling PUT here). GET still works on a v1 project — it
// reports schemaVersion:1 + a null block so the UI can branch.
//
// Manager-gated on project.customize.write (same leaf the model/scope editors
// and every other customize mutation use), threaded through
// assertProjectCapability so the agent-grant fold fires.

import { createRoute, z } from '@hono/zod-openapi';
import { auth, errors, json } from '../../openapi';
import { PROJECT_ACTIONS } from '../../iam/actions';
import { applyAgentBlockV2, readAgentBlockV2 } from '../lib/agent-config-v2';
import { assertProjectCapability, loadProjectForUser } from '../lib/access';
import { projectsApp } from '../lib/app';
import { commitManifest, loadManifestForEdit } from '../lib/triggers';
import type { AgentBlockV2 } from '@kortix/manifest-schema';

// A grant set on the wire: an allowlist, or the "all"/"none" sentinels. The
// deep per-entry validation (grantable kortix_cli actions, etc.) happens in
// validateManifest via applyAgentBlockV2 — this schema only guards the shape.
const GrantSetSchema = z.union([
  z.literal('all'),
  z.literal('none'),
  z.array(z.string().min(1).max(200)).max(500),
]);

// The permission tree is validated deeply by the manifest-schema validator
// (permission actions, glob-rule maps, action-only keys) after the commit-shape
// is assembled — so here it's an open passthrough object/string. Same for
// `options`. This keeps the route from re-encoding schema rules that already
// live (and are tested) in @kortix/manifest-schema.
//
// Two layers, mirroring AgentBlockV2 (spec §2.2 structural refactor): the
// Kortix layer (top-level identity + governance + model) and the nested
// `opencode` layer (runtime-specific behavior).
const OpencodeAgentConfigSchema = z
  .object({
    mode: z.enum(['primary', 'subagent', 'all']).optional(),
    variant: z.string().max(200).optional(),
    temperature: z.number().optional(),
    top_p: z.number().optional(),
    prompt: z.string().max(500).optional(),
    hidden: z.boolean().optional(),
    options: z.record(z.string(), z.any()).optional(),
    color: z.string().max(64).optional(),
    steps: z.number().optional(),
    permission: z.any().optional(),
  })
  .strict();

const AgentBlockSchema = z
  .object({
    description: z.string().max(2000).optional(),
    enabled: z.boolean().optional(),
    model: z.string().max(200).optional(),
    connectors: GrantSetSchema.optional(),
    secrets: GrantSetSchema.optional(),
    skills: GrantSetSchema.optional(),
    kortix_cli: GrantSetSchema.optional(),
    workspace: z.enum(['runtime', 'read', 'branch']).optional(),
    opencode: OpencodeAgentConfigSchema.optional(),
  })
  .strict();

// GET /v1/projects/:projectId/agents/:agentName/config
// The agent's full v2 block for editing. schemaVersion tells the UI whether the
// full editor applies (2) or it should degrade to the limited scope editor (1).
projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/agents/{agentName}/config',
    tags: ['projects'],
    summary: 'GET /:projectId/agents/:agentName/config',
    ...auth,
    request: { params: z.object({ projectId: z.string(), agentName: z.string() }) },
    responses: { 200: json(z.any(), 'The agent config block'), ...errors(400, 403, 404) },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const agentName = c.req.param('agentName');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);

    let manifest;
    try {
      manifest = await loadManifestForEdit(loaded.row);
    } catch (e) {
      return c.json(
        { error: (e as Error).message || 'failed to read manifest', code: 'manifest_read' },
        400,
      );
    }

    const read = readAgentBlockV2(manifest, agentName);
    if (!read.ok) return c.json({ error: read.error, code: 'manifest_malformed' }, 400);
    return c.json({
      agent: agentName,
      schema_version: read.schemaVersion,
      editable: read.schemaVersion === 2,
      default_agent: read.defaultAgent,
      block: read.block,
    });
  },
);

// PUT /v1/projects/:projectId/agents/:agentName/config
// Replace the agent's full v2 block. Validated against the manifest-schema
// validator (invalid permission tree / enum / ungrantable action → 400) before
// the kortix.yaml commit.
projectsApp.openapi(
  createRoute({
    method: 'put',
    path: '/{projectId}/agents/{agentName}/config',
    tags: ['projects'],
    summary: 'PUT /:projectId/agents/:agentName/config',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), agentName: z.string() }),
      body: { content: { 'application/json': { schema: AgentBlockSchema } } },
    },
    responses: { 200: json(z.any(), 'Updated agent config'), ...errors(400, 403, 404) },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const agentName = c.req.param('agentName');
    const loaded = await loadProjectForUser(c, projectId, 'manage');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE,
    );

    const parsed = AgentBlockSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: 'Invalid body', code: 'invalid_body', issues: parsed.error.issues }, 400);
    }
    // Drop undefined keys (recursively into `opencode`) so an omitted field
    // never serializes as an explicit `null`/`undefined` into the YAML block.
    const block: AgentBlockV2 = {};
    for (const [key, value] of Object.entries(parsed.data)) {
      if (value === undefined) continue;
      if (key === 'opencode') {
        const oc: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          if (v !== undefined) oc[k] = v;
        }
        if (Object.keys(oc).length > 0) block.opencode = oc as AgentBlockV2['opencode'];
        continue;
      }
      (block as Record<string, unknown>)[key] = value;
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

    const applied = applyAgentBlockV2(manifest, agentName, block);
    if (!applied.ok) {
      return c.json({ error: applied.error, code: 'invalid_config', issues: applied.issues }, 400);
    }
    manifest.raw = applied.raw;

    const committed = await commitManifest(
      loaded.row,
      manifest,
      `chore: update agent ${agentName} config`,
    );
    if ('error' in committed) {
      return c.json({ error: committed.error }, (committed.status as 400) ?? 400);
    }

    const read = readAgentBlockV2(manifest, agentName);
    return c.json({
      ok: true,
      agent: agentName,
      schema_version: manifest.schemaVersion,
      block: read.ok ? read.block : block,
    });
  },
);
