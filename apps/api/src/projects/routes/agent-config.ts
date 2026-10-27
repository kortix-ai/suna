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
// kortix_version 3: the same wire shape maps onto ONE kortix.yaml block —
// behavior keys and grants — plus the prompt, written to the block's
// `prompt_file` (served as `file`) or inline `prompt`. No `.md` frontmatter is
// written for v3 (see `agentConfigViewV3` / `applyAgentConfigV3` in
// ../lib/agent-config-v2.ts).
//
// A v1 (`[[agents]]`) manifest has no representation for the governance field
// space, so PUT refuses a v1 project with a clear 400 (the UI degrades to the
// limited scope editor + an upgrade hint instead of ever calling PUT here). GET
// still works on a v1 project — it reports schemaVersion:1 + a null block so
// the UI can branch.
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
import { PROJECT_ACTIONS } from '../../iam/actions';
import { RESPONSE_ISSUE_LIMIT, auth, boundedIssues, errors, json } from '../../openapi';
import { db } from '../../shared/db';
import { resolveTemplateBySlug } from '../../snapshots/templates';
import { extractAgents, agentNotDeclaredError, grantsByAgent } from '../agents';
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
  agentConfigViewV3,
  applyAgentBlockV2,
  applyAgentConfigV3,
  applyDefaultAgentV2,
  normalizeRequiredConnectorAliases,
  resolveBehaviorDraft,
  readAgentBlockV2,
  dropEmptyPolicySets,
} from '../lib/agent-config-v2';
import { parseAgentMarkdown, serializeAgentMarkdown } from '../lib/agent-markdown';
import { projectsApp } from '../lib/app';
import {
  KNOWN_BEHAVIOR_KEYS,
  OpencodeAgentConfigSchema,
  readAgentMarkdownFile,
} from '../lib/compile-agent-config';
import { withProjectGitAuth } from '../lib/git';
import { metadataMerge } from '../lib/metadata-merge';
import { loadManifestForEdit } from '../lib/triggers';
import { allowStaleMirrorReads } from '../git/mirror';
import { MANIFEST_FILENAME, manifestWrites } from '../triggers';

// A grant set on the wire: an allowlist, or the "all"/"none" sentinels. The
// deep per-entry validation (grantable kortix_permissions actions, etc.) happens in
// validateManifest via applyAgentBlockV2 — this schema only guards the shape.
const GrantSetSchema = z.union([
  z.literal('all'),
  z.literal('none'),
  z.array(z.string().min(1).max(200)).max(500),
]);

// `agents.<name>.tools` (`AgentToolsV2`): all/none, an allowlist, an
// exclude list, or the earlier name → boolean map. validateManifest checks the names.
const AgentToolsSchema = z.union([
  z.literal('all'),
  z.literal('none'),
  z.array(z.string().min(1).max(200)).max(500),
  z.object({ exclude: z.array(z.string().min(1).max(200)).max(500) }).strict(),
  z.record(z.string(), z.boolean()),
]);

// The KORTIX layer — governance only (spec §2.2 redirect). No model, no
// description, no behavior: those all moved into `opencode` (defined in
// ../lib/compile-agent-config alongside its canonical KNOWN_BEHAVIOR_KEYS —
// see that module for why), which this route writes to the `.md`, never to
// kortix.yaml.
const AgentBlockSchema = z
  .object({
    enabled: z.boolean().optional(),
    tools: AgentToolsSchema.optional(),
    sandbox: z.string().min(1).max(128).regex(SLUG_RE).optional(),
    connectors: GrantSetSchema.optional(),
    connectors_required: z.array(z.string().trim().min(1).max(200)).max(500).optional(),
    // Deprecated request alias. The handler normalizes it before serialization.
    connectors_personal: z.array(z.string().min(1).max(200)).max(500).optional(),
    // Connector slug → policy set name. A PUT that omits it keeps the declared
    // value; a PUT that changes it needs project.connector.write too.
    policy_sets: z.record(z.string().min(1).max(128), z.string().max(64)).optional(),
    secrets: GrantSetSchema.optional(),
    skills: GrantSetSchema.optional(),
    // Kortix Apps (by slug) this agent may open when restricted/private (§2.5).
    apps: GrantSetSchema.optional(),
    kortix_permissions: GrantSetSchema.optional(),
    // kortix_version 3 grants. A PUT that omits one keeps the declared value.
    subagents: GrantSetSchema.optional(),
    commands: GrantSetSchema.optional(),
    extensions: GrantSetSchema.optional(),
    codemode: z.enum(['on', 'only', 'off']).optional(),
    // Deprecated request alias of kortix_permissions. The handler normalizes it
    // (normalizeKortixPermissionAliases) before serialization.
    kortix_cli: GrantSetSchema.optional(),
    repository_access: z.boolean().optional(),
    // Deprecated input alias for older clients.
    workspace: z.enum(['runtime', 'read', 'branch']).optional(),
    // Server-owned; accepted so a GET → PUT round trip keeps working. Only the
    // value already in effect is allowed (see the PUT handler). v2: the agent's
    // `.md`; v3: its `prompt_file`.
    file: z.string().max(1024).optional(),
    // The agent's behavior half (v2: `.md` frontmatter + body as `prompt`;
    // v3: the behavior keys of its kortix.yaml block + its prompt).
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
      // another replica, and the editor must read back what was saved. It proves the default branch
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

      // A name the manifest does not declare is a 404, not an empty success:
      // the dashboard's editor contract says a missing agent answers 404 (its
      // not-found state comes from /detail), and the CLI's `agents config` /
      // `agents scope --show` must not exit 0 on a phantom agent
      // (KRTX-2071/KRTX-2535). v1 keeps its declared-agent null block (v1
      // always reads back null), so the declared check runs on the manifest's
      // own roster.
      if (read.block === null) {
        const notDeclared = agentNotDeclaredError(manifest, agentName);
        if (notDeclared) return c.json(notDeclared, 404);
      }

      let block:
        | (AgentBlockV2 & { behavior?: Record<string, unknown>; opencode?: Record<string, unknown> })
        | null = read.block;
      if (read.schemaVersion >= 3) {
        // v3: one YAML block holds behavior and grants; the prompt is inline or in `prompt_file`.
        if (read.block) {
          const raw = read.block as Record<string, unknown>;
          const promptText = await readPromptFileV3(gitProject, loaded.row.defaultBranch, raw).catch(() => null);
          const view = agentConfigViewV3(raw, promptText);
          block = { ...view.governance, behavior: view.behavior, opencode: view.behavior } as typeof block;
        }
      } else if (read.schemaVersion === 2) {
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

      return c.json({
        agent: agentName,
        schema_version: read.schemaVersion,
        editable: read.schemaVersion >= 2,
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
        ...governanceRaw
      } = parsed.data;
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

      // v3: behavior, grants and prompt are one YAML block plus its prompt file.
      // v2: governance in kortix.yaml, behavior in the agent's `.md`.
      const edit =
        manifest.schemaVersion >= 3
          ? await prepareAgentConfigV3(loaded.row, manifest, agentName, {
              governance: governanceBlock,
              requestedFile,
              behavior: behaviorName,
              opencode: preW4BehaviorName,
            })
          : await prepareAgentConfigV2(loaded.row, manifest, agentName, {
              governance: governanceBlock,
              requestedFile,
              behavior: behaviorName,
              opencode: preW4BehaviorName,
            });
      if (!edit.ok) return c.json(edit.body, edit.status);

      // `policy_sets: {}` clears the agent's sets: write no key at all.
      const writtenBlock = (edit.raw.agents as Record<string, Record<string, unknown>> | undefined)?.[agentName];
      if (writtenBlock) dropEmptyPolicySets(writtenBlock);
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
      // landed, stranding kortix.yaml and the agent's `.md` out of sync —
      // commitMultipleFilesToBranch (git/branches.ts) commits every file in one
      // tree/commit, same helper the marketplace install/uninstall paths use
      // for their own atomic multi-file writes (marketplace-install-session.ts).
      const writes = manifestWrites(manifest, manifestPath);
      const files = [...writes.files, ...(edit.extraWrite ? [edit.extraWrite] : [])];
      const message = edit.extraWrite
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

      return c.json({
        ok: true,
        agent: agentName,
        schema_version: manifest.schemaVersion,
        block: edit.responseBlock(manifest),
      });
    },
  );
}

type AgentConfigEditInput = {
  governance: AgentBlockV2;
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

/** v2: governance → the kortix.yaml block (with `file`), behavior → the agent's `.md` frontmatter + body. */
async function prepareAgentConfigV2(
  row: Parameters<typeof withProjectGitAuth>[0],
  manifest: ManifestForEdit,
  agentName: string,
  input: AgentConfigEditInput,
): Promise<AgentConfigEdit> {
  const governanceBlock: AgentBlockV2 = { ...input.governance };
  let behaviorDraft = input.behavior ?? input.opencode;
  // `file` is server-owned (see the header). Resolve the `.md` against the
  // CURRENT manifest, before the block is replaced: an explicit `file` stays,
  // otherwise the path found (or about to be written) is recorded.
  let agentMd: Awaited<ReturnType<typeof readAgentMarkdown>> | null = null;
  if (manifest.schemaVersion === 2) {
    try {
      agentMd = await readAgentMarkdown(row, row.defaultBranch, manifest.raw, agentName);
    } catch (err) {
      return { ok: false, status: 502, body: { error: `Failed to read the agent's .md: ${(err as Error).message || String(err)}` } };
    }
    const resolved = resolveBehaviorDraft({ behavior: input.behavior, opencode: input.opencode }, behaviorOf(agentMd));
    if (!resolved.ok) return { ok: false, status: 400, body: { error: resolved.error, code: 'invalid_body' } };
    behaviorDraft = resolved.draft;
    const currentBlock = readAgentBlockV2(manifest, agentName);
    // The write replaces the whole block. Keys this body cannot carry
    // (`harnesses`, `network_egress`) are not this editor's to delete: keep
    // them, as the v3 write does.
    for (const [key, value] of Object.entries((currentBlock.ok && currentBlock.block) || {})) {
      if (!(key in AgentBlockSchema.shape)) (governanceBlock as Record<string, unknown>)[key] = value;
    }
    // `policy_sets` is in the schema (the GET → PUT round trip carries it) but
    // keeps the declared value when omitted, like the v3 grants.
    const declaredSets = currentBlock.ok ? (currentBlock.block as Record<string, unknown> | null)?.policy_sets : undefined;
    if ((governanceBlock as Record<string, unknown>).policy_sets === undefined && declaredSets !== undefined) {
      (governanceBlock as Record<string, unknown>).policy_sets = declaredSets;
    }
    const explicitFile = currentBlock.ok ? currentBlock.block?.file : undefined;
    if (explicitFile !== undefined) governanceBlock.file = explicitFile;
    else if (agentMd.exists || behaviorDraft !== undefined) governanceBlock.file = agentMd.path;
    if (input.requestedFile !== undefined && input.requestedFile !== governanceBlock.file) {
      return {
        ok: false,
        status: 400,
        body: {
          error: `agents.${agentName}.file is "${governanceBlock.file ?? agentMd.path}" and cannot be changed here. Move the file in the repository and update kortix.yaml in the same commit.`,
          code: 'invalid_config',
        },
      };
    }
  }

  const applied = applyAgentBlockV2(manifest, agentName, governanceBlock);
  if (!applied.ok) return { ok: false, status: 400, body: { error: applied.error, code: 'invalid_config', ...boundedIssues(applied.issues) } };

  // Validate the behavior half (if the request touches it at all) BEFORE
  // committing anything — a bad frontmatter shape must never land a
  // governance-only half-write.
  let extraWrite: { path: string; content: string } | null = null;
  let responseBehavior: Record<string, unknown> | undefined;
  if (behaviorDraft !== undefined && agentMd) {
    const draftRecord: Record<string, unknown> = { ...behaviorDraft };
    delete draftRecord.prompt;
    const nextFrontmatter = mergeFrontmatter(agentMd.frontmatter, draftRecord);
    const nextBody = behaviorDraft.prompt ?? '';
    const issues: ManifestIssue[] = [];
    validateAgentMdFrontmatter(nextFrontmatter, `agents.${agentName}`, issues);
    const errorIssues = issues.filter((i) => i.severity === 'error');
    if (errorIssues.length > 0) {
      return {
        ok: false,
        status: 400,
        body: { error: errorIssues.slice(0, RESPONSE_ISSUE_LIMIT).map((i) => `${i.path}: ${i.message}`).join('; '), code: 'invalid_config', ...boundedIssues(errorIssues) },
      };
    }
    extraWrite = { path: agentMd.path, content: serializeAgentMarkdown(nextFrontmatter, nextBody) };
    responseBehavior = { ...pickBehaviorFields(nextFrontmatter), ...(nextBody ? { prompt: nextBody } : {}) };
  }

  return {
    ok: true,
    raw: applied.raw,
    extraWrite,
    responseBlock: (written) => {
      const read = readAgentBlockV2(written, agentName);
      return read.ok
        ? { ...(read.block ?? {}), ...(responseBehavior ? { behavior: responseBehavior, opencode: responseBehavior } : {}) }
        : governanceBlock;
    },
  };
}

/** v3: behavior and grants → the agent's kortix.yaml block, the prompt → its `prompt_file` (or inline). */
async function prepareAgentConfigV3(
  row: Parameters<typeof withProjectGitAuth>[0],
  manifest: ManifestForEdit,
  agentName: string,
  input: AgentConfigEditInput,
): Promise<AgentConfigEdit> {
  const current = readAgentBlockV2(manifest, agentName);
  if (!current.ok) return { ok: false, status: 400, body: { error: current.error, code: 'manifest_malformed' } };
  const currentBlock = current.block as Record<string, unknown> | null;
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
      const view = agentConfigViewV3(((read.ok ? read.block : null) ?? {}) as Record<string, unknown>, promptWrite?.content ?? promptText);
      return { ...view.governance, behavior: view.behavior, opencode: view.behavior };
    },
  };
}
