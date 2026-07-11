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
// and behavior to the `.md` in ONE atomic commit (commitMultipleFilesToBranch)
// after validating BOTH halves, so a bad request never partially lands and a
// mid-write failure can never strand kortix.yaml and the `.md` out of sync.
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
import { projects } from '@kortix/db';
import {
  type AgentBlockV2,
  type AgentBlockV3,
  type ManifestIssue,
  validateAgentMdFrontmatter,
} from '@kortix/manifest-schema';
import { eq } from 'drizzle-orm';
import { PROJECT_ACTIONS } from '../../iam/actions';
import { auth, errors, json } from '../../openapi';
import { db } from '../../shared/db';
import { readRepoFile } from '../git';
import { commitMultipleFilesToBranch } from '../git/branches';
import { assertProjectCapability, loadProjectForUser } from '../lib/access';
import {
  applyAgentBlockV2,
  applyAgentBlockV3,
  applyDefaultAgentV2,
  readAgentBlockV2,
  readAgentBlockV3,
} from '../lib/agent-config-v2';
import { parseAgentMarkdown, serializeAgentMarkdown } from '../lib/agent-markdown';
import { projectsApp } from '../lib/app';
import {
  KNOWN_BEHAVIOR_KEYS,
  OpencodeAgentConfigSchema,
  agentMarkdownPath,
} from '../lib/compile-agent-config';
import { withProjectGitAuth } from '../lib/git';
import { loadManifestForEdit } from '../lib/triggers';
import { MANIFEST_FILENAME, serializeManifest } from '../triggers';

// A grant set on the wire: an allowlist, or the "all"/"none" sentinels. The
// deep per-entry validation (grantable kortix_cli actions, etc.) happens in
// validateManifest via applyAgentBlockV2 — this schema only guards the shape.
const GrantSetSchema = z.union([
  z.literal('all'),
  z.literal('none'),
  z.array(z.string().min(1).max(200)).max(500),
]);

// The KORTIX layer — governance only (spec §2.2 redirect). No model, no
// description, no behavior: those all moved into `opencode` (defined in
// ../lib/compile-agent-config alongside its canonical KNOWN_BEHAVIOR_KEYS —
// see that module for why), which this route writes to the `.md`, never to
// kortix.yaml.
const AgentBlockSchema = z
  .object({
    runtime: z.string().min(1).max(200).optional(),
    agent: z.string().min(1).max(200).optional(),
    enabled: z.boolean().optional(),
    connectors: GrantSetSchema.optional(),
    secrets: GrantSetSchema.optional(),
    skills: GrantSetSchema.optional(),
    kortix_cli: GrantSetSchema.optional(),
    workspace: z.enum(['runtime', 'read', 'branch']).optional(),
    opencode: OpencodeAgentConfigSchema.optional(),
  })
  .strict();

const DefaultAgentBodySchema = z.object({ agent: z.string().min(1).max(200) });
const DefaultAgentResponseSchema = z.object({
  ok: z.boolean(),
  default_agent: z.string(),
});

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

    if (manifest.schemaVersion === 3) {
      const read = readAgentBlockV3(manifest, agentName);
      if (!read.ok) return c.json({ error: read.error, code: 'manifest_malformed' }, 400);
      return c.json({
        agent: agentName,
        schema_version: 3,
        editable: true,
        default_agent: read.defaultAgent,
        block: read.block,
        runtimes: read.runtimes,
      });
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

// PUT /v1/projects/:projectId/default-agent
// `kortix.yaml.default_agent` is durable truth; project.metadata.default_agent
// is the read-optimized mirror used by session creation and channel surfaces.
projectsApp.openapi(
  createRoute({
    method: 'put',
    path: '/{projectId}/default-agent',
    tags: ['projects'],
    summary: 'Set the project default agent',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: {
        content: {
          'application/json': { schema: DefaultAgentBodySchema },
        },
      },
    },
    responses: {
      200: json(DefaultAgentResponseSchema, 'Updated project default agent'),
      ...errors(400, 403, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'manage');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE,
    );

    const parsed = DefaultAgentBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: 'Invalid body', code: 'invalid_body', issues: parsed.error.issues }, 400);
    }
    const agentName = parsed.data.agent.trim();

    let manifest: Awaited<ReturnType<typeof loadManifestForEdit>>;
    try {
      manifest = await loadManifestForEdit(loaded.row);
    } catch (error) {
      return c.json(
        { error: (error as Error).message || 'failed to read manifest', code: 'manifest_read' },
        400,
      );
    }

    const applied = applyDefaultAgentV2(manifest, agentName);
    if (!applied.ok) {
      return c.json({ error: applied.error, code: 'invalid_config', issues: applied.issues }, 400);
    }

    manifest.raw = applied.raw;
    const manifestPath = manifest.path || loaded.row.manifestPath || MANIFEST_FILENAME;
    try {
      const gitProject = await withProjectGitAuth(loaded.row);
      await commitMultipleFilesToBranch(gitProject, {
        files: [{ path: manifestPath, content: serializeManifest(manifest) }],
        message: `chore: set default agent to ${agentName}`,
        branch: loaded.row.defaultBranch,
      });
    } catch (error) {
      return c.json(
        { error: `Failed to commit default agent: ${(error as Error).message || String(error)}` },
        502,
      );
    }

    const metadata = {
      ...((loaded.row.metadata as Record<string, unknown> | null) ?? {}),
      default_agent: agentName,
    };
    await db
      .update(projects)
      .set({ metadata, updatedAt: new Date() })
      .where(eq(projects.projectId, projectId));

    return c.json({ ok: true, default_agent: agentName });
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

    // Split the wire body into its native v2/v3 homes. Drop undefined keys
    // (governance side) so an omitted field never serializes as an explicit
    // `null`/`undefined` into the YAML block.
    const { opencode: opencodeDraft, runtime, agent: nativeAgent, ...governanceRaw } = parsed.data;
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

    if (manifest.schemaVersion === 3) {
      if (opencodeDraft !== undefined) {
        return c.json({
          error: 'OpenCode behavior is not edited through kortix.yaml v3. Edit the selected runtime native config directly.',
          code: 'native_config_owned',
        }, 400);
      }
      const existing = readAgentBlockV3(manifest, agentName);
      if (!existing.ok) return c.json({ error: existing.error, code: 'manifest_malformed' }, 400);
      const selectedRuntime = runtime ?? existing.block?.runtime;
      if (!selectedRuntime) {
        return c.json({ error: 'runtime is required for a v3 logical agent', code: 'invalid_config' }, 400);
      }
      const block: AgentBlockV3 = {
        runtime: selectedRuntime,
        ...(nativeAgent ? { agent: nativeAgent } : {}),
        ...governanceBlock,
      };
      const applied = applyAgentBlockV3(manifest, agentName, block);
      if (!applied.ok) {
        return c.json({ error: applied.error, code: 'invalid_config', issues: applied.issues }, 400);
      }
      manifest.raw = applied.raw;
      const manifestPath = manifest.path || loaded.row.manifestPath || MANIFEST_FILENAME;
      try {
        const gitProject = await withProjectGitAuth(loaded.row);
        await commitMultipleFilesToBranch(gitProject, {
          files: [{ path: manifestPath, content: serializeManifest(manifest) }],
          message: `chore: update agent ${agentName} runtime and governance`,
          branch: loaded.row.defaultBranch,
        });
      } catch (err) {
        return c.json({ error: `Failed to commit agent config: ${(err as Error).message || String(err)}` }, 502);
      }
      return c.json({ ok: true, agent: agentName, schema_version: 3, block });
    }

    if (runtime !== undefined || nativeAgent !== undefined) {
      return c.json({
        error: 'runtime routing fields require kortix_version 3',
        code: 'invalid_config',
      }, 400);
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
    const manifestPath = manifest.path || loaded.row.manifestPath || MANIFEST_FILENAME;
    const behaviorWrite =
      mdPath && nextFrontmatter && nextBody !== null
        ? { path: mdPath, content: serializeAgentMarkdown(nextFrontmatter, nextBody) }
        : null;

    // ONE atomic commit for both homes. Two sequential single-file commits
    // (governance then behavior) would let a bad `.md` write fail AFTER the
    // governance write already landed, stranding kortix.yaml and the agent's
    // `.md` out of sync — commitMultipleFilesToBranch (git/branches.ts) commits
    // every file in one tree/commit, same helper the marketplace install/
    // uninstall paths use for their own atomic multi-file writes (r10.ts).
    const files = [
      { path: manifestPath, content: serializeManifest(manifest) },
      ...(behaviorWrite ? [behaviorWrite] : []),
    ];
    const message = behaviorWrite
      ? `chore: update agent ${agentName} governance + behavior`
      : `chore: update agent ${agentName} governance`;

    try {
      const gitProject = await withProjectGitAuth(loaded.row);
      await commitMultipleFilesToBranch(gitProject, {
        files,
        message,
        branch: loaded.row.defaultBranch,
      });
    } catch (err) {
      return c.json(
        { error: `Failed to commit agent config: ${(err as Error).message || String(err)}` },
        502,
      );
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
