import { createRoute, z } from '@hono/zod-openapi';
import {
  agentKnowledgeSources,
  agentProfileTestSessions,
  changeRequests,
  executorConnectionProfiles,
  executorConnectorActions,
  executorConnectors,
  projectSessions,
  projectTriggerExecutions,
  projectTriggerRuntime,
} from '@kortix/db';
import { SLUG_RE } from '@kortix/manifest-schema';
import { and, eq, inArray, ne, or } from 'drizzle-orm';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { resolveExperimentalFeature } from '../../experimental/features';
import { PROJECT_ACTIONS } from '../../iam/actions';
import { assertAgentScope } from '../../iam/agent-scope';
import { auth, errors, json } from '../../openapi';
import { db } from '../../shared/db';
import { serializeChangeRequest } from '../change-requests';
import { GitFileRevisionConflictError, commitMultipleFilesToBranch } from '../git/branches';
import { assertProjectCapability, loadProjectForUser } from '../lib/access';
import {
  AgentBranchNameCollisionError,
  changeRequestCreateFailedBody,
  cleanupAgentChangeBranch,
  createAgentChangeBranch,
  readAgentMarkdown,
} from '../lib/agent-config-route-helpers';
import {
  AgentKnowledgeInputError,
  completeAgentKnowledgeUploadRecord,
  createAgentKnowledgeSourceRecord,
  createAgentKnowledgeUploadRecord,
  enqueueAgentKnowledgeSync,
  getAgentKnowledgeSourceRecord,
  listAgentKnowledgeSourceRecords,
  revokeAgentKnowledgeSourceRecord,
} from '../lib/agent-knowledge-sources';
import {
  loadPublishedAgentProfile,
  serializeAgentKnowledgeSource,
  serializeAgentProfileDraft,
} from '../lib/agent-profile';
import {
  createAgentProfileChangeRequest,
  findOpenAgentProfileChangeRequest,
} from '../lib/agent-profile-change-requests';
import { composeAgentProfileFiles } from '../lib/agent-profile-compose';
import {
  AgentProfileRevisionConflictError,
  discardAgentProfileDraftRecord,
  getAgentProfileDraftRecord,
  markAgentProfileDraftPublication,
  updateAgentProfileDraftRecord,
} from '../lib/agent-profile-drafts';
import type { AgentProfileSections } from '../lib/agent-profile-risk';
import {
  loadGitHubAgentSkills,
  loadMarketplaceAgentSkills,
} from '../lib/agent-profile-skill-sources';
import {
  AgentSkillImportError,
  type ValidatedAgentSkill,
  generateAgentSkill,
  readAgentSkillArchive,
} from '../lib/agent-profile-skills';
import { projectsApp } from '../lib/app';
import { agentMarkdownPath } from '../lib/compile-agent-config';
import { withProjectGitAuth } from '../lib/git';
import { loadManifestForEdit } from '../lib/triggers';
import { createSession } from '../session-lifecycle';
import { reconcileProjectTriggerRuntime } from '../trigger-runtime-catalog';
import { extractTriggers } from '../triggers';

const AgentProfileSectionSchema = z.enum([
  'instructions',
  'integrations',
  'knowledge',
  'skills',
  'automations',
  'advanced',
]);

const IntegrationSchema = z
  .object({
    profile_id: z.string().min(1).max(200),
    slug: z.string().regex(SLUG_RE),
    provider: z.string().min(1).max(200),
    display_name: z.string().min(1).max(500),
    scopes: z.array(z.string().min(1).max(500)).max(500),
    can_write: z.boolean(),
    status: z.enum(['available', 'pending_publication', 'revoked', 'error']),
    error: z.string().nullable(),
  })
  .strict();

const SkillFileSchema = z
  .object({
    path: z.string().min(1).max(1000),
    content: z.string().max(2 * 1024 * 1024),
  })
  .strict();

const SkillSchema = z
  .object({
    slug: z.string().regex(SLUG_RE),
    name: z.string().min(1).max(500),
    description: z.string().max(4000).nullable(),
    origin: z.enum(['project', 'marketplace', 'archive', 'github', 'generated']),
    status: z.enum(['available', 'pending_publication', 'error']),
    files: z.array(SkillFileSchema).max(100).optional(),
  })
  .strict()
  .superRefine((skill, context) => {
    const prefix = `.kortix/opencode/skills/${skill.slug}/`;
    for (const [index, file] of (skill.files ?? []).entries()) {
      if (
        !file.path.startsWith(prefix) ||
        file.path.includes('\\') ||
        file.path.split('/').includes('..')
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['files', index, 'path'],
          message: 'Skill file must remain inside its skill directory.',
        });
      }
    }
  });

const AutomationSchema = z
  .object({
    slug: z.string().regex(SLUG_RE),
    name: z.string().min(1).max(500),
    prompt: z.string().min(1).max(50_000).optional(),
    enabled: z.boolean(),
    schedule: z.string().min(1).max(500),
    timezone: z.string().min(1).max(200),
    next_runs: z.array(z.string()).max(5),
    status: z.enum(['active', 'paused', 'pending_publication', 'error']),
  })
  .strict();

const ProfileSectionsSchema = z
  .object({
    instructions: z.record(z.string(), z.any()).optional(),
    integrations: z.array(IntegrationSchema).max(500).optional(),
    knowledge: z
      .array(z.string().regex(SLUG_RE))
      .max(500)
      .refine((items) => !items.includes('all') && new Set(items).size === items.length, {
        message: 'knowledge must contain unique explicit source slugs',
      })
      .optional(),
    skills: z
      .array(SkillSchema)
      .max(500)
      .refine((items) => new Set(items.map((item) => item.slug)).size === items.length, {
        message: 'skills must contain unique slugs',
      })
      .optional(),
    automations: z.array(AutomationSchema).max(500).optional(),
    advanced: z.record(z.string(), z.any()).optional(),
  })
  .strict();

const DraftUpdateSchema = z
  .object({
    expectedRevision: z.number().int().min(0),
    sections: ProfileSectionsSchema,
  })
  .strict();

const ExpectedRevisionSchema = z.object({ expectedRevision: z.number().int().min(0) }).strict();

const PublishSchema = ExpectedRevisionSchema.extend({
  acknowledgeHighRisk: z.boolean().optional(),
}).strict();

const TestDraftSchema = ExpectedRevisionSchema.extend({
  includePendingWriteIntegrations: z.boolean().optional(),
}).strict();

const CreateSourceSchema = z
  .object({
    type: z.enum(['url', 'connector']),
    title: z.string().min(1).max(500),
    url: z.string().optional(),
    connectorProfileId: z.string().uuid().optional(),
    resourceId: z.string().min(1).max(2000).optional(),
    connectorAction: z.string().min(1).max(512).optional(),
    resourceArgument: z.string().min(1).max(256).optional(),
    automaticSync: z.boolean().optional(),
  })
  .strict();

const CreateUploadSchema = z
  .object({
    fileName: z.string().min(1).max(500),
    contentType: z.string().min(1).max(255),
    size: z.number().int().positive(),
  })
  .strict();

const CompleteUploadSchema = z.object({ uploadToken: z.string().min(1).max(4000) }).strict();

const ImportSkillArchiveSchema = z
  .object({
    fileName: z.string().min(1).max(500),
    dataBase64: z
      .string()
      .min(1)
      .max(14 * 1024 * 1024),
  })
  .strict();

const InstallMarketplaceSkillSchema = z.object({ itemId: z.string().min(1).max(1000) }).strict();

const ImportGitHubSkillSchema = z.object({ url: z.string().url().max(4000) }).strict();

const GenerateSkillSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    brief: z.string().min(1).max(12_000),
  })
  .strict();

const PauseAutomationResultSchema = z
  .object({
    ok: z.literal(true),
    slug: z.string().regex(SLUG_RE),
    paused_at: z.string().datetime(),
    cancelled_executions: z.number().int().min(0),
  })
  .strict();

type ProfileContext = {
  loaded: Awaited<ReturnType<typeof loadProjectForUser>> & {};
  published: Awaited<ReturnType<typeof loadPublishedAgentProfile>> & { ok: true };
  manifest: Awaited<ReturnType<typeof loadManifestForEdit>>;
};

type ProfileRouteContext = Omit<Context, 'req'> & {
  readonly req: Omit<Context['req'], 'param'> & {
    param(name: string): string;
    param(): Record<string, string>;
  };
};

type ProfileOpenApi = (
  route: unknown,
  handler: (context: ProfileRouteContext) => Promise<Response>,
) => void;

const profileOpenApi = projectsApp.openapi.bind(projectsApp) as unknown as ProfileOpenApi;

type ProfileIntegration = z.infer<typeof IntegrationSchema>;

function metadataScopes(value: Record<string, unknown>): string[] {
  const scopes = value.scopes;
  return Array.isArray(scopes)
    ? scopes.filter((scope): scope is string => typeof scope === 'string').sort()
    : [];
}

async function canonicalizeProfileIntegrations(
  context: ProfileContext,
  agentName: string,
  requested: ProfileIntegration[],
): Promise<
  | { ok: true; integrations: ProfileIntegration[] }
  | { ok: false; error: string; code: 'invalid_integration_profile' }
> {
  const published = Array.isArray(context.published.profile.sections.integrations)
    ? (context.published.profile.sections.integrations as ProfileIntegration[])
    : [];
  const publishedById = new Map(
    published.map((integration) => [integration.profile_id, integration]),
  );
  const persistedIds = requested
    .map((integration) => integration.profile_id)
    .filter((profileId) => !publishedById.has(profileId));
  const rows = persistedIds.length
    ? await db
        .select({
          profileId: executorConnectionProfiles.profileId,
          connectorId: executorConnectors.connectorId,
          slug: executorConnectors.slug,
          provider: executorConnectors.providerType,
          label: executorConnectionProfiles.label,
          metadata: executorConnectionProfiles.metadata,
        })
        .from(executorConnectionProfiles)
        .innerJoin(
          executorConnectors,
          eq(executorConnectors.connectorId, executorConnectionProfiles.connectorId),
        )
        .where(
          and(
            eq(executorConnectionProfiles.accountId, context.loaded.row.accountId),
            eq(executorConnectionProfiles.projectId, context.loaded.row.projectId),
            eq(executorConnectionProfiles.status, 'active'),
            eq(executorConnectors.accountId, context.loaded.row.accountId),
            eq(executorConnectors.projectId, context.loaded.row.projectId),
            eq(executorConnectors.status, 'active'),
            inArray(executorConnectionProfiles.profileId, persistedIds),
            or(
              eq(executorConnectionProfiles.ownerType, 'project'),
              and(
                eq(executorConnectionProfiles.ownerType, 'member'),
                eq(executorConnectionProfiles.ownerId, context.loaded.userId),
              ),
              and(
                eq(executorConnectionProfiles.ownerType, 'agent'),
                eq(executorConnectionProfiles.ownerId, agentName),
              ),
            ),
          ),
        )
    : [];
  const byId = new Map(rows.map((row) => [row.profileId, row]));
  if (byId.size !== new Set(persistedIds).size) {
    return {
      ok: false,
      code: 'invalid_integration_profile',
      error: 'One or more selected integration profiles are not active or visible to this user.',
    };
  }
  const connectorIds = [...new Set(rows.map((row) => row.connectorId))];
  const actions = connectorIds.length
    ? await db
        .select({
          connectorId: executorConnectorActions.connectorId,
          risk: executorConnectorActions.risk,
        })
        .from(executorConnectorActions)
        .where(inArray(executorConnectorActions.connectorId, connectorIds))
    : [];
  const writeConnectors = new Set(
    actions.filter((action) => action.risk !== 'read').map((action) => action.connectorId),
  );

  const integrations = requested.map((integration) => {
    const existing = publishedById.get(integration.profile_id);
    if (existing) return existing;
    const row = byId.get(integration.profile_id);
    if (!row) throw new Error('Integration canonicalization invariant failed.');
    return {
      profile_id: row.profileId,
      slug: row.slug,
      provider: row.provider,
      display_name: row.label,
      scopes: metadataScopes(row.metadata),
      can_write: row.metadata.can_write === true || writeConnectors.has(row.connectorId),
      status: 'pending_publication' as const,
      error: null,
    };
  });
  if (new Set(integrations.map((integration) => integration.slug)).size !== integrations.length) {
    return {
      ok: false,
      code: 'invalid_integration_profile',
      error: 'Select only one connection profile for each integration.',
    };
  }
  return { ok: true, integrations };
}

async function loadProfileContext(
  c: ProfileRouteContext,
  access: 'read' | 'write',
): Promise<ProfileContext | Response> {
  const projectId = c.req.param('projectId');
  const agentName = c.req.param('agentName');
  const loaded = await loadProjectForUser(c, projectId, access);
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  if (!resolveExperimentalFeature(loaded.row.metadata, 'agent_profile')) {
    return c.json(
      {
        error: 'Agent capability profiles are not enabled for this project.',
        code: 'feature_disabled',
      },
      404,
    );
  }
  if (access === 'write') {
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_AGENT_WRITE,
    );
  }
  let manifest: Awaited<ReturnType<typeof loadManifestForEdit>>;
  try {
    manifest = await loadManifestForEdit(loaded.row);
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : String(error), code: 'manifest_read' },
      400,
    );
  }
  const published = await loadPublishedAgentProfile({
    project: loaded.row,
    manifest,
    agentName,
  });
  if (!published.ok) {
    return c.json({ error: published.error, code: published.code }, published.status);
  }
  return { loaded, published, manifest };
}

function isResponse(value: ProfileContext | Response): value is Response {
  return value instanceof Response;
}

function editorFor(c: ProfileRouteContext) {
  return {
    displayName: (c.get('userEmail') as string | undefined) ?? null,
    avatarUrl: null,
  };
}

function conflictResponse(c: ProfileRouteContext, error: AgentProfileRevisionConflictError) {
  return c.json(
    {
      code: 'agent_profile_revision_conflict',
      expected_revision: error.expectedRevision,
      current_revision: error.currentRevision,
      conflicting_sections: error.conflictingSections,
      active_editors: error.activeEditors.map((entry) => ({
        user_id: entry.userId,
        display_name: entry.displayName,
        avatar_url: entry.avatarUrl,
        last_seen_at: entry.lastSeenAt,
      })),
    },
    409,
  );
}

function inputErrorResponse(c: ProfileRouteContext, error: unknown) {
  if (error instanceof AgentKnowledgeInputError || error instanceof AgentSkillImportError) {
    return c.json({ error: error.message, code: error.code }, 400);
  }
  throw error;
}

type SkillOrigin = 'marketplace' | 'archive' | 'github' | 'generated';

async function assertSkillWrite(context: ProfileContext, c: ProfileRouteContext): Promise<void> {
  await assertProjectCapability(
    c,
    context.loaded.userId,
    context.loaded.row.accountId,
    context.loaded.row.projectId,
    PROJECT_ACTIONS.PROJECT_SKILL_WRITE,
  );
}

async function stageSkills(
  c: ProfileRouteContext,
  context: ProfileContext,
  skills: ValidatedAgentSkill[],
  origin: SkillOrigin,
) {
  const projectId = context.loaded.row.projectId;
  const agentName = c.req.param('agentName');
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = await getAgentProfileDraftRecord(projectId, agentName);
    const raw = current?.sections.skills ?? context.published.profile.sections.skills ?? [];
    const existing = Array.isArray(raw)
      ? raw.filter(
          (entry): entry is Record<string, unknown> =>
            !!entry && typeof entry === 'object' && !Array.isArray(entry),
        )
      : [];
    const existingSlugs = new Set(
      existing
        .map((entry) => entry.slug)
        .filter((slug): slug is string => typeof slug === 'string'),
    );
    const duplicate = skills.find((skill) => existingSlugs.has(skill.slug));
    if (duplicate) {
      throw new AgentSkillImportError(
        'skill_slug_duplicate',
        `Agent already has a skill with slug "${duplicate.slug}".`,
      );
    }
    const next = [
      ...existing,
      ...skills.map((skill) => ({
        slug: skill.slug,
        name: skill.name,
        description: skill.description,
        origin,
        status: 'pending_publication' as const,
        files: skill.files,
      })),
    ];
    try {
      return await updateAgentProfileDraftRecord({
        accountId: context.loaded.row.accountId,
        projectId,
        agentName,
        userId: context.loaded.userId,
        editor: editorFor(c),
        expectedRevision: current?.revision ?? 0,
        baseRevision: context.published.profile.baseRevision,
        baseSections: context.published.profile.sections,
        sections: { skills: next },
      });
    } catch (error) {
      if (!(error instanceof AgentProfileRevisionConflictError) || attempt === 3) throw error;
    }
  }
  throw new Error('Skill staging retry limit reached.');
}

async function stageKnowledgeSlug(
  c: ProfileRouteContext,
  context: ProfileContext,
  slug: string,
  action: 'add' | 'remove',
): Promise<void> {
  const projectId = context.loaded.row.projectId;
  const agentName = c.req.param('agentName');
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = await getAgentProfileDraftRecord(projectId, agentName);
    const raw = current?.sections.knowledge ?? context.published.profile.sections.knowledge ?? [];
    const knowledge = Array.isArray(raw)
      ? raw.filter((entry): entry is string => typeof entry === 'string')
      : [];
    const next =
      action === 'add'
        ? [...new Set([...knowledge, slug])]
        : knowledge.filter((entry) => entry !== slug);
    if (
      next.length === knowledge.length &&
      next.every((entry, index) => entry === knowledge[index])
    ) {
      return;
    }
    try {
      await updateAgentProfileDraftRecord({
        accountId: context.loaded.row.accountId,
        projectId,
        agentName,
        userId: context.loaded.userId,
        editor: editorFor(c),
        expectedRevision: current?.revision ?? 0,
        baseRevision: context.published.profile.baseRevision,
        baseSections: context.published.profile.sections,
        sections: { knowledge: next },
      });
      return;
    } catch (error) {
      if (!(error instanceof AgentProfileRevisionConflictError) || attempt === 3) throw error;
    }
  }
}

async function draftAtRevision(
  c: ProfileRouteContext,
  context: ProfileContext,
  expectedRevision?: number,
) {
  const draft = await getAgentProfileDraftRecord(
    context.loaded.row.projectId,
    c.req.param('agentName'),
  );
  if (!draft) {
    return c.json({ error: 'No agent profile draft exists.', code: 'draft_not_found' }, 404);
  }
  if (expectedRevision !== undefined && draft.revision !== expectedRevision) {
    return conflictResponse(
      c,
      new AgentProfileRevisionConflictError(
        expectedRevision,
        draft.revision,
        draft.changedSections,
        draft.activeEditors,
      ),
    );
  }
  return draft;
}

async function composeDraft(
  c: ProfileRouteContext,
  context: ProfileContext,
  sections: AgentProfileSections,
) {
  const behaviorPath = agentMarkdownPath(context.manifest.raw, c.req.param('agentName'));
  const behavior = await readAgentMarkdown(
    context.loaded.row,
    context.loaded.row.defaultBranch,
    behaviorPath,
  );
  if (behavior.state === 'read_error') {
    return c.json({ error: behavior.error, code: 'behavior_file_read' }, 502);
  }
  const composed = composeAgentProfileFiles({
    manifest: context.manifest,
    agentName: c.req.param('agentName'),
    behavior,
    behaviorExists: behavior.state === 'exists',
    sections,
  });
  if (!composed.ok) {
    return c.json(
      {
        error: composed.error,
        code: composed.code,
        ...(composed.issues ? { issues: composed.issues } : {}),
      },
      composed.status,
    );
  }
  return composed;
}

function reusableChangeRequestMetadata(
  row: typeof changeRequests.$inferSelect,
  agentName: string,
  revision: number,
  paths: string[],
  knowledge: string[],
  connectorProfileIds: string[],
) {
  return {
    ...((row.metadata as Record<string, unknown> | null) ?? {}),
    agent_config: {
      action: 'profile',
      agent_name: agentName,
      manifest_path: paths.find((path) => /kortix\.(yaml|toml)$/.test(path)) ?? paths[0],
      behavior_path: paths.find((path) => path.endsWith('.md')) ?? null,
    },
    agent_profile: {
      agent_name: agentName,
      draft_revision: revision,
      paths,
      knowledge: [...new Set(knowledge)].sort(),
      connector_profile_ids: [...new Set(connectorProfileIds)].sort(),
    },
  };
}

profileOpenApi(
  createRoute({
    method: 'get',
    path: '/{projectId}/agents/{agentName}/profile',
    tags: ['projects'],
    summary: 'Get one unified agent capability profile',
    ...auth,
    request: { params: z.object({ projectId: z.string(), agentName: z.string() }) },
    responses: { 200: json(z.any(), 'Agent profile'), ...errors(400, 403, 404, 502) },
  }),
  async (c) => {
    const context = await loadProfileContext(c, 'read');
    if (isResponse(context)) return context;
    const draft = await getAgentProfileDraftRecord(
      context.loaded.row.projectId,
      c.req.param('agentName'),
    );
    const sources = await listAgentKnowledgeSourceRecords(
      context.loaded.row.projectId,
      c.req.param('agentName'),
    );
    return c.json({
      project_id: context.loaded.row.projectId,
      agent_name: c.req.param('agentName'),
      is_default: context.published.profile.isDefault,
      status: draft?.branchName ? 'publishing' : draft ? 'draft' : 'published',
      published_revision: context.published.profile.baseRevision,
      revision: draft?.revision ?? 0,
      sections: context.published.profile.sections,
      draft: draft ? serializeAgentProfileDraft(draft) : null,
      knowledge_sources: sources.map(serializeAgentKnowledgeSource),
    });
  },
);

profileOpenApi(
  createRoute({
    method: 'post',
    path: '/{projectId}/agents/{agentName}/profile/test',
    tags: ['projects'],
    summary: 'Create an ephemeral session from an agent profile draft',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), agentName: z.string() }),
      body: { content: { 'application/json': { schema: TestDraftSchema } } },
    },
    responses: {
      201: json(z.any(), 'Ephemeral draft session created'),
      ...errors(400, 403, 404, 409, 422, 502),
    },
  }),
  async (c) => {
    const context = await loadProfileContext(c, 'write');
    if (isResponse(context)) return context;
    await assertProjectCapability(
      c,
      context.loaded.userId,
      context.loaded.row.accountId,
      context.loaded.row.projectId,
      PROJECT_ACTIONS.PROJECT_GITOPS_PUSH,
    );
    await assertProjectCapability(
      c,
      context.loaded.userId,
      context.loaded.row.accountId,
      context.loaded.row.projectId,
      PROJECT_ACTIONS.PROJECT_SESSION_START,
    );
    const parsed = TestDraftSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json(
        { error: 'Invalid body', code: 'invalid_body', issues: parsed.error.issues },
        400,
      );
    }
    const draft = await draftAtRevision(c, context, parsed.data.expectedRevision);
    if (draft instanceof Response) return draft;

    type DraftIntegration = {
      can_write?: boolean;
      status?: string;
      slug?: string;
    };
    const integrations: DraftIntegration[] = Array.isArray(draft.sections.integrations)
      ? draft.sections.integrations.filter(
          (entry: unknown): entry is DraftIntegration =>
            !!entry && typeof entry === 'object' && !Array.isArray(entry),
        )
      : [];
    const excluded = integrations.filter(
      (integration) =>
        integration.can_write === true && integration.status === 'pending_publication',
    );
    const testSections: AgentProfileSections = {
      ...draft.sections,
      integrations: parsed.data.includePendingWriteIntegrations
        ? integrations
        : integrations.filter((integration) => !excluded.includes(integration)),
    };
    const composed = await composeDraft(c, context, testSections);
    if (composed instanceof Response) return composed;

    const knowledgeSlugs = Array.isArray(testSections.knowledge) ? testSections.knowledge : [];
    const sourceRows = knowledgeSlugs.length
      ? await db
          .select({
            sourceId: agentKnowledgeSources.sourceId,
            slug: agentKnowledgeSources.slug,
          })
          .from(agentKnowledgeSources)
          .where(
            and(
              eq(agentKnowledgeSources.accountId, context.loaded.row.accountId),
              eq(agentKnowledgeSources.projectId, context.loaded.row.projectId),
              eq(agentKnowledgeSources.agentName, c.req.param('agentName')),
              inArray(agentKnowledgeSources.slug, knowledgeSlugs),
              ne(agentKnowledgeSources.status, 'revoked'),
            ),
          )
      : [];
    const resolvedSlugs = new Set(sourceRows.map((source) => source.slug));
    const missingSlugs = knowledgeSlugs.filter((slug) => !resolvedSlugs.has(slug));
    if (missingSlugs.length > 0) {
      return c.json(
        {
          error: `Draft knowledge sources are unavailable: ${missingSlugs.join(', ')}`,
          code: 'draft_knowledge_unavailable',
        },
        409,
      );
    }

    const gitProject = await withProjectGitAuth(context.loaded.row);
    const agentName = c.req.param('agentName');
    let branch = '';
    try {
      branch = await createAgentChangeBranch(
        gitProject,
        'profile',
        `${agentName}-test`,
        context.loaded.row.defaultBranch,
      );
      await commitMultipleFilesToBranch(gitProject, {
        files: composed.files,
        message: `test: stage agent ${agentName} profile draft revision ${draft.revision}`,
        branch,
        expectedFileRevision:
          context.manifest.revision !== undefined
            ? {
                path: context.manifest.path,
                sha: context.manifest.revision,
                candidatePaths: context.manifest.candidatePaths,
              }
            : undefined,
      });
    } catch (error) {
      if (branch) await cleanupAgentChangeBranch(gitProject, branch);
      if (error instanceof GitFileRevisionConflictError) {
        return c.json({ error: error.message, code: 'manifest_revision_conflict' }, 409);
      }
      return c.json(
        {
          error: `Failed to stage profile test branch: ${error instanceof Error ? error.message : String(error)}`,
          code: 'draft_test_branch_failed',
        },
        502,
      );
    }

    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const result = await createSession({
      source: 'ui',
      project: context.loaded.row,
      userId: context.loaded.userId,
      requestingPrincipalType: 'human',
      body: { agent_name: agentName, base_ref: branch },
      metadata: {
        agent_profile_test: true,
        agent_profile_draft_revision: draft.revision,
        expires_at: expiresAt.toISOString(),
      },
      authType: c.get('authType') as string | undefined,
      apiKeyType: c.get('apiKeyType') as string | undefined,
      inSession: false,
    });
    if (result.error || !result.row) {
      await cleanupAgentChangeBranch(gitProject, branch);
      return c.json(
        result.error?.body ?? { error: 'Draft test session could not be created.' },
        (result.error?.status ?? 500) as ContentfulStatusCode,
      );
    }
    try {
      await db.insert(agentProfileTestSessions).values({
        sessionId: result.row.sessionId,
        accountId: context.loaded.row.accountId,
        projectId: context.loaded.row.projectId,
        agentName,
        draftRevision: draft.revision,
        branchName: branch,
        sourceIds: sourceRows.map((source) => source.sourceId),
        excludedIntegrations: excluded.flatMap((integration) =>
          typeof integration.slug === 'string' ? [integration.slug] : [],
        ),
        createdBy: context.loaded.userId,
        expiresAt,
      });
    } catch (error) {
      await db.delete(projectSessions).where(eq(projectSessions.sessionId, result.row.sessionId));
      await cleanupAgentChangeBranch(gitProject, branch);
      throw error;
    }
    return c.json(
      {
        session_id: result.row.sessionId,
        branch,
        expires_at: expiresAt.toISOString(),
        excluded_integrations: parsed.data.includePendingWriteIntegrations
          ? []
          : excluded.flatMap((integration) =>
              typeof integration.slug === 'string' ? [integration.slug] : [],
            ),
      },
      201,
    );
  },
);

profileOpenApi(
  createRoute({
    method: 'post',
    path: '/{projectId}/agents/{agentName}/profile/preview',
    tags: ['projects'],
    summary: 'Preview an agent profile draft',
    ...auth,
    request: { params: z.object({ projectId: z.string(), agentName: z.string() }) },
    responses: { 200: json(z.any(), 'Profile preview'), ...errors(400, 403, 404, 409, 502) },
  }),
  async (c) => {
    const context = await loadProfileContext(c, 'read');
    if (isResponse(context)) return context;
    const draft = await draftAtRevision(c, context);
    if (draft instanceof Response) return draft;
    const composed = await composeDraft(c, context, draft.sections);
    if (composed instanceof Response) return composed;
    return c.json({
      draft: serializeAgentProfileDraft(draft),
      impact: draft.impact,
      changes: draft.changes,
      technical_diff: composed.technicalDiff.map(
        (entry: { path: string; before: string | null; after: string | null }) => ({
          path: entry.path,
          before: entry.before,
          after: entry.after,
        }),
      ),
    });
  },
);

profileOpenApi(
  createRoute({
    method: 'post',
    path: '/{projectId}/agents/{agentName}/profile/publish',
    tags: ['projects'],
    summary: 'Publish an agent profile through one change request',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), agentName: z.string() }),
      body: { content: { 'application/json': { schema: PublishSchema } } },
    },
    responses: {
      201: json(z.any(), 'Profile change request created or updated'),
      ...errors(400, 403, 404, 409, 422, 500, 502),
    },
  }),
  async (c) => {
    const context = await loadProfileContext(c, 'write');
    if (isResponse(context)) return context;
    await assertProjectCapability(
      c,
      context.loaded.userId,
      context.loaded.row.accountId,
      context.loaded.row.projectId,
      PROJECT_ACTIONS.PROJECT_GITOPS_PUSH,
    );
    assertAgentScope(c, PROJECT_ACTIONS.PROJECT_CR_OPEN);

    const parsed = PublishSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json(
        { error: 'Invalid body', code: 'invalid_body', issues: parsed.error.issues },
        400,
      );
    }
    const draft = await draftAtRevision(c, context, parsed.data.expectedRevision);
    if (draft instanceof Response) return draft;
    if (draft.highestRisk === 'high' && parsed.data.acknowledgeHighRisk !== true) {
      return c.json(
        {
          error: 'High-risk profile changes require explicit acknowledgement.',
          code: 'high_risk_acknowledgement_required',
          impact: draft.impact,
          changes: draft.changes,
        },
        409,
      );
    }
    const composed = await composeDraft(c, context, draft.sections);
    if (composed instanceof Response) return composed;
    if (composed.technicalDiff.length === 0) {
      return c.json({ error: 'The draft has no publishable changes.', code: 'no_changes' }, 409);
    }

    const projectId = context.loaded.row.projectId;
    const agentName = c.req.param('agentName');
    const gitProject = await withProjectGitAuth(context.loaded.row);
    let existing = draft.changeRequestId
      ? ((
          await db
            .select()
            .from(changeRequests)
            .where(
              and(
                eq(changeRequests.crId, draft.changeRequestId),
                eq(changeRequests.projectId, projectId),
                eq(changeRequests.status, 'open'),
              ),
            )
            .limit(1)
        )[0] ?? null)
      : null;
    if (!existing) {
      try {
        existing = await findOpenAgentProfileChangeRequest(
          gitProject,
          projectId,
          agentName,
          composed.files.map((file: { path: string }) => file.path),
        );
      } catch (error) {
        return c.json(
          {
            error: error instanceof Error ? error.message : String(error),
            code: 'pending_cr_check_failed',
          },
          502,
        );
      }
    }

    let branch = existing?.headRef ?? '';
    let createdBranch = false;
    if (!branch) {
      try {
        branch = await createAgentChangeBranch(
          gitProject,
          'profile',
          agentName,
          context.loaded.row.defaultBranch,
        );
        createdBranch = true;
      } catch (error) {
        if (error instanceof AgentBranchNameCollisionError) {
          return c.json({ error: error.message, code: 'branch_name_collision' }, 409);
        }
        return c.json(
          {
            error: `Failed to create profile branch: ${error instanceof Error ? error.message : String(error)}`,
          },
          502,
        );
      }
    }

    let commitSha: string;
    try {
      const committed = await commitMultipleFilesToBranch(gitProject, {
        files: composed.files,
        message: `chore: update agent ${agentName} capability profile`,
        branch,
        expectedFileRevision:
          createdBranch && context.manifest.revision !== undefined
            ? {
                path: context.manifest.path,
                sha: context.manifest.revision,
                candidatePaths: context.manifest.candidatePaths,
              }
            : undefined,
      });
      commitSha = committed.commitSha;
    } catch (error) {
      if (createdBranch) await cleanupAgentChangeBranch(gitProject, branch);
      if (error instanceof GitFileRevisionConflictError) {
        return c.json({ error: error.message, code: 'manifest_revision_conflict' }, 409);
      }
      return c.json(
        {
          error: `Failed to commit profile files: ${error instanceof Error ? error.message : String(error)}`,
        },
        502,
      );
    }

    const paths = composed.files.map((file: { path: string }) => file.path);
    const publishedKnowledge = Array.isArray(draft.sections.knowledge)
      ? draft.sections.knowledge.filter((slug): slug is string => typeof slug === 'string')
      : [];
    const publishedConnectorProfileIds = Array.isArray(draft.sections.integrations)
      ? draft.sections.integrations
          .map((integration) => integration.profile_id)
          .filter((profileId): profileId is string => typeof profileId === 'string')
      : [];
    let changeRequest: typeof changeRequests.$inferSelect;
    let updatedExistingRequest = false;
    if (existing) {
      const [updated] = await db
        .update(changeRequests)
        .set({
          title: `Update ${agentName} agent profile`,
          description: `Publishes revision ${draft.revision} of the unified agent capability profile.`,
          headCommitSha: commitSha,
          metadata: reusableChangeRequestMetadata(
            existing,
            agentName,
            draft.revision,
            paths,
            publishedKnowledge,
            publishedConnectorProfileIds,
          ),
          updatedAt: new Date(),
        })
        .where(and(eq(changeRequests.crId, existing.crId), eq(changeRequests.status, 'open')))
        .returning();
      if (!updated) {
        return c.json(
          {
            error: 'The existing change request is no longer open.',
            code: 'change_request_closed',
          },
          409,
        );
      }
      changeRequest = updated;
      updatedExistingRequest = true;
    } else {
      const created = await createAgentProfileChangeRequest({
        accountId: context.loaded.row.accountId,
        projectId,
        userId: context.loaded.userId,
        projectForGit: gitProject,
        title: `Update ${agentName} agent profile`,
        description: `Publishes revision ${draft.revision} of the unified agent capability profile.`,
        baseRef: context.loaded.row.defaultBranch,
        headRef: branch,
        metadata: reusableChangeRequestMetadata(
          {
            metadata: {},
          } as typeof changeRequests.$inferSelect,
          agentName,
          draft.revision,
          paths,
          publishedKnowledge,
          publishedConnectorProfileIds,
        ),
      }).catch(async (error) => {
        if (createdBranch) await cleanupAgentChangeBranch(gitProject, branch);
        throw error;
      });
      if (!created.ok) {
        if (createdBranch) await cleanupAgentChangeBranch(gitProject, branch);
        return c.json(created.body, created.status);
      }
      changeRequest = created.row;
    }

    try {
      await markAgentProfileDraftPublication({
        projectId,
        agentName,
        expectedRevision: draft.revision,
        branchName: branch,
        changeRequestId: changeRequest.crId,
      });
    } catch (error) {
      if (error instanceof AgentProfileRevisionConflictError) return conflictResponse(c, error);
      return c.json(changeRequestCreateFailedBody(error), 500);
    }

    return c.json(
      {
        revision: draft.revision,
        branch,
        commit_sha: commitSha,
        change_request: serializeChangeRequest(changeRequest),
        updated_existing_request: updatedExistingRequest,
      },
      201,
    );
  },
);

profileOpenApi(
  createRoute({
    method: 'put',
    path: '/{projectId}/agents/{agentName}/profile/draft',
    tags: ['projects'],
    summary: 'Update a shared agent profile draft',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), agentName: z.string() }),
      body: { content: { 'application/json': { schema: DraftUpdateSchema } } },
    },
    responses: { 200: json(z.any(), 'Updated draft'), ...errors(400, 403, 404, 409, 502) },
  }),
  async (c) => {
    const context = await loadProfileContext(c, 'write');
    if (isResponse(context)) return context;
    const parsed = DraftUpdateSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json(
        { error: 'Invalid body', code: 'invalid_body', issues: parsed.error.issues },
        400,
      );
    }
    let sections = parsed.data.sections as AgentProfileSections;
    if (parsed.data.sections.integrations !== undefined) {
      await assertProjectCapability(
        c,
        context.loaded.userId,
        context.loaded.row.accountId,
        context.loaded.row.projectId,
        PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE,
      );
      const canonical = await canonicalizeProfileIntegrations(
        context,
        c.req.param('agentName'),
        parsed.data.sections.integrations,
      );
      if (!canonical.ok) {
        return c.json({ error: canonical.error, code: canonical.code }, 400);
      }
      sections = { ...sections, integrations: canonical.integrations };
    }
    try {
      const draft = await updateAgentProfileDraftRecord({
        accountId: context.loaded.row.accountId,
        projectId: context.loaded.row.projectId,
        agentName: c.req.param('agentName'),
        userId: context.loaded.userId,
        editor: editorFor(c),
        expectedRevision: parsed.data.expectedRevision,
        baseRevision: context.published.profile.baseRevision,
        baseSections: context.published.profile.sections,
        sections,
      });
      return c.json(serializeAgentProfileDraft(draft));
    } catch (error) {
      if (error instanceof AgentProfileRevisionConflictError) return conflictResponse(c, error);
      throw error;
    }
  },
);

profileOpenApi(
  createRoute({
    method: 'post',
    path: '/{projectId}/agents/{agentName}/profile/automations/{automationSlug}/pause',
    tags: ['projects'],
    summary: 'Pause one agent schedule immediately without editing the repository',
    ...auth,
    request: {
      params: z.object({
        projectId: z.string(),
        agentName: z.string(),
        automationSlug: z.string().regex(SLUG_RE),
      }),
    },
    responses: {
      200: json(PauseAutomationResultSchema, 'Schedule paused'),
      ...errors(400, 403, 404, 502),
    },
  }),
  async (c) => {
    const context = await loadProfileContext(c, 'write');
    if (isResponse(context)) return context;

    const agentName = c.req.param('agentName');
    const automationSlug = c.req.param('automationSlug');
    const extracted = extractTriggers(context.manifest);
    const automation = extracted.specs.find(
      (spec) =>
        spec.slug === automationSlug &&
        spec.type === 'cron' &&
        (spec.agent === agentName ||
          (spec.agent === 'default' && context.published.profile.isDefault)),
    );
    if (!automation) return c.json({ error: 'Not found' }, 404);

    const projectId = context.loaded.row.projectId;
    await reconcileProjectTriggerRuntime(projectId, extracted.specs);
    const pausedAt = new Date();
    const result = await db.transaction(async (tx) => {
      const runtime = await tx
        .update(projectTriggerRuntime)
        .set({
          enabled: false,
          nextFireAt: null,
          lastStatus: 'paused',
          lastError: null,
          lastAttemptAt: pausedAt,
          updatedAt: pausedAt,
        })
        .where(
          and(
            eq(projectTriggerRuntime.projectId, projectId),
            eq(projectTriggerRuntime.slug, automationSlug),
          ),
        )
        .returning({ slug: projectTriggerRuntime.slug });
      if (runtime.length === 0) return null;

      const cancelled = await tx
        .update(projectTriggerExecutions)
        .set({
          status: 'cancelled',
          lastError: 'Cancelled because the schedule was paused.',
          completedAt: pausedAt,
          lockedBy: null,
          lockedUntil: null,
          updatedAt: pausedAt,
        })
        .where(
          and(
            eq(projectTriggerExecutions.projectId, projectId),
            eq(projectTriggerExecutions.slug, automationSlug),
            eq(projectTriggerExecutions.status, 'queued'),
          ),
        )
        .returning({ executionId: projectTriggerExecutions.executionId });
      return { cancelledExecutions: cancelled.length };
    });
    if (!result) return c.json({ error: 'Not found' }, 404);

    return c.json({
      ok: true as const,
      slug: automationSlug,
      paused_at: pausedAt.toISOString(),
      cancelled_executions: result.cancelledExecutions,
    });
  },
);

profileOpenApi(
  createRoute({
    method: 'post',
    path: '/{projectId}/agents/{agentName}/profile/discard',
    tags: ['projects'],
    summary: 'Discard an agent profile draft',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), agentName: z.string() }),
      body: { content: { 'application/json': { schema: ExpectedRevisionSchema } } },
    },
    responses: { 200: json(z.any(), 'Draft discarded'), ...errors(400, 403, 404, 409) },
  }),
  async (c) => {
    const context = await loadProfileContext(c, 'write');
    if (isResponse(context)) return context;
    const parsed = ExpectedRevisionSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Invalid body', code: 'invalid_body' }, 400);
    try {
      await discardAgentProfileDraftRecord(
        context.loaded.row.projectId,
        c.req.param('agentName'),
        parsed.data.expectedRevision,
        context.loaded.userId,
      );
      return c.json({ ok: true });
    } catch (error) {
      if (error instanceof AgentProfileRevisionConflictError) return conflictResponse(c, error);
      throw error;
    }
  },
);

profileOpenApi(
  createRoute({
    method: 'post',
    path: '/{projectId}/agents/{agentName}/profile/skills/import',
    tags: ['projects'],
    summary: 'Stage skills from a .skill or ZIP archive',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), agentName: z.string() }),
      body: { content: { 'application/json': { schema: ImportSkillArchiveSchema } } },
    },
    responses: { 201: json(z.any(), 'Skills staged'), ...errors(400, 403, 404, 409) },
  }),
  async (c) => {
    const context = await loadProfileContext(c, 'write');
    if (isResponse(context)) return context;
    await assertSkillWrite(context, c);
    const parsed = ImportSkillArchiveSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Invalid body', code: 'invalid_body' }, 400);
    if (!/\.(skill|zip)$/i.test(parsed.data.fileName)) {
      return c.json(
        { error: 'Choose a .skill or ZIP file.', code: 'skill_archive_extension' },
        400,
      );
    }
    try {
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(parsed.data.dataBase64)) {
        throw new AgentSkillImportError('skill_archive_invalid', 'Skill archive data is invalid.');
      }
      const skills = await readAgentSkillArchive(Buffer.from(parsed.data.dataBase64, 'base64'));
      const draft = await stageSkills(c, context, skills, 'archive');
      return c.json({ skills, draft: serializeAgentProfileDraft(draft) }, 201);
    } catch (error) {
      if (error instanceof AgentProfileRevisionConflictError) return conflictResponse(c, error);
      return inputErrorResponse(c, error);
    }
  },
);

profileOpenApi(
  createRoute({
    method: 'post',
    path: '/{projectId}/agents/{agentName}/profile/skills/marketplace',
    tags: ['projects'],
    summary: 'Stage a marketplace skill',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), agentName: z.string() }),
      body: { content: { 'application/json': { schema: InstallMarketplaceSkillSchema } } },
    },
    responses: { 201: json(z.any(), 'Marketplace skill staged'), ...errors(400, 403, 404, 409) },
  }),
  async (c) => {
    const context = await loadProfileContext(c, 'write');
    if (isResponse(context)) return context;
    await assertSkillWrite(context, c);
    const parsed = InstallMarketplaceSkillSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Invalid body', code: 'invalid_body' }, 400);
    try {
      const skills = await loadMarketplaceAgentSkills(parsed.data.itemId);
      const draft = await stageSkills(c, context, skills, 'marketplace');
      return c.json({ skills, draft: serializeAgentProfileDraft(draft) }, 201);
    } catch (error) {
      if (error instanceof AgentProfileRevisionConflictError) return conflictResponse(c, error);
      return inputErrorResponse(c, error);
    }
  },
);

profileOpenApi(
  createRoute({
    method: 'post',
    path: '/{projectId}/agents/{agentName}/profile/skills/github',
    tags: ['projects'],
    summary: 'Stage a skill from GitHub',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), agentName: z.string() }),
      body: { content: { 'application/json': { schema: ImportGitHubSkillSchema } } },
    },
    responses: { 201: json(z.any(), 'GitHub skill staged'), ...errors(400, 403, 404, 409, 502) },
  }),
  async (c) => {
    const context = await loadProfileContext(c, 'write');
    if (isResponse(context)) return context;
    await assertSkillWrite(context, c);
    const parsed = ImportGitHubSkillSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Invalid body', code: 'invalid_body' }, 400);
    try {
      const skills = await loadGitHubAgentSkills(parsed.data.url);
      const draft = await stageSkills(c, context, skills, 'github');
      return c.json({ skills, draft: serializeAgentProfileDraft(draft) }, 201);
    } catch (error) {
      if (error instanceof AgentProfileRevisionConflictError) return conflictResponse(c, error);
      return inputErrorResponse(c, error);
    }
  },
);

profileOpenApi(
  createRoute({
    method: 'post',
    path: '/{projectId}/agents/{agentName}/profile/skills/generate',
    tags: ['projects'],
    summary: 'Create and stage a skill from a plain-language brief',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), agentName: z.string() }),
      body: { content: { 'application/json': { schema: GenerateSkillSchema } } },
    },
    responses: { 201: json(z.any(), 'Generated skill staged'), ...errors(400, 403, 404, 409) },
  }),
  async (c) => {
    const context = await loadProfileContext(c, 'write');
    if (isResponse(context)) return context;
    await assertSkillWrite(context, c);
    const parsed = GenerateSkillSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Invalid body', code: 'invalid_body' }, 400);
    try {
      const skills = [generateAgentSkill(parsed.data)];
      const draft = await stageSkills(c, context, skills, 'generated');
      return c.json({ skills, draft: serializeAgentProfileDraft(draft) }, 201);
    } catch (error) {
      if (error instanceof AgentProfileRevisionConflictError) return conflictResponse(c, error);
      return inputErrorResponse(c, error);
    }
  },
);

profileOpenApi(
  createRoute({
    method: 'get',
    path: '/{projectId}/agents/{agentName}/knowledge',
    tags: ['projects'],
    summary: 'List private knowledge sources for one agent',
    ...auth,
    request: { params: z.object({ projectId: z.string(), agentName: z.string() }) },
    responses: { 200: json(z.any(), 'Knowledge sources'), ...errors(400, 403, 404) },
  }),
  async (c) => {
    const context = await loadProfileContext(c, 'read');
    if (isResponse(context)) return context;
    const sources = await listAgentKnowledgeSourceRecords(
      context.loaded.row.projectId,
      c.req.param('agentName'),
    );
    return c.json({ sources: sources.map(serializeAgentKnowledgeSource) });
  },
);

profileOpenApi(
  createRoute({
    method: 'post',
    path: '/{projectId}/agents/{agentName}/knowledge/sources',
    tags: ['projects'],
    summary: 'Add a URL or connected-app knowledge source',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), agentName: z.string() }),
      body: { content: { 'application/json': { schema: CreateSourceSchema } } },
    },
    responses: { 201: json(z.any(), 'Knowledge source created'), ...errors(400, 403, 404, 409) },
  }),
  async (c) => {
    const context = await loadProfileContext(c, 'write');
    if (isResponse(context)) return context;
    const parsed = CreateSourceSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json(
        { error: 'Invalid body', code: 'invalid_body', issues: parsed.error.issues },
        400,
      );
    }
    try {
      const source = await createAgentKnowledgeSourceRecord({
        accountId: context.loaded.row.accountId,
        projectId: context.loaded.row.projectId,
        agentName: c.req.param('agentName'),
        userId: context.loaded.userId,
        input: parsed.data,
      });
      try {
        await stageKnowledgeSlug(c, context, source.slug, 'add');
      } catch (error) {
        await revokeAgentKnowledgeSourceRecord(
          context.loaded.row.projectId,
          c.req.param('agentName'),
          source.sourceId,
          context.loaded.userId,
        );
        throw error;
      }
      return c.json(serializeAgentKnowledgeSource(source), 201);
    } catch (error) {
      if (error instanceof AgentProfileRevisionConflictError) return conflictResponse(c, error);
      return inputErrorResponse(c, error);
    }
  },
);

profileOpenApi(
  createRoute({
    method: 'post',
    path: '/{projectId}/agents/{agentName}/knowledge/uploads',
    tags: ['projects'],
    summary: 'Create a signed private knowledge upload',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), agentName: z.string() }),
      body: { content: { 'application/json': { schema: CreateUploadSchema } } },
    },
    responses: { 201: json(z.any(), 'Signed upload created'), ...errors(400, 403, 404, 502) },
  }),
  async (c) => {
    const context = await loadProfileContext(c, 'write');
    if (isResponse(context)) return context;
    const parsed = CreateUploadSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json(
        { error: 'Invalid body', code: 'invalid_body', issues: parsed.error.issues },
        400,
      );
    }
    try {
      const upload = await createAgentKnowledgeUploadRecord({
        accountId: context.loaded.row.accountId,
        projectId: context.loaded.row.projectId,
        agentName: c.req.param('agentName'),
        userId: context.loaded.userId,
        ...parsed.data,
      });
      return c.json(
        {
          source: serializeAgentKnowledgeSource(upload.source),
          signed_upload_url: upload.signedUploadUrl,
          upload_token: upload.uploadToken,
          storage_path: upload.storagePath,
          expires_at: upload.expiresAt,
        },
        201,
      );
    } catch (error) {
      return inputErrorResponse(c, error);
    }
  },
);

profileOpenApi(
  createRoute({
    method: 'post',
    path: '/{projectId}/agents/{agentName}/knowledge/{sourceId}/complete',
    tags: ['projects'],
    summary: 'Complete a private knowledge upload',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), agentName: z.string(), sourceId: z.string() }),
      body: { content: { 'application/json': { schema: CompleteUploadSchema } } },
    },
    responses: { 200: json(z.any(), 'Upload completed'), ...errors(400, 403, 404) },
  }),
  async (c) => {
    const context = await loadProfileContext(c, 'write');
    if (isResponse(context)) return context;
    const parsed = CompleteUploadSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Invalid body', code: 'invalid_body' }, 400);
    try {
      const source = await completeAgentKnowledgeUploadRecord(
        context.loaded.row.projectId,
        c.req.param('agentName'),
        c.req.param('sourceId'),
        parsed.data.uploadToken,
      );
      if (!source) return c.json({ error: 'Not found' }, 404);
      await stageKnowledgeSlug(c, context, source.slug, 'add');
      return c.json(serializeAgentKnowledgeSource(source));
    } catch (error) {
      if (error instanceof AgentProfileRevisionConflictError) return conflictResponse(c, error);
      return inputErrorResponse(c, error);
    }
  },
);

profileOpenApi(
  createRoute({
    method: 'post',
    path: '/{projectId}/agents/{agentName}/knowledge/{sourceId}/sync',
    tags: ['projects'],
    summary: 'Synchronize one private knowledge source now',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), agentName: z.string(), sourceId: z.string() }),
    },
    responses: { 200: json(z.any(), 'Sync queued'), ...errors(400, 403, 404) },
  }),
  async (c) => {
    const context = await loadProfileContext(c, 'write');
    if (isResponse(context)) return context;
    const projectId = context.loaded.row.projectId;
    const agentName = c.req.param('agentName');
    const sourceId = c.req.param('sourceId');
    if (!(await enqueueAgentKnowledgeSync(projectId, agentName, sourceId))) {
      return c.json({ error: 'Not found' }, 404);
    }
    const source = await getAgentKnowledgeSourceRecord(projectId, agentName, sourceId);
    if (!source) return c.json({ error: 'Not found' }, 404);
    return c.json(serializeAgentKnowledgeSource(source));
  },
);

profileOpenApi(
  createRoute({
    method: 'delete',
    path: '/{projectId}/agents/{agentName}/knowledge/{sourceId}',
    tags: ['projects'],
    summary: 'Revoke one private knowledge source immediately',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), agentName: z.string(), sourceId: z.string() }),
    },
    responses: { 200: json(z.any(), 'Source revoked'), ...errors(400, 403, 404) },
  }),
  async (c) => {
    const context = await loadProfileContext(c, 'write');
    if (isResponse(context)) return context;
    const projectId = context.loaded.row.projectId;
    const agentName = c.req.param('agentName');
    const sourceId = c.req.param('sourceId');
    const source = await getAgentKnowledgeSourceRecord(projectId, agentName, sourceId);
    if (!source) return c.json({ error: 'Not found' }, 404);
    if (
      !(await revokeAgentKnowledgeSourceRecord(
        projectId,
        agentName,
        sourceId,
        context.loaded.userId,
      ))
    ) {
      return c.json({ error: 'Not found' }, 404);
    }
    await stageKnowledgeSlug(c, context, source.slug, 'remove');
    return c.json({ ok: true });
  },
);

void AgentProfileSectionSchema;
