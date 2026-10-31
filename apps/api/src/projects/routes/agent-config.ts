// Agent-config CRUD — the dashboard "agent builder" surface.
//
// One kortix.yaml block per agent holds its behavior keys and grants, plus the
// prompt: inline `prompt`, or the file its `prompt_file` names (served as
// `file`). The wire shape is `block` (grants) plus `block.behavior` (behavior +
// `prompt`); see `agentConfigViewV3` / `applyAgentConfigV3` in
// ../lib/agent-config-v2.ts. PUT writes kortix.yaml and, at most, the prompt
// file in ONE atomic commit (commitMultipleFilesToBranch) after validating, so
// a bad request never partially lands.
//
// Distinct from ./agent-scope.ts, which writes ONLY the grant subset
// (secrets/connectors/apps/policy sets).
//
// Manager-gated on project.agent.write (same leaf the scope editor
// and every other customize mutation use), threaded through
// assertProjectCapability so the agent-grant fold fires.

import { createRoute, z } from '@hono/zod-openapi';
import { ignoredAgentSettings } from '@kortix/api-contract/runtime-relay';
import { projects } from '@kortix/db';
import {
  type ManifestIssue,
  SLUG_RE,
  SPACE_SLUG_RE,
} from '@kortix/manifest-schema';
import { eq } from 'drizzle-orm';
import { PROJECT_ACTIONS } from '../../iam/actions';
import { auth, boundedIssues, errors, json } from '../../openapi';
import { db } from '../../shared/db';
import { resolveTemplateBySlug } from '../../snapshots/templates';
import { extractAgents, agentNotDeclaredError, grantsByAgent } from '../agents';
import { projectBuiltinAgents } from '../lib/builtin-agents';
import { builtinAgentConfigView, builtinAgentWriteRefusal, enabledBuiltinAgentKey } from '../lib/my-kortix-agent';
import { assertNoGrantEscalation, changedPolicySet } from '../../iam/agent-grant-ceiling';
import { isRepoFileNotFoundError, readRepoFile } from '../git';
import { GitFileRevisionConflictError, commitMultipleFilesToBranch } from '../git/branches';
import { isRemotePushPolicyRejection } from '../git/mirror';
import {
  assertAgentSessionWorkspaceAllowsRepository,
  assertProjectCapability,
  loadProjectForUser,
} from '../lib/access';
import {
  type AgentBlock,
  agentConfigViewV3,
  applyAgentConfigV3,
  applyDefaultAgentV2,
  normalizeRequiredConnectorAliases,
  resolveBehaviorDraft,
  readAgentBlockV2,
  dropEmptyPolicySets,
} from '../lib/agent-config-v2';
import { projectsApp } from '../lib/app';
import { OpencodeAgentConfigSchema } from '../lib/compile-agent-config';
import { withProjectGitAuth } from '../lib/git';
import { metadataMerge } from '../lib/metadata-merge';
import { loadManifestForEdit } from '../lib/triggers';
import { allowStaleMirrorReads } from '../git/mirror';
import { MANIFEST_FILENAME, manifestWrites } from '../triggers';
import { rethrowDatabaseError } from '../../shared/database-errors';

// A grant set on the wire: an allowlist, or the "all"/"none" sentinels. The
// deep per-entry validation (grantable kortix_permissions actions, etc.) happens in
// validateManifest via applyAgentConfigV3 — this schema only guards the shape.
const GrantSetSchema = z.union([
  z.literal('all'),
  z.literal('none'),
  z.array(z.string().min(1).max(200)).max(500),
]);

// `agents.<name>.skills` / `.extensions`: a grant set, or `{ exclude }`:
// every registered name but those. validateManifest checks every name.
const ExcludableGrantSetSchema = z.union([
  GrantSetSchema,
  z.object({ exclude: z.array(z.string().min(1).max(200)).max(500) }).strict(),
]);

// `agents.<name>.tools`: all/none, an allowlist, or an exclude list.
// validateManifest checks the names.
const AgentToolsSchema = z.union([
  z.literal('all'),
  z.literal('none'),
  z.array(z.string().min(1).max(200)).max(500),
  z.object({ exclude: z.array(z.string().min(1).max(200)).max(500) }).strict(),
]);

// The agent's grants and settings (`block`); its behavior rides in `behavior`.
const AgentBlockSchema = z
  .object({
    enabled: z.boolean().optional(),
    tools: AgentToolsSchema.optional(),
    sandbox: z.string().min(1).max(128).regex(SLUG_RE).optional(),
    // The agent's space (`agents.<name>.space`). Grouping only.
    // Empty string clears it (the handler drops empties).
    space: z.union([z.literal(''), z.string().min(1).max(63).regex(SPACE_SLUG_RE)]).optional(),
    connectors: GrantSetSchema.optional(),
    connectors_required: z.array(z.string().trim().min(1).max(200)).max(500).optional(),
    // Deprecated request alias. The handler normalizes it before serialization.
    connectors_personal: z.array(z.string().min(1).max(200)).max(500).optional(),
    // Connector slug → policy set name. A PUT that omits it keeps the declared
    // value; a PUT that changes it needs project.connector.write too.
    policy_sets: z.record(z.string().min(1).max(128), z.string().max(64)).optional(),
    secrets: GrantSetSchema.optional(),
    skills: ExcludableGrantSetSchema.optional(),
    // Kortix Apps (by slug) this agent may open when restricted/private (§2.5).
    apps: GrantSetSchema.optional(),
    kortix_permissions: GrantSetSchema.optional(),
    // A PUT that omits one of these grants keeps the declared value.
    subagents: GrantSetSchema.optional(),
    commands: GrantSetSchema.optional(),
    extensions: ExcludableGrantSetSchema.optional(),
    codemode: z.enum(['on', 'only', 'off']).optional(),
    // Deprecated request alias of kortix_permissions. The handler normalizes it
    // (normalizeKortixPermissionAliases) before serialization.
    kortix_cli: GrantSetSchema.optional(),
    repository_access: z.boolean().optional(),
    // Deprecated input alias for older clients.
    workspace: z.enum(['runtime', 'read', 'branch']).optional(),
    // Server-owned; accepted so a GET → PUT round trip keeps working. Only the
    // value already in effect (the block's `prompt_file`) is allowed.
    file: z.string().max(1024).optional(),
    // The agent's behavior half: the behavior keys of its kortix.yaml block + its prompt.
    behavior: OpencodeAgentConfigSchema.optional(),
    // The pre-W4 name of `behavior`; see resolveBehaviorDraft.
    opencode: OpencodeAgentConfigSchema.optional(),
    // Server-owned: the GET returns them, so a GET → PUT round trip carries
    // them back. The handler drops them and the declared
    // value stays. Strict-rejecting them made every save of such an agent 400.
    network_egress: z.unknown().optional(),
    harnesses: z.unknown().optional(),
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

/** A v3 agent's prompt file text on `branch`, or null when it names none or the file is absent. */
async function readPromptFileV3(
  project: Parameters<typeof withProjectGitAuth>[0] | Awaited<ReturnType<typeof withProjectGitAuth>>,
  branch: string,
  block: Record<string, unknown> | null,
): Promise<string | null> {
  const path = block?.prompt_file;
  if (typeof path !== 'string') return null;
  const gitProject = 'gitAuthToken' in project ? project : await withProjectGitAuth(project);
  try {
    return await readRepoFile(gitProject, path, branch);
  } catch (err) {
    if (isRepoFileNotFoundError(err)) return null;
    throw err;
  }
}

export function registerAgentConfigRoutes(): void {
  // GET /v1/projects/:projectId/agents/:agentName/config
  // The agent's block for editing: grants as `block`, behavior + prompt as
  // `block.behavior`.
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
      // another replica, and the editor must read back what was saved. It proves the default branch
      // with one `ls-remote` and fetches only when it moved. The prompt-file read
      // below then uses that just-proven mirror instead of starting a second
      // fetch, and one git-auth resolve serves both reads.
      allowStaleMirrorReads();
      let gitProject;
      let manifest;
      try {
        gitProject = await withProjectGitAuth(loaded.row);
        manifest = await loadManifestForEdit(gitProject);
      } catch (e) {
        rethrowDatabaseError(e);
        return c.json(
          { error: (e as Error).message || 'failed to read manifest', code: 'manifest_read' },
          400,
        );
      }

      const read = readAgentBlockV2(manifest, agentName);
      if (!read.ok) return c.json({ error: read.error, code: 'manifest_malformed' }, 400);

      // A built-in agent the project runs (My Kortix, slug `mykortix`) is listed by
      // /detail but declared nowhere in kortix.yaml. Its config is
      // platform-owned: answer the read-only view, never the roster 404.
      const builtinKey = enabledBuiltinAgentKey(agentName, projectBuiltinAgents(manifest.raw, loaded.row.metadata));
      if (builtinKey) return c.json(builtinAgentConfigView(builtinKey, read.defaultAgent));

      // A name the manifest does not declare is a 404, not an empty success:
      // the dashboard's editor contract says a missing agent answers 404 (its
      // not-found state comes from /detail), and the CLI's `agents config` /
      // `agents scope --show` must not exit 0 on a phantom agent
      // (KRTX-2071/KRTX-2535).
      if (read.block === null) {
        const notDeclared = agentNotDeclaredError(manifest, agentName);
        if (notDeclared) return c.json(notDeclared, 404);
      }

      // One YAML block holds behavior and grants; the prompt is inline or in `prompt_file`.
      let block: Record<string, unknown> | null = null;
      if (read.block) {
        const promptText = await readPromptFileV3(gitProject, loaded.row.defaultBranch, read.block).catch(() => null);
        const view = agentConfigViewV3(read.block, promptText);
        // `opencode` is the pre-W4 name of `behavior`, served until clients move.
        block = { ...view.governance, behavior: view.behavior, opencode: view.behavior };
      }

      return c.json({
        agent: agentName,
        // Wire constant: clients released before the one manifest format read it.
        schema_version: 3,
        editable: true,
        default_agent: read.defaultAgent,
        block,
        // Every new session runs pi. The editor marks the agent settings pi
        // ignores instead of letting them look applied.
        harness: 'pi',
        ignored_settings: ignoredAgentSettings('pi'),
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
      const loaded = await loadProjectForUser(c, projectId, 'read');
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
          { error: 'Invalid body', code: 'invalid_body', ...boundedIssues(parsed.error.issues) },
          400,
        );
      }
      const agentName = parsed.data.agent.trim();

      let manifest: Awaited<ReturnType<typeof loadManifestForEdit>>;
      try {
        manifest = await loadManifestForEdit(loaded.row);
      } catch (error) {
        rethrowDatabaseError(error);
        return c.json(
          { error: (error as Error).message || 'failed to read manifest', code: 'manifest_read' },
          400,
        );
      }

      const applied = applyDefaultAgentV2(manifest, agentName);
      if (!applied.ok) {
        return c.json({ error: applied.error, code: 'invalid_config', ...boundedIssues(applied.issues) }, 400);
      }

      manifest.raw = applied.raw;
      const manifestPath = manifest.path || loaded.row.manifestPath || MANIFEST_FILENAME;
      try {
        const gitProject = await withProjectGitAuth(loaded.row);
        const writes = manifestWrites(manifest, manifestPath);
        await commitMultipleFilesToBranch(gitProject, {
          files: writes.files,
          deletes: writes.deletes,
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
        rethrowDatabaseError(error);
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
  // Replace the agent's block in kortix.yaml (validated via the manifest-schema
  // validator), and the prompt file when the prompt changed. Both are written
  // in one commit.
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
      const loaded = await loadProjectForUser(c, projectId, 'read');
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
          { error: 'Invalid body', code: 'invalid_body', ...boundedIssues(parsed.error.issues) },
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
        network_egress: _declaredEgress,
        harnesses: _declaredHarnesses,
        ...governanceRaw
      } = parsed.data;
      const normalizedGovernance = normalizeRequiredConnectorAliases(governanceRaw);
      if (!normalizedGovernance.ok) {
        return c.json({ error: normalizedGovernance.error, code: 'invalid_body' }, 400);
      }
      const governanceBlock: AgentBlock = {};
      for (const [key, value] of Object.entries(normalizedGovernance.block)) {
        if (value === undefined) continue;
        // `space: ''` clears it: the block is a whole-block replace, so leaving
        // the key out removes it instead of writing an empty string.
        if (key === 'space' && value === '') continue;
        governanceBlock[key] = value;
      }

      let manifest;
      try {
        manifest = await loadManifestForEdit(loaded.row);
      } catch (e) {
        rethrowDatabaseError(e);
        return c.json(
          { error: (e as Error).message || 'failed to read manifest', code: 'manifest_read' },
          400,
        );
      }

      // A built-in agent's configuration is platform-owned: a write here would
      // only add an `agents.meta` block that the platform ignores.
      const builtinKey = enabledBuiltinAgentKey(agentName, projectBuiltinAgents(manifest.raw, loaded.row.metadata));
      if (builtinKey) return c.json(builtinAgentWriteRefusal(builtinKey), 409);

      if (typeof governanceBlock.sandbox === 'string') {
        try {
          await resolveTemplateBySlug(await withProjectGitAuth(loaded.row), governanceBlock.sandbox);
        } catch {
          return c.json(
            {
              error: `Unknown sandbox template "${governanceBlock.sandbox}"`,
              code: 'invalid_config',
              ...boundedIssues([
                {
                  path: `agents.${agentName}.sandbox`,
                  message: 'must name an available project template or "default".',
                  severity: 'error',
                },
              ]),
            },
            400,
          );
        }
      }

      // Behavior, grants and prompt are one YAML block plus its prompt file.
      const edit = await prepareAgentConfigV3(loaded.row, manifest, agentName, {
        governance: governanceBlock,
        requestedFile,
        behavior: behaviorName,
        opencode: preW4BehaviorName,
      });
      if (!edit.ok) return c.json(edit.body, edit.status);

      // `policy_sets: {}` clears the agent's sets: write no key at all.
      const writtenBlock = (edit.raw.agents as Record<string, Record<string, unknown>> | undefined)?.[agentName];
      if (writtenBlock) dropEmptyPolicySets(writtenBlock);
      // `tools` omitted is every tool, the one grant that defaults open: write
      // it so the file says what the agent holds.
      if (writtenBlock && writtenBlock.tools === undefined) writtenBlock.tools = 'all';
      // Re-parse through the runtime grant reader before committing.
      const parsedCheck = extractAgents({ ...manifest, raw: edit.raw });
      const parseProblem = parsedCheck.errors.find((e) => e.name === agentName);
      if (parseProblem) {
        return c.json({ error: parseProblem.error, code: 'invalid_config' }, 400);
      }
      // Changing which policy set an agent runs under is a rule edit.
      const grantBefore = grantsByAgent(extractAgents(manifest)).get(agentName);
      const grantAfter = grantsByAgent(parsedCheck).get(agentName);
      if (grantAfter && changedPolicySet(grantBefore, grantAfter) !== null) {
        await assertProjectCapability(
          c,
          loaded.userId,
          loaded.row.accountId,
          projectId,
          PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE,
        );
      }
      // An agent grants only what it holds (iam/agent-grant-ceiling.ts).
      await assertNoGrantEscalation(c, projectId, grantsByAgent(extractAgents(manifest)), grantsByAgent(parsedCheck));

      manifest.raw = edit.raw;
      const manifestPath = manifest.path || loaded.row.manifestPath || MANIFEST_FILENAME;

      // ONE atomic commit for every file the edit touches. Two sequential
      // single-file commits would let the second write fail AFTER the first
      // landed, stranding kortix.yaml and the agent's prompt file out of sync —
      // commitMultipleFilesToBranch (git/branches.ts) commits every file in one
      // tree/commit, same helper the marketplace install/uninstall paths use
      // for their own atomic multi-file writes (marketplace-install-session.ts).
      const writes = manifestWrites(manifest, manifestPath);
      // The edited prompt file wins over its healed copy (a legacy manifest's first write).
      const files = [...writes.files.filter((file) => file.path !== edit.extraWrite?.path), ...(edit.extraWrite ? [edit.extraWrite] : [])];
      const message = edit.extraWrite
        ? `chore: update agent ${agentName} + prompt`
        : `chore: update agent ${agentName} governance`;

      try {
        const gitProject = await withProjectGitAuth(loaded.row);
        await commitMultipleFilesToBranch(gitProject, {
          files,
          deletes: writes.deletes,
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
        rethrowDatabaseError(err);
        return c.json(
          { error: `Failed to commit agent config: ${(err as Error).message || String(err)}` },
          502,
        );
      }

      return c.json({
        ok: true,
        agent: agentName,
        // Wire constant: clients released before the one manifest format read it.
        schema_version: 3,
        block: edit.responseBlock(manifest),
      });
    },
  );
}

type AgentConfigEditInput = {
  governance: AgentBlock;
  requestedFile: string | undefined;
  behavior: z.infer<typeof OpencodeAgentConfigSchema> | undefined;
  opencode: z.infer<typeof OpencodeAgentConfigSchema> | undefined;
};

type ManifestForEdit = Awaited<ReturnType<typeof loadManifestForEdit>>;

/** One validated agent edit, ready to commit: the next manifest, at most one more file, and the PUT response block. */
type AgentConfigEdit =
  | {
      ok: true;
      raw: Record<string, unknown>;
      extraWrite: { path: string; content: string } | null;
      responseBlock: (manifest: ManifestForEdit) => object;
    }
  | { ok: false; status: 400 | 502; body: { error: string; code?: string; issues?: ManifestIssue[] } };

/** Behavior and grants → the agent's kortix.yaml block, the prompt → its `prompt_file` (or inline). */
async function prepareAgentConfigV3(
  row: Parameters<typeof withProjectGitAuth>[0],
  manifest: ManifestForEdit,
  agentName: string,
  input: AgentConfigEditInput,
): Promise<AgentConfigEdit> {
  const current = readAgentBlockV2(manifest, agentName);
  if (!current.ok) return { ok: false, status: 400, body: { error: current.error, code: 'manifest_malformed' } };
  const currentBlock = current.block;
  let promptText: string | null;
  try {
    promptText = await readPromptFileV3(row, row.defaultBranch, currentBlock);
  } catch (err) {
    return { ok: false, status: 502, body: { error: `Failed to read the agent's prompt file: ${(err as Error).message || String(err)}` } };
  }
  const stored = currentBlock ? agentConfigViewV3(currentBlock, promptText).behavior : {};
  const resolved = resolveBehaviorDraft({ behavior: input.behavior, opencode: input.opencode }, stored);
  if (!resolved.ok) return { ok: false, status: 400, body: { error: resolved.error, code: 'invalid_body' } };

  const applied = applyAgentConfigV3(manifest, agentName, {
    governance: { ...input.governance, ...(input.requestedFile !== undefined ? { file: input.requestedFile } : {}) },
    behavior: resolved.draft,
  });
  if (!applied.ok) return { ok: false, status: 400, body: { error: applied.error, code: 'invalid_config', ...boundedIssues(applied.issues) } };

  // An unchanged prompt file is not rewritten.
  const { promptWrite } = applied;
  const extraWrite = promptWrite && promptWrite.content !== promptText ? promptWrite : null;
  return {
    ok: true,
    raw: applied.raw,
    extraWrite,
    responseBlock: (written) => {
      const read = readAgentBlockV2(written, agentName);
      const view = agentConfigViewV3((read.ok ? read.block : null) ?? {}, promptWrite?.content ?? promptText);
      return { ...view.governance, behavior: view.behavior, opencode: view.behavior };
    },
  };
}
