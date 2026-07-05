// Full v2 agent-config CRUD — the dashboard "agent builder" surface (spec
// docs/specs/2026-07-05-agent-first-config-unification.md §2.2, redirected
// 2026-07-05: "one home per concern").
//
// TWO homes, ONE wire contract: kortix.yaml carries governance ONLY
// (connectors/secrets/skills/kortix_cli/workspace/enabled); the agent's own
// native `.kortix/opencode/agents/<name>.md` frontmatter + body carries every
// OpenCode-behavioral field (mode/model/temperature/top_p/steps/variant/
// color/hidden/permission) plus the prompt itself. This route is the ONE
// place that merges them into a single wire shape (`block.opencode = {...}`)
// so the dashboard editor's data binding never has to know two files exist —
// see agent-editor.tsx. GET reads both; PUT writes governance to kortix.yaml
// and behavior to the `.md` (two commits, spec §2.2's explicitly-sanctioned
// two-commit shape) after validating BOTH halves so a bad request never
// partially lands.
//
// Distinct from ./agent-scope.ts, which writes ONLY the grant subset
// (secrets/connectors) into a v1 `[[agents]]` entry.
//
// v2-only by construction: a v1 (`[[agents]]`) manifest has no representation
// for the governance field space, so PUT refuses a v1 project with a clear
// 400 (the UI degrades to the limited scope editor + an "upgrade to v2"
// hint instead of ever calling PUT here). GET still works on a v1 project — it
// reports schemaVersion:1 + a null block so the UI can branch.
//
// Manager-gated on project.customize.write (same leaf the model/scope editors
// and every other customize mutation use), threaded through
// assertProjectCapability so the agent-grant fold fires.

import { createRoute, z } from '@hono/zod-openapi';
import { auth, errors, json } from '../../openapi';
import { PROJECT_ACTIONS } from '../../iam/actions';
import { validateAgentMdFrontmatter, type AgentBlockV2, type ManifestIssue } from '@kortix/manifest-schema';
import { applyAgentBlockV2, readAgentBlockV2 } from '../lib/agent-config-v2';
import { parseAgentMarkdown, serializeAgentMarkdown } from '../lib/agent-markdown';
import { agentMarkdownPath } from '../lib/compile-agent-config';
import { assertProjectCapability, loadProjectForUser } from '../lib/access';
import { withProjectGitAuth } from '../lib/git';
import { projectsApp } from '../lib/app';
import { commitManifest, commitRepoFile, loadManifestForEdit } from '../lib/triggers';
import { readRepoFile } from '../git';

// A grant set on the wire: an allowlist, or the "all"/"none" sentinels. The
// deep per-entry validation (grantable kortix_cli actions, etc.) happens in
// validateManifest via applyAgentBlockV2 — this schema only guards the shape.
const GrantSetSchema = z.union([
  z.literal('all'),
  z.literal('none'),
  z.array(z.string().min(1).max(200)).max(500),
]);

// The OpenCode BEHAVIOR half — every field that lives in the agent's own
// `.md` frontmatter (+ `prompt`, which is the file's BODY, not a frontmatter
// key). The permission tree is validated deeply by
// `validateAgentMdFrontmatter` (@kortix/manifest-schema) after the request
// shape is assembled — so here it's an open passthrough object/string, same
// for `options`. This keeps the route from re-encoding schema rules that
// already live (and are tested) in @kortix/manifest-schema.
const OpencodeAgentConfigSchema = z
  .object({
    description: z.string().max(2000).optional(),
    mode: z.enum(['primary', 'subagent', 'all']).optional(),
    model: z.string().max(200).optional(),
    variant: z.string().max(200).optional(),
    temperature: z.number().optional(),
    top_p: z.number().optional(),
    /** The `.md` BODY (the system prompt text), not a file path. */
    prompt: z.string().max(50_000).optional(),
    hidden: z.boolean().optional(),
    options: z.record(z.string(), z.any()).optional(),
    color: z.string().max(64).optional(),
    steps: z.number().optional(),
    permission: z.any().optional(),
  })
  .strict();

// The KORTIX layer — governance only (spec §2.2 redirect). No model, no
// description, no behavior: those all moved into `opencode` above, which
// this route writes to the `.md`, never to kortix.yaml.
const AgentBlockSchema = z
  .object({
    enabled: z.boolean().optional(),
    connectors: GrantSetSchema.optional(),
    secrets: GrantSetSchema.optional(),
    skills: GrantSetSchema.optional(),
    kortix_cli: GrantSetSchema.optional(),
    workspace: z.enum(['runtime', 'read', 'branch']).optional(),
    opencode: OpencodeAgentConfigSchema.optional(),
  })
  .strict();

/** Behavior-frontmatter keys the editor round-trips. Anything ELSE a human
 *  hand-authored directly into the `.md` (e.g. a native `disable`, or a
 *  field this editor doesn't expose yet) is preserved untouched on save —
 *  see `mergeFrontmatter`. */
const KNOWN_BEHAVIOR_KEYS = [
  'description',
  'mode',
  'model',
  'variant',
  'temperature',
  'top_p',
  'options',
  'color',
  'steps',
  'hidden',
  'permission',
] as const;

/** Read + parse an agent's `.md` (governance-declared or not — behavior and
 *  governance are independently addressable). Never throws: a missing file
 *  (brand-new agent) reads as body-only/empty, same as a fresh start. */
async function readAgentMarkdown(
  loadedRow: Parameters<typeof withProjectGitAuth>[0],
  branch: string,
  mdPath: string,
): Promise<{ frontmatter: Record<string, unknown>; body: string }> {
  try {
    const gitProject = await withProjectGitAuth(loadedRow);
    const content = await readRepoFile(gitProject, mdPath, branch);
    return parseAgentMarkdown(content);
  } catch {
    return { frontmatter: {}, body: '' };
  }
}

/** Merge the editor's draft behavior fields onto the file's EXISTING
 *  frontmatter — full replace for every key this editor knows about (matches
 *  the rest of the codebase's "whole-block replace" convention, e.g.
 *  `applyAgentBlockV2`), but any OTHER key already in the file (a hand-
 *  authored `disable`, or a future field this editor doesn't expose) is
 *  carried over untouched. */
function mergeFrontmatter(
  existing: Record<string, unknown>,
  draft: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...existing };
  for (const key of KNOWN_BEHAVIOR_KEYS) {
    if (draft[key] !== undefined) next[key] = draft[key];
    else delete next[key];
  }
  return next;
}

/** Project the recognized behavior fields out of a `.md`'s parsed
 *  frontmatter, for the GET response's `block.opencode`. */
function pickBehaviorFields(frontmatter: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of KNOWN_BEHAVIOR_KEYS) {
    if (frontmatter[key] !== undefined) out[key] = frontmatter[key];
  }
  return out;
}

// GET /v1/projects/:projectId/agents/:agentName/config
// The agent's full merged block for editing — governance from kortix.yaml,
// behavior from the agent's `.md` frontmatter+body. schemaVersion tells the
// UI whether the full editor applies (2) or it should degrade to the limited
// scope editor (1).
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

    let block: (AgentBlockV2 & { opencode?: Record<string, unknown> }) | null = read.block;
    if (read.schemaVersion === 2) {
      const mdPath = agentMarkdownPath(manifest.raw, agentName);
      const { frontmatter, body } = await readAgentMarkdown(loaded.row, loaded.row.defaultBranch, mdPath);
      const opencode = pickBehaviorFields(frontmatter);
      if (body.trim()) opencode.prompt = body;
      block = { ...(read.block ?? {}), opencode };
    }

    return c.json({
      agent: agentName,
      schema_version: read.schemaVersion,
      editable: read.schemaVersion === 2,
      default_agent: read.defaultAgent,
      block,
    });
  },
);

// PUT /v1/projects/:projectId/agents/:agentName/config
// Replace the agent's full block: governance → kortix.yaml (validated via
// the manifest-schema validator), behavior → the agent's `.md` frontmatter +
// body (validated via `validateAgentMdFrontmatter`). Both halves are
// validated before EITHER commits.
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

    // Split the wire body into its two homes. Drop undefined keys
    // (governance side) so an omitted field never serializes as an explicit
    // `null`/`undefined` into the YAML block.
    const { opencode: opencodeDraft, ...governanceRaw } = parsed.data;
    const governanceBlock: AgentBlockV2 = {};
    for (const [key, value] of Object.entries(governanceRaw)) {
      if (value !== undefined) (governanceBlock as Record<string, unknown>)[key] = value;
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

    const applied = applyAgentBlockV2(manifest, agentName, governanceBlock);
    if (!applied.ok) {
      return c.json({ error: applied.error, code: 'invalid_config', issues: applied.issues }, 400);
    }

    // Validate the behavior half (if the request touches it at all) BEFORE
    // committing anything — a bad frontmatter shape must never land a
    // governance-only half-write.
    let mdPath: string | null = null;
    let nextFrontmatter: Record<string, unknown> | null = null;
    let nextBody: string | null = null;
    if (opencodeDraft !== undefined) {
      mdPath = agentMarkdownPath(applied.raw, agentName);
      const existing = await readAgentMarkdown(loaded.row, loaded.row.defaultBranch, mdPath);
      const draftRecord: Record<string, unknown> = { ...opencodeDraft };
      delete draftRecord.prompt;
      nextFrontmatter = mergeFrontmatter(existing.frontmatter, draftRecord);
      nextBody = opencodeDraft.prompt ?? '';

      const issues: ManifestIssue[] = [];
      validateAgentMdFrontmatter(nextFrontmatter, `agents.${agentName}`, issues);
      const errorIssues = issues.filter((i) => i.severity === 'error');
      if (errorIssues.length > 0) {
        return c.json(
          {
            error: errorIssues.map((i) => `${i.path}: ${i.message}`).join('; '),
            code: 'invalid_config',
            issues: errorIssues,
          },
          400,
        );
      }
    }

    manifest.raw = applied.raw;
    const committedYaml = await commitManifest(
      loaded.row,
      manifest,
      `chore: update agent ${agentName} governance`,
    );
    if ('error' in committedYaml) {
      return c.json({ error: committedYaml.error }, (committedYaml.status as 400) ?? 400);
    }

    if (mdPath && nextFrontmatter && nextBody !== null) {
      const content = serializeAgentMarkdown(nextFrontmatter, nextBody);
      const committedMd = await commitRepoFile(
        loaded.row,
        mdPath,
        content,
        `chore: update agent ${agentName} behavior`,
      );
      if ('error' in committedMd) {
        return c.json({ error: committedMd.error }, (committedMd.status as 400) ?? 400);
      }
    }

    const read = readAgentBlockV2(manifest, agentName);
    const responseOpencode =
      nextFrontmatter !== null
        ? { ...pickBehaviorFields(nextFrontmatter), ...(nextBody ? { prompt: nextBody } : {}) }
        : undefined;
    return c.json({
      ok: true,
      agent: agentName,
      schema_version: manifest.schemaVersion,
      block: read.ok
        ? { ...(read.block ?? {}), ...(responseOpencode ? { opencode: responseOpencode } : {}) }
        : governanceBlock,
    });
  },
);
