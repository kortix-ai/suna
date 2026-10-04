// Full v2 agent-config CRUD — the dashboard "agent builder" surface (redirected
// 2026-07-05: "one home per concern").
//
// TWO homes, ONE wire contract: kortix.yaml carries governance ONLY
// (connectors/secrets/skills/kortix_permissions/repository_access/enabled) plus
// `file`, the path of the agent's `.md`; that `.md` frontmatter + body carries
// every behavioral field (mode/model/temperature/top_p/steps/variant/
// color/hidden/permission) plus the prompt itself. `file` is server-owned:
// the wire never sends it, and PUT records the path it read or wrote, so a
// save never drops it and an edited agent always names its file. This route is the ONE
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
// Manager-gated on project.agent.write (same leaf the scope editor
// and every other customize mutation use), threaded through
// assertProjectCapability so the agent-grant fold fires.

import { createRoute, z } from '@hono/zod-openapi';
import { ignoredAgentSettings } from '@kortix/api-contract/runtime-relay';
import { projects } from '@kortix/db';
import {
  type AgentBlockV2,
  type ManifestIssue,
  SLUG_RE,
  validateAgentMdFrontmatter,
} from '@kortix/manifest-schema';
import { eq } from 'drizzle-orm';
import { resolveFeatureFlag } from '../../services/feature-flags/registry';
import { PROJECT_ACTIONS } from '../../services/iam/actions';
import { projectLlmGatewayEnabled } from '../../services/llm-gateway/enablement';
import { auth, errors, json } from '../openapi';
import { db } from '../../lib/db';
import { resolveTemplateBySlug } from '../../services/snapshots/templates';
import { extractAgents, grantsByAgent } from '../../services/projects/agents';
import { assertNoGrantEscalation } from '../../services/iam/agent-grant-ceiling';
import { governedAgentWriter } from '../lib/agent-scope';
import { GitFileRevisionConflictError, commitMultipleFilesToBranch } from '../../services/git/branches';
import { isRemotePushPolicyRejection } from '../../services/git/mirror';
import { assertAgentSessionWorkspaceAllowsRepository, assertProjectCapability, loadProjectForUser } from '../lib/project-access';
import {
  applyAgentBlockV2,
  applyDefaultAgentV2,
  normalizeRequiredConnectorAliases,
  resolveBehaviorDraft,
  readAgentBlockV2,
} from '../../services/projects/lib/agent-config-v2';
import { parseAgentMarkdown, serializeAgentMarkdown } from '../../services/projects/lib/agent-markdown';
import { projectsApp } from './app';
import {
  KNOWN_BEHAVIOR_KEYS,
  OpencodeAgentConfigSchema,
  readAgentMarkdownFile,
  manifestRuntime,
  selectSessionHarness,
} from '../../services/projects/lib/compile-agent-config';
import { withProjectGitAuth } from '../../services/git/project-git';
import { metadataMerge } from '../../services/projects/lib/metadata-merge';
import { loadManifestForEdit } from '../../services/triggers/trigger-runtime';
import { allowStaleMirrorReads } from '../../services/git/mirror';
import { MANIFEST_FILENAME, manifestWrites } from '../../services/triggers';

// A grant set on the wire: an allowlist, or the "all"/"none" sentinels. The
// deep per-entry validation (grantable kortix_permissions actions, etc.) happens in
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
    tools: z.record(z.string(), z.boolean()).optional(),
    sandbox: z.string().min(1).max(128).regex(SLUG_RE).optional(),
    connectors: GrantSetSchema.optional(),
    connectors_required: z.array(z.string().trim().min(1).max(200)).max(500).optional(),
    // Deprecated request alias. The handler normalizes it before serialization.
    connectors_personal: z.array(z.string().min(1).max(200)).max(500).optional(),
    secrets: GrantSetSchema.optional(),
    skills: GrantSetSchema.optional(),
    // Kortix Apps (by slug) this agent may open when restricted/private (§2.5).
    apps: GrantSetSchema.optional(),
    kortix_permissions: GrantSetSchema.optional(),
    // Deprecated request alias of kortix_permissions. The handler normalizes it
    // (normalizeKortixPermissionAliases) before serialization.
    kortix_cli: GrantSetSchema.optional(),
    repository_access: z.boolean().optional(),
    // Deprecated input alias for older clients.
    workspace: z.enum(['runtime', 'read', 'branch']).optional(),
    // Server-owned; accepted so a GET → PUT round trip keeps working. Only the
    // value already in effect is allowed (see the PUT handler).
    file: z.string().max(1024).optional(),
    // The agent's behavior half (`.md` frontmatter + body as `prompt`).
    behavior: OpencodeAgentConfigSchema.optional(),
    // The pre-W4 name of `behavior`; see resolveBehaviorDraft.
    opencode: OpencodeAgentConfigSchema.optional(),
  })
  .strict();

const DefaultAgentBodySchema = z.object({ agent: z.string().min(1).max(200) });
const DefaultAgentResponseSchema = z.object({
  ok: z.boolean(),
  default_agent: z.string(),
});

/**
 * A commit the remote rejected by repository policy — branch protection,
 * repository rules, or a server-side hook — is a PERMANENT, user-actionable
 * outcome. The same commit is rejected on every retry, so it must be a typed
 * 409 the dashboard renders as a message, never a 5xx that pages Better Stack
 * (prod pattern `5e505349…`:
 * `Failed to commit agent config: … push declined due to repository rule violations`).
 *
 * The branch name is not customer data; the raw git stderr is omitted because
 * it carries the customer's repository URL.
 */
function pushPolicyRejectedBody(branch: string) {
  return {
    error:
      `The repository rejected the push to "${branch}" because of its branch protection or repository rules. ` +
      `Allow the Kortix GitHub App to push to "${branch}", or connect a repository where it can, then try again.`,
    code: 'repository_push_rejected',
  };
}

/** Read + parse an agent's `.md` on `branch` (governance-declared or not —
 *  behavior and governance are independently addressable): the first
 *  candidate path that exists, else where a new one goes. A missing file
 *  (brand-new agent) reads as body-only/empty, same as a fresh start. */
async function readAgentMarkdown(
  project: Parameters<typeof withProjectGitAuth>[0] | Awaited<ReturnType<typeof withProjectGitAuth>>,
  branch: string,
  manifestRaw: Record<string, unknown>,
  agentName: string,
): Promise<{ path: string; exists: boolean; frontmatter: Record<string, unknown>; body: string }> {
  const gitProject = 'gitAuthToken' in project ? project : await withProjectGitAuth(project);
  const md = await readAgentMarkdownFile(gitProject, manifestRaw, agentName, branch);
  if (md.content === null) return { path: md.path, exists: false, frontmatter: {}, body: '' };
  return { path: md.path, exists: true, ...parseAgentMarkdown(md.content) };
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
 *  frontmatter, for the GET response's `block.behavior`. */
function pickBehaviorFields(frontmatter: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of KNOWN_BEHAVIOR_KEYS) {
    if (frontmatter[key] !== undefined) out[key] = frontmatter[key];
  }
  return out;
}

/** The behavior half as GET serves it: the picked frontmatter, plus the body as `prompt`. */
function behaviorOf(md: { frontmatter: Record<string, unknown>; body: string }): Record<string, unknown> {
  const behavior = pickBehaviorFields(md.frontmatter);
  if (md.body.trim()) behavior.prompt = md.body;
  return behavior;
}
export function registerAgentConfigRoutes(): void {
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
      summary: 'Get an agent\'s configuration',
      ...auth,
      request: { params: z.object({ projectId: z.string(), agentName: z.string() }) },
      responses: { 200: json(z.any(), 'The agent config block'), ...errors(400, 403, 404) },
    }),
    async (c: any) => {
      const projectId = c.req.param('projectId');
      const agentName = c.req.param('agentName');
      const loaded = await loadProjectForUser(c, projectId, 'read');
      if (!loaded) return c.json({ error: 'Not found' }, 404);
      await assertAgentSessionWorkspaceAllowsRepository(c, loaded.row.accountId, projectId);

      // The manifest read stays forced: a GET right after a PUT may land on
      // another replica, and the editor must read back what was saved (see
      // `manifest-for-edit-freshness.test.ts`). It proves the default branch
      // with one `ls-remote` and fetches only when it moved. The `.md` read
      // below then uses that just-proven mirror instead of starting a second
      // fetch, and one git-auth resolve serves both reads.
      allowStaleMirrorReads();
      let gitProject;
      let manifest;
      try {
        gitProject = await withProjectGitAuth(loaded.row);
        manifest = await loadManifestForEdit(gitProject);
      } catch (e) {
        return c.json(
          { error: (e as Error).message || 'failed to read manifest', code: 'manifest_read' },
          400,
        );
      }

      const read = readAgentBlockV2(manifest, agentName);
      if (!read.ok) return c.json({ error: read.error, code: 'manifest_malformed' }, 400);

      let block:
        | (AgentBlockV2 & { behavior?: Record<string, unknown>; opencode?: Record<string, unknown> })
        | null = read.block;
      if (read.schemaVersion === 2) {
        const behavior = behaviorOf(
          await readAgentMarkdown(
            gitProject,
            loaded.row.defaultBranch,
            manifest.raw,
            agentName,
          ).catch(() => ({ frontmatter: {}, body: '' })),
        );
        // `opencode` is the pre-W4 name of `behavior`, served until clients move.
        block = { ...(read.block ?? {}), behavior, opencode: behavior };
      }

      // The harness a new session of this project runs, and the agent settings
      // it ignores, so the editor marks them instead of letting them look applied.
      const harness = selectSessionHarness({
        piHarnessFlag: resolveFeatureFlag(loaded.row.metadata, 'pi_harness'),
        runtime: manifestRuntime(manifest.raw),
        llmGateway: projectLlmGatewayEnabled(loaded.row.metadata),
      });

      return c.json({
        agent: agentName,
        schema_version: read.schemaVersion,
        editable: read.schemaVersion === 2,
        default_agent: read.defaultAgent,
        block,
        harness,
        ignored_settings: ignoredAgentSettings(harness),
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
        ...errors(400, 403, 404, 409, 502),
      },
    }),
    async (c: any) => {
      const projectId = c.req.param('projectId');
      const loaded = await loadProjectForUser(c, projectId, 'manage');
      if (!loaded) return c.json({ error: 'Not found' }, 404);
      await assertAgentSessionWorkspaceAllowsRepository(c, loaded.row.accountId, projectId);
      await assertProjectCapability(
        c,
        loaded.userId,
        loaded.row.accountId,
        projectId,
        PROJECT_ACTIONS.PROJECT_AGENT_WRITE,
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
        const writes = manifestWrites(manifest, manifestPath);
        await commitMultipleFilesToBranch(gitProject, {
          files: writes.files,
          alsoExpect: writes.alsoExpect,
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
        if (isRemotePushPolicyRejection(error)) {
          return c.json(pushPolicyRejectedBody(loaded.row.defaultBranch), 409);
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
      summary: 'Set an agent\'s configuration',
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
      await assertAgentSessionWorkspaceAllowsRepository(c, loaded.row.accountId, projectId);
      await assertProjectCapability(
        c,
        loaded.userId,
        loaded.row.accountId,
        projectId,
        PROJECT_ACTIONS.PROJECT_AGENT_WRITE,
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
      const {
        behavior: behaviorName,
        opencode: preW4BehaviorName,
        file: requestedFile,
        ...governanceRaw
      } = parsed.data;
      // Resolved against the current `.md` below, once it is read (v2 only).
      let behaviorDraft = behaviorName ?? preW4BehaviorName;
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

      // `file` is server-owned (see the header). Resolve the `.md` against the
      // CURRENT manifest, before the block is replaced: an explicit `file` stays,
      // otherwise the path found (or about to be written) is recorded.
      let agentMd: Awaited<ReturnType<typeof readAgentMarkdown>> | null = null;
      if (manifest.schemaVersion === 2) {
        try {
          agentMd = await readAgentMarkdown(loaded.row, loaded.row.defaultBranch, manifest.raw, agentName);
        } catch (err) {
          return c.json(
            { error: `Failed to read the agent's .md: ${(err as Error).message || String(err)}` },
            502,
          );
        }
        const resolved = resolveBehaviorDraft(
          { behavior: behaviorName, opencode: preW4BehaviorName },
          behaviorOf(agentMd),
        );
        if (!resolved.ok) return c.json({ error: resolved.error, code: 'invalid_body' }, 400);
        behaviorDraft = resolved.draft;
        const currentBlock = readAgentBlockV2(manifest, agentName);
        const explicitFile = currentBlock.ok ? currentBlock.block?.file : undefined;
        if (explicitFile !== undefined) governanceBlock.file = explicitFile;
        else if (agentMd.exists || behaviorDraft !== undefined) governanceBlock.file = agentMd.path;
        if (requestedFile !== undefined && requestedFile !== governanceBlock.file) {
          return c.json(
            {
              error: `agents.${agentName}.file is "${governanceBlock.file ?? agentMd.path}" and cannot be changed here. Move the file in the repository and update kortix.yaml in the same commit.`,
              code: 'invalid_config',
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
      // An agent grants only what it holds (services/iam/agent-grant-ceiling.ts).
      await assertNoGrantEscalation(governedAgentWriter(c), projectId, grantsByAgent(extractAgents(manifest)), grantsByAgent(parsedCheck));

      // Validate the behavior half (if the request touches it at all) BEFORE
      // committing anything — a bad frontmatter shape must never land a
      // governance-only half-write.
      let mdPath: string | null = null;
      let nextFrontmatter: Record<string, unknown> | null = null;
      let nextBody: string | null = null;
      if (behaviorDraft !== undefined && agentMd) {
        mdPath = agentMd.path;
        const existing = agentMd;
        const draftRecord: Record<string, unknown> = { ...behaviorDraft };
        delete draftRecord.prompt;
        nextFrontmatter = mergeFrontmatter(existing.frontmatter, draftRecord);
        nextBody = behaviorDraft.prompt ?? '';

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
      // uninstall paths use for their own atomic multi-file writes (marketplace-install-session.ts).
      const writes = manifestWrites(manifest, manifestPath);
      const files = [...writes.files, ...(behaviorWrite ? [behaviorWrite] : [])];
      const message = behaviorWrite
        ? `chore: update agent ${agentName} governance + behavior`
        : `chore: update agent ${agentName} governance`;

      try {
        const gitProject = await withProjectGitAuth(loaded.row);
        await commitMultipleFilesToBranch(gitProject, {
          files,
          alsoExpect: writes.alsoExpect,
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
        if (isRemotePushPolicyRejection(err)) {
          return c.json(pushPolicyRejectedBody(loaded.row.defaultBranch), 409);
        }
        return c.json(
          { error: `Failed to commit agent config: ${(err as Error).message || String(err)}` },
          502,
        );
      }

      const read = readAgentBlockV2(manifest, agentName);
      const responseBehavior =
        nextFrontmatter !== null
          ? { ...pickBehaviorFields(nextFrontmatter), ...(nextBody ? { prompt: nextBody } : {}) }
          : undefined;
      return c.json({
        ok: true,
        agent: agentName,
        schema_version: manifest.schemaVersion,
        block: read.ok
          ? {
              ...(read.block ?? {}),
              ...(responseBehavior ? { behavior: responseBehavior, opencode: responseBehavior } : {}),
            }
          : governanceBlock,
      });
    },
  );
}
