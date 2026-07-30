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

import { randomBytes } from 'node:crypto';
import { createRoute, z } from '@hono/zod-openapi';
import { projects } from '@kortix/db';
import {
  type AgentBlockV2,
  type ManifestIssue,
  SLUG_RE,
  validateAgentMdFrontmatter,
} from '@kortix/manifest-schema';
import { eq } from 'drizzle-orm';
import { PROJECT_ACTIONS } from '../../iam/actions';
import { assertAgentScope } from '../../iam/agent-scope';
import { auth, errors, json } from '../../openapi';
import { db } from '../../shared/db';
import { resolveTemplateBySlug } from '../../snapshots/templates';
import {
  createChangeRequestForBranch,
  findOpenAgentConfigChangeRequest,
  serializeChangeRequest,
} from '../change-requests';
import { extractAgents } from '../agents';
import { isRepoFileNotFoundError, readRepoFile } from '../git';
import {
  createRemoteSessionBranch,
  GitFileRevisionConflictError,
  commitMultipleFilesToBranch,
} from '../git/branches';
import { assertProjectCapability, loadProjectForUser } from '../lib/access';
import {
  applyAgentBlockV2,
  applyDefaultAgentV2,
  composeAgentConfigFiles,
  composeAgentRepairBehaviorFile,
  type BehaviorFileState,
  normalizeRequiredConnectorAliases,
  readAgentBlockV2,
} from '../lib/agent-config-v2';
import { parseAgentMarkdown, serializeAgentMarkdown } from '../lib/agent-markdown';
import { projectsApp } from '../lib/app';
import {
  KNOWN_BEHAVIOR_KEYS,
  OpencodeAgentConfigSchema,
  agentMarkdownPath,
} from '../lib/compile-agent-config';
import { withProjectGitAuth } from '../lib/git';
import { metadataMerge } from '../lib/metadata-merge';
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
    enabled: z.boolean().optional(),
    sandbox: z.string().min(1).max(128).regex(SLUG_RE).optional(),
    connectors: GrantSetSchema.optional(),
    connectors_required: z.array(z.string().trim().min(1).max(200)).max(500).optional(),
    // Deprecated request alias. The handler normalizes it before serialization.
    connectors_personal: z.array(z.string().min(1).max(200)).max(500).optional(),
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

const PreviewAgentConfigBodySchema = z.object({
  agentName: z.string().min(1).max(200),
  block: AgentBlockSchema,
});

const CreateAgentConfigBodySchema = PreviewAgentConfigBodySchema.extend({
  preview_revision: z.string().regex(/^[a-f0-9]{64}$/),
});

const RepairAgentBehaviorBodySchema = z.object({
  behavior_markdown: z.string(),
});

type AgentMarkdownRead =
  | { state: 'exists'; frontmatter: Record<string, unknown>; body: string }
  | { state: 'missing'; frontmatter: Record<string, unknown>; body: string }
  | { state: 'read_error'; frontmatter: Record<string, unknown>; body: string; error: string };

async function readAgentMarkdown(
  loadedRow: Parameters<typeof withProjectGitAuth>[0],
  branch: string,
  mdPath: string,
): Promise<AgentMarkdownRead> {
  try {
    const gitProject = await withProjectGitAuth(loadedRow);
    const content = await readRepoFile(gitProject, mdPath, branch);
    return { state: 'exists', ...parseAgentMarkdown(content) };
  } catch (error) {
    if (isRepoFileNotFoundError(error)) {
      return { state: 'missing', frontmatter: {}, body: '' };
    }
    return {
      state: 'read_error',
      frontmatter: {},
      body: '',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function jsonConfigError(c: any, result: { status: number; code: string; error: string; issues?: unknown[] }) {
  return c.json(
    {
      error: result.error,
      code: result.code,
      ...(result.issues ? { issues: result.issues } : {}),
    },
    result.status as any,
  );
}

function behaviorState(read: AgentMarkdownRead): BehaviorFileState {
  return read.state;
}

function agentBranchName(kind: 'create' | 'repair', agentName: string): string {
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  return `kortix/agents/${kind}/${agentName}-${stamp}-${randomBytes(4).toString('hex')}`;
}

async function createAgentChangeBranch(
  project: Awaited<ReturnType<typeof withProjectGitAuth>>,
  kind: 'create' | 'repair',
  agentName: string,
  baseRef: string,
): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const branch = agentBranchName(kind, agentName);
    try {
      await createRemoteSessionBranch(project, branch, baseRef);
      return branch;
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!/already exists|reference already exists/i.test(message)) break;
    }
  }
  throw lastError;
}

async function assertSandboxTemplate(
  loadedRow: Parameters<typeof withProjectGitAuth>[0],
  agentName: string,
  block: { sandbox?: string },
): Promise<{ ok: true } | { ok: false; body: Record<string, unknown> }> {
  if (!block.sandbox) return { ok: true };
  try {
    await resolveTemplateBySlug(await withProjectGitAuth(loadedRow), block.sandbox);
    return { ok: true };
  } catch {
    return {
      ok: false,
      body: {
        error: `Unknown sandbox template "${block.sandbox}"`,
        code: 'invalid_config',
        issues: [
          {
            path: `agents.${agentName}.sandbox`,
            message: 'must name an available project template or "default".',
            severity: 'error',
          },
        ],
      },
    };
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
    let behaviorPath: string | null = null;
    let behaviorFileState: BehaviorFileState | null = null;
    let behaviorFileError: string | null = null;
    if (read.schemaVersion === 2) {
      const mdPath = agentMarkdownPath(manifest.raw, agentName);
      behaviorPath = mdPath;
      const behavior = await readAgentMarkdown(
        loaded.row,
        loaded.row.defaultBranch,
        mdPath,
      );
      behaviorFileState = behavior.state;
      behaviorFileError = behavior.state === 'read_error' ? behavior.error : null;
      if (behavior.state === 'exists') {
        const opencode = pickBehaviorFields(behavior.frontmatter);
        if (behavior.body.trim()) opencode.prompt = behavior.body;
        block = { ...(read.block ?? {}), opencode };
      } else if (read.block !== null) {
        block = { ...read.block, opencode: {} };
      } else {
        block = null;
      }
    }

    return c.json({
      agent: agentName,
      schema_version: read.schemaVersion,
      editable: read.schemaVersion === 2,
      default_agent: read.defaultAgent,
      behavior_path: behaviorPath,
      behavior_file_state: behaviorFileState,
      ...(behaviorFileError ? { behavior_file_error: behaviorFileError } : {}),
      block,
    });
  },
);

// POST /v1/projects/:projectId/agents/preview
// Returns the exact manifest + behavior-file writes for a new agent without
// mutating git. The create route requires the preview_revision produced here.
projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/agents/preview',
    tags: ['projects'],
    summary: 'Preview direct agent creation',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: { content: { 'application/json': { schema: PreviewAgentConfigBodySchema } } },
    },
    responses: {
      200: json(z.any(), 'Previewed agent files'),
      ...errors(400, 403, 404, 409, 502),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'write');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_AGENT_WRITE,
    );

    const parsed = PreviewAgentConfigBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json(
        { error: 'Invalid body', code: 'invalid_body', issues: parsed.error.issues },
        400,
      );
    }
    const { agentName, block } = parsed.data;

    const sandbox = await assertSandboxTemplate(loaded.row, agentName, block);
    if (!sandbox.ok) return c.json(sandbox.body, 400);

    let manifest: Awaited<ReturnType<typeof loadManifestForEdit>>;
    try {
      manifest = await loadManifestForEdit(loaded.row);
    } catch (error) {
      return c.json(
        { error: (error as Error).message || 'failed to read manifest', code: 'manifest_read' },
        400,
      );
    }

    const behaviorPath = agentMarkdownPath(manifest.raw, agentName);
    const behavior = await readAgentMarkdown(loaded.row, loaded.row.defaultBranch, behaviorPath);
    const composed = composeAgentConfigFiles({
      manifest,
      agentName,
      block,
      existingBehaviorFile: behaviorState(behavior),
    });
    if (!composed.ok) return jsonConfigError(c, composed);

    return c.json({
      agent_name: agentName,
      manifest_path: composed.manifestPath,
      behavior_path: composed.behaviorPath,
      manifest_content: composed.manifestContent,
      behavior_markdown: composed.behaviorMarkdown,
      preview_revision: composed.previewRevision,
      files: composed.files,
    });
  },
);

// POST /v1/projects/:projectId/agents
// Creates a new manifest-declared agent through a branch-backed CR. The default
// branch remains unchanged until the CR is merged.
projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/agents',
    tags: ['projects'],
    summary: 'Create an agent via change request',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: { content: { 'application/json': { schema: CreateAgentConfigBodySchema } } },
    },
    responses: {
      201: json(z.any(), 'Created agent change request'),
      ...errors(400, 403, 404, 409, 422, 502),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'write');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_AGENT_WRITE,
    );
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_GITOPS_PUSH,
    );
    assertAgentScope(c, PROJECT_ACTIONS.PROJECT_CR_OPEN);

    const parsed = CreateAgentConfigBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json(
        { error: 'Invalid body', code: 'invalid_body', issues: parsed.error.issues },
        400,
      );
    }
    const { agentName, block, preview_revision: previewRevision } = parsed.data;

    const sandbox = await assertSandboxTemplate(loaded.row, agentName, block);
    if (!sandbox.ok) return c.json(sandbox.body, 400);

    let manifest: Awaited<ReturnType<typeof loadManifestForEdit>>;
    try {
      manifest = await loadManifestForEdit(loaded.row);
    } catch (error) {
      return c.json(
        { error: (error as Error).message || 'failed to read manifest', code: 'manifest_read' },
        400,
      );
    }

    const behaviorPath = agentMarkdownPath(manifest.raw, agentName);
    const behavior = await readAgentMarkdown(loaded.row, loaded.row.defaultBranch, behaviorPath);
    const composed = composeAgentConfigFiles({
      manifest,
      agentName,
      block,
      existingBehaviorFile: behaviorState(behavior),
    });
    if (!composed.ok) return jsonConfigError(c, composed);
    if (previewRevision !== composed.previewRevision) {
      return c.json(
        {
          error: 'Preview is stale. Re-preview the agent before creating it.',
          code: 'stale_preview_revision',
          preview_revision: composed.previewRevision,
        },
        409,
      );
    }

    const gitProject = await withProjectGitAuth(loaded.row);
    let pending;
    try {
      pending = await findOpenAgentConfigChangeRequest(
        gitProject,
        projectId,
        agentName,
        composed.files.map((file) => file.path),
      );
    } catch (error) {
      return c.json(
        {
          error: `Failed to inspect open change requests: ${
            error instanceof Error ? error.message : String(error)
          }`,
          code: 'pending_cr_check_failed',
        },
        502,
      );
    }
    if (pending) {
      return c.json(
        {
          error: `Agent "${agentName}" already has an open change request.`,
          code: 'pending_duplicate_agent_create',
          change_request: serializeChangeRequest(pending),
        },
        409,
      );
    }

    let branch: string;
    try {
      branch = await createAgentChangeBranch(
        gitProject,
        'create',
        agentName,
        loaded.row.defaultBranch,
      );
    } catch (error) {
      return c.json(
        { error: `Failed to create agent branch: ${(error as Error).message || String(error)}` },
        502,
      );
    }

    let commitSha: string;
    try {
      const committed = await commitMultipleFilesToBranch(gitProject, {
        files: composed.files,
        message: `chore: create agent ${agentName}`,
        branch,
        expectedFileRevision:
          manifest.revision === undefined
            ? undefined
            : {
                path: composed.manifestPath,
                sha: manifest.revision,
                candidatePaths: manifest.candidatePaths,
              },
      });
      commitSha = committed.commitSha;
    } catch (error) {
      if (error instanceof GitFileRevisionConflictError) {
        return c.json(
          { error: error.message, code: 'manifest_revision_conflict' },
          409,
        );
      }
      return c.json(
        { error: `Failed to commit agent files: ${(error as Error).message || String(error)}` },
        502,
      );
    }

    const cr = await createChangeRequestForBranch({
      accountId: loaded.row.accountId,
      projectId,
      userId: loaded.userId,
      projectForGit: gitProject,
      title: `Create agent ${agentName}`,
      description: `Adds ${agentName} to ${composed.manifestPath} and ${composed.behaviorPath}.`,
      baseRef: loaded.row.defaultBranch,
      headRef: branch,
      metadata: {
        agent_config: {
          action: 'create',
          agent_name: agentName,
          manifest_path: composed.manifestPath,
          behavior_path: composed.behaviorPath,
        },
      },
    });
    if (!cr.ok) return c.json(cr.body, cr.status as any);

    return c.json(
      {
        agent_name: agentName,
        manifest_path: composed.manifestPath,
        behavior_path: composed.behaviorPath,
        preview_revision: composed.previewRevision,
        branch,
        commit_sha: commitSha,
        change_request: serializeChangeRequest(cr.row),
      },
      201,
    );
  },
);

// POST /v1/projects/:projectId/agents/:agentName/behavior-repair
// Creates a missing behavior `.md` from user-reviewed markdown, then opens a CR.
projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/agents/{agentName}/behavior-repair',
    tags: ['projects'],
    summary: 'Repair a missing agent behavior file via change request',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), agentName: z.string() }),
      body: { content: { 'application/json': { schema: RepairAgentBehaviorBodySchema } } },
    },
    responses: {
      201: json(z.any(), 'Created repair change request'),
      ...errors(400, 403, 404, 409, 422, 502),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const agentName = c.req.param('agentName');
    const loaded = await loadProjectForUser(c, projectId, 'write');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_AGENT_WRITE,
    );
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_GITOPS_PUSH,
    );
    assertAgentScope(c, PROJECT_ACTIONS.PROJECT_CR_OPEN);

    const parsed = RepairAgentBehaviorBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json(
        { error: 'Invalid body', code: 'invalid_body', issues: parsed.error.issues },
        400,
      );
    }

    let manifest: Awaited<ReturnType<typeof loadManifestForEdit>>;
    try {
      manifest = await loadManifestForEdit(loaded.row);
    } catch (error) {
      return c.json(
        { error: (error as Error).message || 'failed to read manifest', code: 'manifest_read' },
        400,
      );
    }

    const path = agentMarkdownPath(manifest.raw, agentName);
    const behavior = await readAgentMarkdown(loaded.row, loaded.row.defaultBranch, path);
    const repair = composeAgentRepairBehaviorFile({
      manifest,
      agentName,
      behaviorFileState: behaviorState(behavior),
      behaviorMarkdown: parsed.data.behavior_markdown,
    });
    if (!repair.ok) return jsonConfigError(c, repair);

    const gitProject = await withProjectGitAuth(loaded.row);
    let pending;
    try {
      pending = await findOpenAgentConfigChangeRequest(
        gitProject,
        projectId,
        agentName,
        repair.files.map((file) => file.path),
      );
    } catch (error) {
      return c.json(
        {
          error: `Failed to inspect open change requests: ${
            error instanceof Error ? error.message : String(error)
          }`,
          code: 'pending_cr_check_failed',
        },
        502,
      );
    }
    if (pending) {
      return c.json(
        {
          error: `Agent "${agentName}" already has an open change request.`,
          code: 'pending_agent_config_change',
          change_request: serializeChangeRequest(pending),
        },
        409,
      );
    }

    let branch: string;
    try {
      branch = await createAgentChangeBranch(
        gitProject,
        'repair',
        agentName,
        loaded.row.defaultBranch,
      );
    } catch (error) {
      return c.json(
        { error: `Failed to create agent branch: ${(error as Error).message || String(error)}` },
        502,
      );
    }

    let commitSha: string;
    try {
      const committed = await commitMultipleFilesToBranch(gitProject, {
        files: repair.files,
        message: `chore: repair agent ${agentName} behavior`,
        branch,
      });
      commitSha = committed.commitSha;
    } catch (error) {
      return c.json(
        { error: `Failed to commit agent behavior: ${(error as Error).message || String(error)}` },
        502,
      );
    }

    const cr = await createChangeRequestForBranch({
      accountId: loaded.row.accountId,
      projectId,
      userId: loaded.userId,
      projectForGit: gitProject,
      title: `Repair agent ${agentName} behavior`,
      description: `Adds missing behavior file ${repair.behaviorPath}.`,
      baseRef: loaded.row.defaultBranch,
      headRef: branch,
      metadata: {
        agent_config: {
          action: 'repair',
          agent_name: agentName,
          manifest_path: repair.manifestPath,
          behavior_path: repair.behaviorPath,
        },
      },
    });
    if (!cr.ok) return c.json(cr.body, cr.status as any);

    return c.json(
      {
        agent_name: agentName,
        manifest_path: repair.manifestPath,
        behavior_path: repair.behaviorPath,
        branch,
        commit_sha: commitSha,
        change_request: serializeChangeRequest(cr.row),
      },
      201,
    );
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
      ...errors(400, 403, 404, 409, 502),
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
      return c.json(
        { error: 'Invalid body', code: 'invalid_body', issues: parsed.error.issues },
        400,
      );
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
        expectedFileRevision:
          manifest.revision === undefined
            ? undefined
            : {
                path: manifestPath,
                sha: manifest.revision,
                candidatePaths: manifest.candidatePaths,
              },
      });
    } catch (error) {
      if (error instanceof GitFileRevisionConflictError) {
        return c.json({ error: error.message }, 409);
      }
      return c.json(
        { error: `Failed to commit default agent: ${(error as Error).message || String(error)}` },
        502,
      );
    }

    // FIX-J: SQL-side atomic merge of ONLY `default_agent`. A git-commit round-trip
    // sits above between this handler's metadata read and write — the widest lost-
    // update window — so a whole-object write here could revert a routing pin
    // activated in that gap. The merge reads the CURRENT row under its own lock.
    await db
      .update(projects)
      .set({ metadata: metadataMerge({ default_agent: agentName }), updatedAt: new Date() })
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
    responses: {
      200: json(z.any(), 'Updated agent config'),
      ...errors(400, 403, 404, 409, 502),
    },
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
      return c.json(
        { error: 'Invalid body', code: 'invalid_body', issues: parsed.error.issues },
        400,
      );
    }

    // Split the wire body into its two homes. Drop undefined keys
    // (governance side) so an omitted field never serializes as an explicit
    // `null`/`undefined` into the YAML block.
    const { opencode: opencodeDraft, ...governanceRaw } = parsed.data;
    const normalizedGovernance = normalizeRequiredConnectorAliases(governanceRaw);
    if (!normalizedGovernance.ok) {
      return c.json({ error: normalizedGovernance.error, code: 'invalid_body' }, 400);
    }
    const governanceBlock: AgentBlockV2 = {};
    for (const [key, value] of Object.entries(normalizedGovernance.block)) {
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

    if (governanceBlock.sandbox) {
      try {
        await resolveTemplateBySlug(await withProjectGitAuth(loaded.row), governanceBlock.sandbox);
      } catch {
        return c.json(
          {
            error: `Unknown sandbox template "${governanceBlock.sandbox}"`,
            code: 'invalid_config',
            issues: [
              {
                path: `agents.${agentName}.sandbox`,
                message: 'must name an available project template or "default".',
                severity: 'error',
              },
            ],
          },
          400,
        );
      }
    }

    const applied = applyAgentBlockV2(manifest, agentName, governanceBlock);
    if (!applied.ok) {
      return c.json({ error: applied.error, code: 'invalid_config', issues: applied.issues }, 400);
    }

    // Re-parse through the runtime grant reader before committing.
    const parsedCheck = extractAgents({ ...manifest, raw: applied.raw });
    const parseProblem = parsedCheck.errors.find((e) => e.name === agentName);
    if (parseProblem) {
      return c.json({ error: parseProblem.error, code: 'invalid_config' }, 400);
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
      if (existing.state === 'read_error') {
        return c.json(
          { error: existing.error, code: 'behavior_file_read' },
          502,
        );
      }
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
        expectedFileRevision:
          manifest.revision === undefined
            ? undefined
            : {
                path: manifestPath,
                sha: manifest.revision,
                candidatePaths: manifest.candidatePaths,
              },
      });
    } catch (err) {
      if (err instanceof GitFileRevisionConflictError) {
        return c.json({ error: err.message }, 409);
      }
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
