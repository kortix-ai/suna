import { randomBytes } from 'node:crypto';
import { createRoute, z } from '@hono/zod-openapi';
import {
  ConnectionProfileSchema,
  ReconcileConnectionProfileInputSchema,
  UpdateConnectionProfileCredentialInputSchema,
} from '@kortix/api-contract';
import {
  executorConnectionProfiles,
  executorConnectors,
  projectSessions,
  projectTriggerRuntime,
  projects,
  sessionSandboxes,
} from '@kortix/db';
import { and, eq, inArray } from 'drizzle-orm';
import { getCachedAccountTier } from '../../billing/services/entitlements';
import { accountIsFreeTierForModels } from '../../billing/services/tiers';
import {
  agentMailUpstreamStatus,
  createAgentMailInbox,
  createAgentMailWebhook,
  isAgentMailInboxLimitError,
  resolveAgentMailApiKey,
} from '../../channels/agentmail-api';
import {
  type AgentMailSenderPolicy,
  deleteAgentMailInstall,
  deleteSlackInstall,
  deleteTeamsInstall,
  deleteTelegramInstall,
  loadAgentMailInstall,
  loadSlackInstall,
  loadTeamsAppIdForProject,
  loadTeamsInstall,
  loadTelegramInstall,
  loadTelegramTokenForProject,
  normalizeSenderPolicy,
  saveAgentMailInstall,
  saveSlackInstall,
  saveTeamsInstall,
  saveTelegramInstall,
  saveTelegramPairing,
  updateAgentMailSenderPolicy,
} from '../../channels/install-store';
import { previewVoiceB64, speakInMeeting } from '../../channels/meet-tts';
import {
  DEFAULT_MEET_BOT_NAME,
  MEET_VOICES,
  isMeetVoice,
  resolveProjectBotName,
  resolveProjectVoice,
  setProjectBotName,
  setProjectVoice,
} from '../../channels/meet-voices';
import { resolveBaseUrl } from '../../channels/slack-manifest';
import { buildSlackInstallUrl } from '../../channels/slack-oauth';
import { slackOauthMode } from '../../channels/slack-oauth-mode';
import type { QuestionInfo } from '../../channels/slack-webhook';
import { bindChatThread, resolveWorkspaceIdForChannel } from '../../channels/slack/binding';
import { downloadSlackFile, uploadSlackFile } from '../../channels/slack/file-proxy';
import { teamsChannelEnabled } from '../../channels/teams-auth';
import { buildTeamsManifest } from '../../channels/teams-manifest';
import { teamsDeepLink, teamsMode } from '../../channels/teams-mode';
import { teamsOrgConsentUrl } from '../../channels/teams-oauth';
import { downloadTeamsFile, initiateTeamsUpload } from '../../channels/teams/file-proxy';
import {
  buildTelegramWebhookUrl,
  isValidTelegramBotToken,
  telegramBotIdFromToken,
  telegramDeleteWebhook,
  telegramGetMe,
  telegramSetMyCommands,
  telegramSetWebhook,
} from '../../channels/telegram-api';
import { telegramRequireUserIdentityForTest } from '../../channels/telegram-webhook';
import { downloadTelegramFile, uploadTelegramFile } from '../../channels/telegram/file-proxy';
import { TELEGRAM_BOT_COMMANDS } from '../../channels/telegram/inbound';
import {
  TELEGRAM_PAIRING_TTL_MS,
  generateTelegramPairingCode,
  removeTelegramAllowedUser,
  telegramAllowedUserIds,
} from '../../channels/telegram/pairing';
import { postTelegramQuestion } from '../../channels/telegram/questions';
import {
  relayTelegramTurnAnswer,
  relayTelegramTurnEnd,
  relayTelegramTurnStep,
  telegramTurnExists,
} from '../../channels/telegram/turn';
import {
  relayTurnAnswer,
  relayTurnEnd,
  relayTurnQuestion,
  relayTurnStep,
} from '../../channels/turn-relay';
import { config } from '../../config';
import { upsertProfileCredential } from '../../executor/credentials';
import { reconcileChannelConnectors } from '../../executor/sync';
import { resolveExperimentalFeature } from '../../experimental/features';
import { PROJECT_ACTIONS } from '../../iam';
import { projectLlmGatewayEnabled } from '../../llm-gateway/enablement';
import { gatewayModelCatalog } from '../../llm-gateway/models/catalog-models';
import { projectPickerCatalog } from '../../llm-gateway/models/picker-catalog';
import {
  invalidateAccountModelDefaults,
  isModelServableForAccount,
  resolveEffectiveModel,
} from '../../llm-gateway/resolution/default-model';
import { auth, errors, json } from '../../openapi';
import {
  deleteAccountModelPreference,
  getAccountModelDefaults,
  upsertAccountModelPreference,
} from '../../repositories/model-preferences';
import { getProjectRoutingPolicy } from '../../repositories/project-routing-policies';
import { db } from '../../shared/db';
import {
  discoverExecutionKeepAliveEndpoint,
  releaseExecutionLease,
  renewExecutionLease,
} from '../execution-lease';
import { assertProjectCapability, loadProjectForUser } from '../lib/access';
import { AnyObject, TriggerSchema, projectsApp } from '../lib/app';
import { withProjectGitAuth } from '../lib/git';
import { readBody, requestAuditContext } from '../lib/serializers';
import {
  canonicalConnectorAlias,
  loadEmailInstallProfileId,
} from '../lib/session-connector-bindings';
import {
  commitManifest,
  draftToSpec,
  fireGitTrigger,
  loadManifestForEdit,
  loadTriggersForResponse,
  markGitTriggerFired,
  parseTriggerDraft,
  removeTriggerFromManifest,
  renderPromptTemplate,
  specToBody,
  triggersPausedForProject,
  upsertTriggerInManifest,
  withTriggersPaused,
} from '../lib/triggers';
import { listProjectSecretsSnapshot } from '../secrets';
import { type ParsedManifest, extractTriggers, loadProjectTriggers } from '../triggers';

// Body keys that change the trigger's *repo manifest* (committed to git). A PATCH
// whose body touches none of these has nothing to commit, so we skip git entirely
// and treat it as a no-op.
const TRIGGER_MANIFEST_KEYS = [
  'name',
  'type',
  'agent',
  'model',
  'enabled',
  'prompt_template',
  'promptTemplate',
  'cron',
  'schedule',
  'run_at',
  'runAt',
  'timezone',
  'secret_env',
  'secretEnv',
  'session_mode',
  'sessionMode',
  'session_id',
  'sessionId',
] as const;

interface SlackAuthTest {
  ok: boolean;
  team_id?: string;
  team?: string;
  user_id?: string;
  error?: string;
}

const ConnectionProfileViewSchema = ConnectionProfileSchema.openapi('ConnectionProfile');

function serializeConnectionProfile(row: {
  profileId: string;
  connectorAlias: string;
  ownerType: string;
  ownerId: string | null;
  label: string;
  status: string;
  isDefault: boolean;
  metadata: Record<string, unknown>;
}) {
  return {
    profile_id: row.profileId,
    connector_alias: row.connectorAlias,
    owner_type: row.ownerType,
    owner_id: row.ownerId,
    label: row.label,
    status: row.status,
    is_default: row.isDefault,
    metadata: row.metadata ?? {},
  };
}

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/connector-profiles',
    tags: ['connectors'],
    summary: 'List connection profiles',
    ...auth,
    request: { params: z.object({ projectId: z.string() }) },
    responses: {
      200: json(z.object({ profiles: z.array(ConnectionProfileViewSchema) }), 'Profiles'),
      ...errors(403, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_CONNECTOR_PROFILES_MANAGE,
    );
    const rows = await db
      .select({
        profileId: executorConnectionProfiles.profileId,
        connectorAlias: executorConnectors.slug,
        ownerType: executorConnectionProfiles.ownerType,
        ownerId: executorConnectionProfiles.ownerId,
        label: executorConnectionProfiles.label,
        status: executorConnectionProfiles.status,
        isDefault: executorConnectionProfiles.isDefault,
        metadata: executorConnectionProfiles.metadata,
      })
      .from(executorConnectionProfiles)
      .innerJoin(
        executorConnectors,
        eq(executorConnectors.connectorId, executorConnectionProfiles.connectorId),
      )
      .where(eq(executorConnectionProfiles.projectId, projectId));
    return c.json({ profiles: rows.map(serializeConnectionProfile) });
  },
);

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/connector-profiles',
    tags: ['connectors'],
    summary: 'Idempotently create or reconcile a connection profile',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: { content: { 'application/json': { schema: ReconcileConnectionProfileInputSchema } } },
    },
    responses: {
      200: json(ConnectionProfileViewSchema, 'Reconciled profile'),
      201: json(ConnectionProfileViewSchema, 'Created profile'),
      ...errors(400, 403, 404, 409),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_CONNECTOR_PROFILES_MANAGE,
    );
    const body = await readBody(c);
    const requestedAlias =
      typeof body.connector_alias === 'string' ? body.connector_alias.trim() : '';
    const connectorAlias = canonicalConnectorAlias(requestedAlias);
    const ownerType = typeof body.owner_type === 'string' ? body.owner_type : 'external';
    const ownerId = typeof body.owner_id === 'string' ? body.owner_id.trim() : '';
    const label = typeof body.label === 'string' ? body.label.trim() : '';
    const metadata =
      body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
        ? (body.metadata as Record<string, unknown>)
        : {};
    if (!connectorAlias || !['agent', 'member', 'subject', 'external'].includes(ownerType)) {
      return c.json({ error: 'connector_alias and a non-project owner_type are required' }, 400);
    }
    if (!ownerId || !label) return c.json({ error: 'owner_id and label are required' }, 400);
    const [connector] = await db
      .select({
        connectorId: executorConnectors.connectorId,
        providerType: executorConnectors.providerType,
      })
      .from(executorConnectors)
      .where(
        and(
          eq(executorConnectors.projectId, projectId),
          eq(executorConnectors.accountId, loaded.row.accountId),
          eq(executorConnectors.slug, connectorAlias),
        ),
      )
      .limit(1);
    if (!connector) return c.json({ error: 'Connector not found' }, 404);
    if (connector.providerType === 'channel') {
      return c.json(
        { error: 'Channel profiles are reconciled from verified channel installations' },
        409,
      );
    }
    const [existing] = await db
      .select()
      .from(executorConnectionProfiles)
      .where(
        and(
          eq(executorConnectionProfiles.connectorId, connector.connectorId),
          eq(executorConnectionProfiles.ownerType, ownerType as any),
          eq(executorConnectionProfiles.ownerId, ownerId),
        ),
      )
      .limit(1);
    let profile = existing;
    let created = false;
    if (profile) {
      const [updated] = await db
        .update(executorConnectionProfiles)
        .set({ label, metadata, updatedAt: new Date() })
        .where(eq(executorConnectionProfiles.profileId, profile.profileId))
        .returning();
      profile = updated;
    } else {
      const [inserted] = await db
        .insert(executorConnectionProfiles)
        .values({
          accountId: loaded.row.accountId,
          projectId,
          connectorId: connector.connectorId,
          ownerType: ownerType as 'agent' | 'member' | 'subject' | 'external',
          ownerId,
          label,
          metadata,
          createdBy: loaded.userId,
        })
        .onConflictDoNothing()
        .returning();
      if (inserted) {
        profile = inserted;
        created = true;
      } else {
        const [raced] = await db
          .select()
          .from(executorConnectionProfiles)
          .where(
            and(
              eq(executorConnectionProfiles.connectorId, connector.connectorId),
              eq(executorConnectionProfiles.ownerType, ownerType as any),
              eq(executorConnectionProfiles.ownerId, ownerId),
            ),
          )
          .limit(1);
        profile = raced;
      }
    }
    if (!profile) return c.json({ error: 'Profile could not be reconciled' }, 409);
    const view = serializeConnectionProfile({ ...profile, connectorAlias });
    return c.json(view, created ? 201 : 200);
  },
);

for (const operation of ['credential', 'revoke', 'activate'] as const) {
  projectsApp.openapi(
    createRoute({
      method: 'put',
      path: `/{projectId}/connector-profiles/{profileId}/${operation}`,
      tags: ['connectors'],
      summary: `${operation} connection profile`,
      ...auth,
      request: {
        params: z.object({ projectId: z.string(), profileId: z.string().uuid() }),
        body: {
          content: {
            'application/json': {
              schema:
                operation === 'credential'
                  ? UpdateConnectionProfileCredentialInputSchema
                  : z.object({}).strict(),
            },
          },
        },
      },
      responses: {
        200: json(z.object({ ok: z.literal(true) }), 'Updated'),
        ...errors(400, 403, 404),
      },
    }),
    async (c: any) => {
      const projectId = c.req.param('projectId');
      const profileId = c.req.param('profileId');
      const loaded = await loadProjectForUser(c, projectId, 'read');
      if (!loaded) return c.json({ error: 'Not found' }, 404);
      await assertProjectCapability(
        c,
        loaded.userId,
        loaded.row.accountId,
        projectId,
        PROJECT_ACTIONS.PROJECT_CONNECTOR_PROFILES_MANAGE,
      );
      const [profile] = await db
        .select({ connectorId: executorConnectionProfiles.connectorId })
        .from(executorConnectionProfiles)
        .where(
          and(
            eq(executorConnectionProfiles.profileId, profileId),
            eq(executorConnectionProfiles.projectId, projectId),
            eq(executorConnectionProfiles.accountId, loaded.row.accountId),
          ),
        )
        .limit(1);
      if (!profile) return c.json({ error: 'Not found' }, 404);
      if (operation === 'credential') {
        const body = await readBody(c);
        if (typeof body.value !== 'string' || !body.value) {
          return c.json({ error: 'value is required' }, 400);
        }
        await upsertProfileCredential({
          projectId,
          connectorId: profile.connectorId,
          profileId,
          value: body.value,
          kind: body.kind === 'connection' ? 'connection' : 'secret',
          createdBy: loaded.userId,
        });
      } else {
        await db
          .update(executorConnectionProfiles)
          .set({ status: operation === 'revoke' ? 'revoked' : 'active', updatedAt: new Date() })
          .where(eq(executorConnectionProfiles.profileId, profileId));
      }
      return c.json({ ok: true });
    },
  );
}

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/triggers',
    tags: ['triggers'],
    summary: 'GET /:projectId/triggers',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
    },
    responses: {
      200: json(z.array(TriggerSchema), 'Triggers'),
      ...errors(404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    // Leaf-gate the read (a custom role can omit project.trigger.read) — and, via
    // the central agent-grant fold, an agent token must hold it in its kortixCli.
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_TRIGGER_READ,
    );

    return c.json(await loadTriggersForResponse(projectId, loaded.row));
  },
);

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/triggers',
    tags: ['triggers'],
    summary: 'POST /:projectId/triggers',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: {
      201: json(TriggerSchema, 'The created trigger'),
      ...errors(400, 404, 409),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const body = await readBody(c);
    const loaded = await loadProjectForUser(c, projectId, 'manage');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    // Specific IAM gate so the audit trail records the precise action.
    // assertProjectCapability (not bare assertAuthorized) so the acting token is
    // threaded and the agent-grant fold fires.
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_TRIGGER_CREATE,
    );

    const draft = parseTriggerDraft(body, { existingSlug: null });
    if ('error' in draft) return c.json({ error: draft.error }, 400);

    // A `pinned` trigger may only target a session that belongs to THIS project —
    // never a nonexistent or another project's session.
    if (draft.sessionMode === 'pinned' && draft.pinnedSessionId) {
      const [pinned] = await db
        .select({ sessionId: projectSessions.sessionId })
        .from(projectSessions)
        .where(
          and(
            eq(projectSessions.sessionId, draft.pinnedSessionId),
            eq(projectSessions.projectId, projectId),
          ),
        )
        .limit(1);
      if (!pinned) {
        return c.json(
          { error: `Pinned session "${draft.pinnedSessionId}" was not found in this project.` },
          400,
        );
      }
    }

    let manifest: ParsedManifest;
    try {
      manifest = await loadManifestForEdit(loaded.row);
    } catch (err) {
      return c.json({ error: (err as Error).message || 'Failed to read manifest' }, 400);
    }

    if (extractTriggers(manifest).specs.some((s) => s.slug === draft.slug)) {
      return c.json(
        {
          error: `A trigger with slug "${draft.slug}" already exists. Pick a different name.`,
        },
        409,
      );
    }

    const next = upsertTriggerInManifest(manifest, draftToSpec(draft, manifest.path));
    const result = await commitManifest(loaded.row, next, `chore: add trigger ${draft.slug}`);
    if ('error' in result) {
      return c.json({ error: result.error }, result.status as 400 | 502);
    }

    return c.json(await loadTriggersForResponse(projectId, loaded.row), 201);
  },
);

// PATCH /:projectId/triggers/activation — server-side, per-project trigger
// kill-switch. Body { paused: boolean }. When paused, the platform won't
// auto-run any of this project's triggers (the cron sweep skips it, inbound
// webhooks are ignored) regardless of each trigger's repo `enabled`. Use it to
// stop ONE repo deployed to TWO control planes (e.g. dev + prod) from
// double-firing every cron — pause the deployment you don't want firing. A
// manual `…/triggers/:slug/fire` is explicit and still runs.
//
// ⚠️ ORDER MATTERS: this static route MUST stay registered BEFORE the
// `…/triggers/{slug}` routes below. OpenAPIHono matches in registration order,
// so when `…/triggers/{slug}` is declared first it captures `activation` as a
// slug and this handler is shadowed — the PATCH 404s because no trigger is
// named "activation", which silently breaks the whole pause kill-switch.
// Covered by unit-trigger-activation-route.test.ts.
projectsApp.openapi(
  createRoute({
    method: 'patch',
    path: '/{projectId}/triggers/activation',
    tags: ['triggers'],
    summary: "Pause or resume all of a project's triggers server-side",
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: {
      200: json(AnyObject, 'Updated triggers (includes triggers_paused)'),
      ...errors(400, 401, 403, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const body = await readBody(c);
    const loaded = await loadProjectForUser(c, projectId, 'manage');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_TRIGGER_UPDATE,
    );
    const paused = body.paused;
    if (typeof paused !== 'boolean') {
      return c.json({ error: 'paused must be a boolean' }, 400);
    }
    const [row] = await db
      .update(projects)
      .set({
        metadata: withTriggersPaused(loaded.row.metadata, paused),
        updatedAt: new Date(),
      })
      .where(eq(projects.projectId, projectId))
      .returning();
    if (!row || row.status === 'archived') return c.json({ error: 'Not found' }, 404);
    return c.json(await loadTriggersForResponse(projectId, row));
  },
);

// PATCH /v1/projects/:projectId/triggers/:slug

projectsApp.openapi(
  createRoute({
    method: 'patch',
    path: '/{projectId}/triggers/{slug}',
    tags: ['triggers'],
    summary: 'PATCH /:projectId/triggers/:slug',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), slug: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: {
      200: json(z.any(), 'OK'),
      ...errors(400, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const slug = c.req.param('slug');
    const body = await readBody(c);
    const loaded = await loadProjectForUser(c, projectId, 'manage');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_TRIGGER_UPDATE,
    );

    let manifest: ParsedManifest;
    try {
      manifest = await loadManifestForEdit(loaded.row);
    } catch (err) {
      return c.json({ error: (err as Error).message || 'Failed to read manifest' }, 400);
    }
    const current = extractTriggers(manifest).specs.find((s) => s.slug === slug);
    if (!current) return c.json({ error: 'Not found' }, 404);

    // Only commit the repo manifest when a manifest field actually changed; a
    // PATCH that touches none is a no-op that skips git entirely.
    const touchesManifest = TRIGGER_MANIFEST_KEYS.some((k) => k in body);
    if (touchesManifest) {
      // Merge the patch onto the current spec so callers can send partial bodies
      // (e.g. just `{ enabled: false }`). The parsed result becomes the new entry.
      const draft = parseTriggerDraft(
        { ...specToBody(current), ...body, slug: slug },
        { existingSlug: slug },
      );
      if ('error' in draft) return c.json({ error: draft.error }, 400);

      // A `pinned` trigger may only target a session that belongs to THIS project.
      if (draft.sessionMode === 'pinned' && draft.pinnedSessionId) {
        const [pinned] = await db
          .select({ sessionId: projectSessions.sessionId })
          .from(projectSessions)
          .where(
            and(
              eq(projectSessions.sessionId, draft.pinnedSessionId),
              eq(projectSessions.projectId, projectId),
            ),
          )
          .limit(1);
        if (!pinned) {
          return c.json(
            { error: `Pinned session "${draft.pinnedSessionId}" was not found in this project.` },
            400,
          );
        }
      }

      const next = upsertTriggerInManifest(manifest, draftToSpec(draft, manifest.path));
      const result = await commitManifest(loaded.row, next, `chore: update trigger ${slug}`);
      if ('error' in result) {
        return c.json({ error: result.error }, result.status as 400 | 502);
      }
    }

    return c.json(await loadTriggersForResponse(projectId, loaded.row));
  },
);

// DELETE /v1/projects/:projectId/triggers/:slug

projectsApp.openapi(
  createRoute({
    method: 'delete',
    path: '/{projectId}/triggers/{slug}',
    tags: ['triggers'],
    summary: 'DELETE /:projectId/triggers/:slug',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), slug: z.string() }),
    },
    responses: {
      200: json(z.any(), 'OK'),
      ...errors(400, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const slug = c.req.param('slug');
    const loaded = await loadProjectForUser(c, projectId, 'manage');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_TRIGGER_DELETE,
    );

    if (!/^[a-z0-9][a-z0-9_-]{0,127}$/.test(slug)) {
      return c.json({ error: 'Invalid slug' }, 400);
    }

    let manifest: ParsedManifest;
    try {
      manifest = await loadManifestForEdit(loaded.row);
    } catch (err) {
      return c.json({ error: (err as Error).message || 'Failed to read manifest' }, 400);
    }
    if (!extractTriggers(manifest).specs.some((s) => s.slug === slug)) {
      return c.json({ error: 'Not found' }, 404);
    }

    const next = removeTriggerFromManifest(manifest, slug);
    const result = await commitManifest(loaded.row, next, `chore: delete trigger ${slug}`);
    if ('error' in result) {
      return c.json({ error: result.error }, result.status as 400 | 502);
    }

    // Drop runtime state too — a re-created trigger of the same slug should
    // start with a clean last_fired_at.
    await db
      .delete(projectTriggerRuntime)
      .where(
        and(eq(projectTriggerRuntime.projectId, projectId), eq(projectTriggerRuntime.slug, slug)),
      );

    return c.json({ ok: true });
  },
);

// ─── Slack install — per project, secrets live in project_secrets ────────

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/channels/slack/installation',
    tags: ['channels'],
    summary: 'GET /:projectId/channels/slack/installation',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
    },
    responses: {
      200: json(z.any(), 'OK'),
      ...errors(404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    const install = await loadSlackInstall(projectId);
    return c.json(install ?? null);
  },
);

// GET /v1/projects/:projectId/channels/slack/mode
// Tells the dashboard whether one-click "Add to Slack" is available (server
// has SLACK_CLIENT_ID + SECRET + SIGNING_SECRET set) and the pre-signed
// install URL to redirect the user to.

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/channels/slack/mode',
    tags: ['channels'],
    summary: 'GET /:projectId/channels/slack/mode',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
    },
    responses: {
      200: json(z.any(), 'OK'),
      ...errors(404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    const mode = slackOauthMode();
    if (!mode.available) {
      return c.json({ oauth_available: false, install_url: null });
    }
    try {
      const installUrl = buildSlackInstallUrl(projectId, loaded.userId);
      return c.json({ oauth_available: true, install_url: installUrl });
    } catch {
      return c.json({ oauth_available: false, install_url: null });
    }
  },
);

// POST /v1/projects/:projectId/channels/slack/connect

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/channels/slack/connect',
    tags: ['channels'],
    summary: 'POST /:projectId/channels/slack/connect',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: {
      200: json(z.any(), 'OK'),
      ...errors(400, 404, 502),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'manage');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    // Connecting a Slack workspace is a connector-write capability — a custom
    // role can withhold it and a scoped agent must hold it (central fold).
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE,
    );

    let body: { bot_token?: string; signing_secret?: string };
    try {
      body = (await c.req.json()) as {
        bot_token?: string;
        signing_secret?: string;
      };
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    const botToken = body.bot_token?.trim();
    const signingSecret = body.signing_secret?.trim();
    if (!botToken || !botToken.startsWith('xoxb-')) {
      return c.json({ error: 'bot_token is required and must start with xoxb-' }, 400);
    }
    if (!signingSecret) {
      return c.json({ error: 'signing_secret is required' }, 400);
    }

    let authTest: SlackAuthTest;
    try {
      const res = await fetch('https://slack.com/api/auth.test', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${botToken}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
      });
      authTest = (await res.json()) as SlackAuthTest;
    } catch (err) {
      return c.json({ error: `Failed to reach Slack: ${(err as Error).message}` }, 502);
    }
    if (!authTest.ok || !authTest.team_id || !authTest.user_id) {
      return c.json(
        {
          error: `Slack rejected the token: ${authTest.error ?? 'unknown error'}`,
        },
        400,
      );
    }

    const summary = await saveSlackInstall({
      projectId,
      botToken,
      signingSecret,
      teamId: authTest.team_id,
      teamName: authTest.team ?? null,
      botUserId: authTest.user_id,
    });
    await reconcileChannelConnectors(projectId);
    return c.json(summary);
  },
);

// DELETE /v1/projects/:projectId/channels/slack/installation

projectsApp.openapi(
  createRoute({
    method: 'delete',
    path: '/{projectId}/channels/slack/installation',
    tags: ['channels'],
    summary: 'DELETE /:projectId/channels/slack/installation',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
    },
    responses: {
      200: json(z.any(), 'OK'),
      ...errors(404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'manage');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    // Disconnecting Slack tears down the connector — same connector-write gate.
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE,
    );
    await deleteSlackInstall(projectId);
    // Tear down the auto-materialized Slack connector now that the install is gone.
    await reconcileChannelConnectors(projectId);
    return c.json({ status: 'disconnected' });
  },
);

// ─── Telegram install — BYO bot (BotFather), secrets live in project_secrets ─
//
// Telegram has no shared-app OAuth: every install is a user-minted bot token.
// Connect validates the token with getMe, mints a random webhook secret, and
// points the bot's webhook at /v1/webhooks/telegram/:projectId SERVER-SIDE —
// the token itself never leaves the API (not in the response, not in a sandbox).

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/channels/telegram/installation',
    tags: ['channels'],
    summary: 'GET /:projectId/channels/telegram/installation',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
    },
    responses: {
      200: json(z.any(), 'OK'),
      ...errors(404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    const install = await loadTelegramInstall(projectId);
    if (!install) return c.json(null);
    // Live capability probe: with BotFather privacy mode ON, Telegram never
    // delivers plain group @mentions to the bot — the dashboard warns and
    // shows the fix. Best-effort (null = unknown) so a Telegram hiccup never
    // breaks the installation read.
    const token = await loadTelegramTokenForProject(projectId);
    const me = token ? await telegramGetMe(token).catch(() => null) : null;
    return c.json({
      ...install,
      groupMentionsEnabled: me?.ok ? (me.bot.can_read_all_group_messages ?? false) : null,
      // Who may drive the agent from Telegram (see telegram/pairing.ts) and
      // whether the identity gate is enforcing — the dashboard's pairing UI.
      allowedUserIds: telegramAllowedUserIds(loaded.row.metadata),
      pairingRequired: telegramRequireUserIdentityForTest(),
    });
  },
);

// POST /v1/projects/:projectId/channels/telegram/connect

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/channels/telegram/connect',
    tags: ['channels'],
    summary: 'POST /:projectId/channels/telegram/connect',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: {
      200: json(z.any(), 'OK'),
      ...errors(400, 404, 502),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'manage');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    // Connecting a Telegram bot is a connector-write capability — same gate as
    // Slack: a custom role can withhold it and a scoped agent must hold it.
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE,
    );

    let body: { bot_token?: string };
    try {
      body = (await c.req.json()) as { bot_token?: string };
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    const botToken = body.bot_token?.trim() ?? '';
    if (!botToken || !isValidTelegramBotToken(botToken)) {
      return c.json(
        {
          error: 'bot_token is required and must look like <bot_id>:<secret> (from @BotFather)',
        },
        400,
      );
    }

    const me = await telegramGetMe(botToken);
    if (!me.ok) {
      // Distinguish "Telegram said no" (bad token → 400) from "couldn't reach
      // Telegram" (transport → 502), mirroring the Slack connect split.
      const transport = me.error === 'network_error' || me.error === 'timeout';
      return c.json({ error: `Telegram rejected the token: ${me.error}` }, transport ? 502 : 400);
    }

    // 64 base64url chars — comfortably inside Telegram's 1-256 [A-Za-z0-9_-]
    // secret_token contract, unguessable, and unique per connect (a reconnect
    // rotates it, invalidating any stale webhook config).
    const webhookSecret = randomBytes(48).toString('base64url');
    const webhookUrl = buildTelegramWebhookUrl(
      config.KORTIX_URL || new URL(c.req.url).origin,
      projectId,
    );
    const hook = await telegramSetWebhook(botToken, webhookUrl, webhookSecret);
    if (!hook.ok) {
      return c.json({ error: `Telegram refused the webhook: ${hook.error}` }, 502);
    }

    // Register the `/` command menu (start/help/new) — best-effort: a failure
    // here degrades discoverability, not function, so it never fails connect.
    await telegramSetMyCommands(botToken, TELEGRAM_BOT_COMMANDS).catch(() => {});

    const summary = await saveTelegramInstall({
      projectId,
      botToken,
      webhookSecret,
      botId: telegramBotIdFromToken(botToken) ?? String(me.bot.id),
      botUsername: me.bot.username ?? null,
    });
    await reconcileChannelConnectors(projectId);
    // Mint the first pairing code with the install so the connect modal can
    // walk the user straight onto the sender allowlist (see telegram/pairing.ts).
    const pairing = await mintTelegramPairing(projectId);
    return c.json({
      ...summary,
      // Free from the validating getMe above: whether Telegram will deliver
      // group @mentions to this bot (false = BotFather privacy mode is on).
      groupMentionsEnabled: me.bot.can_read_all_group_messages ?? false,
      pairing,
    });
  },
);

// POST /v1/projects/:projectId/channels/telegram/pairing-code
// Mint a fresh single-use pairing code (replaces any outstanding one). The
// user completes the handshake by sending `/start <code>` to the bot, which
// allowlists their Telegram user id for this project.

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/channels/telegram/pairing-code',
    tags: ['channels'],
    summary: 'POST /:projectId/channels/telegram/pairing-code',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
    },
    responses: {
      200: json(z.any(), 'OK'),
      ...errors(404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'manage');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    // Pairing hands a stranger's Telegram id the power to drive this project's
    // agent — same connector-write gate as connect/disconnect.
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE,
    );
    const install = await loadTelegramInstall(projectId);
    if (!install) return c.json({ error: 'Telegram is not connected' }, 404);
    return c.json(await mintTelegramPairing(projectId));
  },
);

// DELETE /v1/projects/:projectId/channels/telegram/allowed-users/:userId
// Un-pair a Telegram sender. Metadata-only, so it works even after a
// disconnect (the allowlist survives reconnects on purpose).

projectsApp.openapi(
  createRoute({
    method: 'delete',
    path: '/{projectId}/channels/telegram/allowed-users/{userId}',
    tags: ['channels'],
    summary: 'DELETE /:projectId/channels/telegram/allowed-users/:userId',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), userId: z.string() }),
    },
    responses: {
      200: json(z.any(), 'OK'),
      ...errors(404),
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
      PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE,
    );
    const { metadata, removed } = removeTelegramAllowedUser(
      loaded.row.metadata,
      c.req.param('userId'),
    );
    if (removed) {
      await db.update(projects).set({ metadata }).where(eq(projects.projectId, projectId));
    }
    return c.json({ removed });
  },
);

async function mintTelegramPairing(projectId: string) {
  const pairing = {
    code: generateTelegramPairingCode(randomBytes(8)),
    expiresAt: new Date(Date.now() + TELEGRAM_PAIRING_TTL_MS).toISOString(),
  };
  await saveTelegramPairing(projectId, pairing);
  return pairing;
}

// DELETE /v1/projects/:projectId/channels/telegram/installation

projectsApp.openapi(
  createRoute({
    method: 'delete',
    path: '/{projectId}/channels/telegram/installation',
    tags: ['channels'],
    summary: 'DELETE /:projectId/channels/telegram/installation',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
    },
    responses: {
      200: json(z.any(), 'OK'),
      ...errors(404),
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
      PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE,
    );
    // Best-effort webhook teardown BEFORE the token is purged — a failure here
    // must not block the disconnect (once the secret is deleted, any updates a
    // still-configured webhook posts are rejected 404 "Not configured" at our
    // edge, so nothing leaks either way).
    const token = await loadTelegramTokenForProject(projectId);
    if (token) await telegramDeleteWebhook(token).catch(() => {});
    await deleteTelegramInstall(projectId);
    await reconcileChannelConnectors(projectId);
    return c.json({ status: 'disconnected' });
  },
);

function teamsPublicBaseUrl(): string | undefined {
  return config.KORTIX_URL?.startsWith('https://') ? config.KORTIX_URL : undefined;
}

// ─── Microsoft Teams install — shared multi-tenant app, bind a tenant ────

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/channels/teams/installation',
    tags: ['channels'],
    summary: 'GET /:projectId/channels/teams/installation',
    ...auth,
    request: { params: z.object({ projectId: z.string() }) },
    responses: { 200: json(z.any(), 'OK'), ...errors(404) },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    const install = await loadTeamsInstall(projectId);
    return c.json(install ?? null);
  },
);

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/channels/teams/mode',
    tags: ['channels'],
    summary: 'GET /:projectId/channels/teams/mode',
    ...auth,
    request: { params: z.object({ projectId: z.string() }) },
    responses: { 200: json(z.any(), 'OK'), ...errors(404) },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    const baseUrl = resolveBaseUrl(new URL(c.req.url), teamsPublicBaseUrl());
    const byoAppId = await loadTeamsAppIdForProject(projectId);
    const install = await loadTeamsInstall(projectId).catch(() => null);
    return c.json({
      ...teamsMode(baseUrl, { projectId, byoAppId }),
      orgConsentUrl: byoAppId ? null : teamsOrgConsentUrl({ projectId, baseUrl }),
      orgInstalled: install?.orgInstalled ?? false,
      deepLinkUrl: install?.catalogAppId ? teamsDeepLink(install.catalogAppId) : null,
    });
  },
);

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/channels/teams/manifest',
    tags: ['channels'],
    summary: 'GET /:projectId/channels/teams/manifest',
    ...auth,
    request: { params: z.object({ projectId: z.string() }) },
    responses: { 200: json(z.any(), 'OK'), ...errors(404, 409) },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    const byoAppId = await loadTeamsAppIdForProject(projectId);
    const baseUrl = resolveBaseUrl(new URL(c.req.url), teamsPublicBaseUrl());
    const mode = teamsMode(baseUrl, { projectId, byoAppId });
    if (!mode.available || !mode.appId) {
      return c.json({ error: 'Teams is not configured on this server' }, 409);
    }
    return c.json(
      buildTeamsManifest({
        appId: mode.appId,
        baseUrl,
        appName: config.TEAMS_APP_NAME,
        botName: config.TEAMS_APP_NAME,
      }),
    );
  },
);

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/channels/teams/connect',
    tags: ['channels'],
    summary: 'POST /:projectId/channels/teams/connect',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: { 200: json(z.any(), 'OK'), ...errors(400, 404) },
  }),
  async (c: any) => {
    if (!teamsChannelEnabled()) return c.json({ error: 'Not found' }, 404);
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'manage');
    if (!loaded) return c.json({ error: 'Not found' }, 404);

    let body: { tenant_id?: string; team_name?: string; app_id?: string; app_password?: string };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    const tenantId = body.tenant_id?.trim();
    const isGuid = (v: string) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
    const isDomain = (v: string) => /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(v);
    if (!tenantId || (!isGuid(tenantId) && !isDomain(tenantId))) {
      return c.json(
        { error: 'tenant_id is required and must be an Azure AD tenant GUID or domain' },
        400,
      );
    }

    const appId = body.app_id?.trim() || null;
    const appPassword = body.app_password?.trim() || null;
    if ((appId && !appPassword) || (!appId && appPassword)) {
      return c.json(
        { error: 'app_id and app_password must be provided together for a bring-your-own bot' },
        400,
      );
    }
    if (appId && !isGuid(appId)) {
      return c.json({ error: 'app_id must be an Azure AD application (client) GUID' }, 400);
    }

    const summary = await saveTeamsInstall({
      projectId,
      tenantId,
      teamName: body.team_name?.trim() || null,
      appId,
      appPassword,
    });
    void reconcileChannelConnectors(projectId);
    return c.json(summary);
  },
);

projectsApp.openapi(
  createRoute({
    method: 'delete',
    path: '/{projectId}/channels/teams/installation',
    tags: ['channels'],
    summary: 'DELETE /:projectId/channels/teams/installation',
    ...auth,
    request: { params: z.object({ projectId: z.string() }) },
    responses: { 200: json(z.any(), 'OK'), ...errors(404) },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'manage');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await deleteTeamsInstall(projectId);
    void reconcileChannelConnectors(projectId);
    return c.json({ status: 'disconnected' });
  },
);

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/channels/teams/file',
    tags: ['channels'],
    summary: 'GET /:projectId/channels/teams/file (download proxy)',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      query: z.object({ url: z.string() }),
    },
    responses: {
      200: {
        description: 'File bytes',
        content: { 'application/octet-stream': { schema: z.any() } },
      },
      ...errors(400, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    const result = await downloadTeamsFile(projectId, c.req.query('url') ?? '');
    if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404);
    c.header('Content-Type', result.contentType);
    return c.body(result.body);
  },
);

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/channels/teams/file/upload',
    tags: ['channels'],
    summary: 'POST /:projectId/channels/teams/file/upload (consent-card upload)',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: {
      200: json(
        z.object({ ok: z.boolean(), uploadId: z.string() }).passthrough(),
        'Consent card sent',
      ),
      ...errors(400, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    const body = await readBody(c);
    const result = await initiateTeamsUpload(projectId, {
      serviceUrl: String(body.service_url ?? body.serviceUrl ?? ''),
      conversationId: String(body.conversation_id ?? body.conversationId ?? ''),
      botId: typeof body.bot_id === 'string' ? body.bot_id : undefined,
      filename: String(body.filename ?? ''),
      contentBase64: String(body.content_base64 ?? body.contentBase64 ?? ''),
      description: typeof body.description === 'string' ? body.description : undefined,
    });
    if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404);
    return c.json({ ok: true, uploadId: result.uploadId });
  },
);

// ─── Email install — AgentMail-backed inbox per project ─────────────────────

function emailChannelEnabled(metadata: unknown): boolean {
  return resolveExperimentalFeature(metadata, 'agentmail_email');
}

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/channels/email/installation',
    tags: ['channels'],
    summary: 'GET /:projectId/channels/email/installation',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
    },
    responses: {
      200: json(z.any(), 'OK'),
      ...errors(404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    if (!emailChannelEnabled(loaded.row.metadata)) return c.json(null);
    const connectorSlug =
      c.req.query('connector_slug') || c.req.query('profile_slug') || 'kortix_email';
    const install = await loadAgentMailInstall(projectId, connectorSlug);
    if (!install) return c.json(null);
    return c.json({
      ...install,
      profile_id: await loadEmailInstallProfileId(projectId, install.inboxId),
    });
  },
);

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/channels/email/mode',
    tags: ['channels'],
    summary: 'GET /:projectId/channels/email/mode',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
    },
    responses: {
      200: json(z.any(), 'OK'),
      ...errors(404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    const enabled = emailChannelEnabled(loaded.row.metadata);
    return c.json({
      provider: 'agentmail',
      enabled,
      managed_available: enabled && Boolean(config.AGENTMAIL_API_KEY),
    });
  },
);

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/channels/email/connect',
    tags: ['channels'],
    summary: 'POST /:projectId/channels/email/connect',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: {
      200: json(z.any(), 'OK'),
      ...errors(400, 403, 404, 409, 502, 503, 504),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    // Floor 'read' (membership); the connector.write leaf below is the real gate,
    // so a custom role that unchecks connector.write is denied even if it holds
    // project.write. Built-in editor/manager hold the leaf.
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE,
    );
    if (!emailChannelEnabled(loaded.row.metadata)) {
      return c.json(
        {
          error: 'AgentMail Email is experimental and must be enabled for this project',
        },
        403,
      );
    }

    let body: {
      api_key?: string;
      connector_slug?: string;
      profile_slug?: string;
      username?: string;
      domain?: string;
      inbox_id?: string;
      inboxId?: string;
      email?: string;
      display_name?: string;
      displayName?: string;
      sender_policy?: Partial<AgentMailSenderPolicy>;
    };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const apiKey = resolveAgentMailApiKey(body.api_key?.trim());
    if (!apiKey) {
      return c.json({ error: 'AgentMail API key is not configured' }, 503);
    }

    const connectorSlug =
      (body.connector_slug ?? body.profile_slug ?? 'kortix_email').trim() || 'kortix_email';
    const displayName = (
      body.display_name ??
      body.displayName ??
      loaded.row.name ??
      'Kortix Agent'
    ).trim();
    const username = normalizeAgentMailUsername(body.username ?? loaded.row.name);
    const existingInboxId =
      typeof (body.inbox_id ?? body.inboxId) === 'string'
        ? (body.inbox_id ?? body.inboxId)!.trim()
        : '';
    const existingEmail = typeof body.email === 'string' ? body.email.trim() : '';
    if ((existingInboxId && !existingEmail) || (!existingInboxId && existingEmail)) {
      return c.json({ error: 'Existing AgentMail inbox requires both inbox_id and email' }, 400);
    }
    const domain =
      typeof body.domain === 'string' && body.domain.trim() ? body.domain.trim() : undefined;
    let senderPolicy: AgentMailSenderPolicy;
    try {
      senderPolicy = parseSenderPolicyBody(body.sender_policy);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
    const clientId = `kortix-project-${projectId}`;

    let inbox: Awaited<ReturnType<typeof createAgentMailInbox>>;
    if (existingInboxId && existingEmail) {
      inbox = {
        inbox_id: existingInboxId,
        email: existingEmail,
        display_name: displayName,
      };
    } else {
      try {
        inbox = await createAgentMailInbox({
          apiKey,
          username,
          domain,
          displayName,
          clientId,
          metadata: {
            provider: 'kortix',
            project_id: projectId,
            account_id: loaded.row.accountId,
          },
        });
      } catch (err) {
        return c.json(
          agentMailConnectErrorBody('inbox_create', err),
          agentMailConnectErrorStatus(err),
        );
      }
    }

    let webhookId: string;
    let webhookSecret: string;
    try {
      const webhook = await createAgentMailWebhook({
        apiKey,
        inboxId: inbox.inbox_id,
        url: `${agentMailWebhookBaseUrl(c.req.url)}/v1/webhooks/email/agentmail`,
        clientId: `kortix-email-${projectId}`,
      });
      webhookId = webhook.webhook_id;
      webhookSecret = webhook.secret;
    } catch (err) {
      return c.json(
        agentMailConnectErrorBody('webhook_create', err),
        agentMailConnectErrorStatus(err),
      );
    }

    const summary = await saveAgentMailInstall({
      projectId,
      profileSlug: connectorSlug,
      apiKey: body.api_key?.trim() || null,
      inboxId: inbox.inbox_id,
      email: inbox.email,
      displayName: inbox.display_name ?? displayName,
      webhookId,
      webhookSecret,
      senderPolicy,
    });
    await reconcileChannelConnectors(projectId);
    return c.json({
      ...summary,
      profile_id: await loadEmailInstallProfileId(projectId, summary.inboxId),
    });
  },
);

projectsApp.openapi(
  createRoute({
    method: 'patch',
    path: '/{projectId}/channels/email/installation',
    tags: ['channels'],
    summary: 'PATCH /:projectId/channels/email/installation',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: {
      200: json(z.any(), 'OK'),
      ...errors(400, 403, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    // Floor 'read'; project.connector.write is the real gate (see /email/connect).
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE,
    );
    if (!emailChannelEnabled(loaded.row.metadata)) {
      return c.json(
        {
          error: 'AgentMail Email is experimental and must be enabled for this project',
        },
        403,
      );
    }
    let body: {
      connector_slug?: string;
      profile_slug?: string;
      sender_policy?: Partial<AgentMailSenderPolicy>;
    };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    const connectorSlug =
      (body.connector_slug ?? body.profile_slug ?? 'kortix_email').trim() || 'kortix_email';
    let senderPolicy: AgentMailSenderPolicy;
    try {
      senderPolicy = parseSenderPolicyBody(body.sender_policy);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
    const summary = await updateAgentMailSenderPolicy(projectId, connectorSlug, senderPolicy);
    if (!summary) return c.json({ error: 'Email channel profile not found' }, 404);
    return c.json(summary);
  },
);

projectsApp.openapi(
  createRoute({
    method: 'delete',
    path: '/{projectId}/channels/email/installation',
    tags: ['channels'],
    summary: 'DELETE /:projectId/channels/email/installation',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
    },
    responses: {
      200: json(z.any(), 'OK'),
      ...errors(404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    // Floor 'read'; project.connector.write is the real gate (see /email/connect).
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE,
    );
    const connectorSlug =
      c.req.query('connector_slug') || c.req.query('profile_slug') || 'kortix_email';
    await deleteAgentMailInstall(projectId, connectorSlug);
    await reconcileChannelConnectors(projectId, {
      platform: 'email',
      slug: connectorSlug,
    });
    return c.json({ status: 'disconnected' });
  },
);

function agentMailWebhookBaseUrl(requestUrl: string): string {
  return (config.KORTIX_URL || new URL(requestUrl).origin).replace(/\/+$/, '');
}

function normalizeAgentMailUsername(input: string | null | undefined): string | null {
  const raw = (input ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const trimmed = raw.slice(0, 48).replace(/-+$/g, '');
  return trimmed || null;
}

// Small static check for the classic catastrophic-backtracking shapes —
// a quantified sub-group repeated by an outer quantifier (e.g. (x+)+, (x*)*)
// or an ambiguous repeated alternation (e.g. (a|a)*) — before the pattern is
// persisted and later run against every inbound email sender.
const NESTED_QUANTIFIER_RE = /\([^()]*[+*][^()]*\)\s*[+*]/;
const DUPLICATE_ALTERNATION_RE = /\(([^()|]+)\|\1\)\s*[+*]/;

function hasCatastrophicBacktracking(pattern: string): boolean {
  return NESTED_QUANTIFIER_RE.test(pattern) || DUPLICATE_ALTERNATION_RE.test(pattern);
}

function parseSenderPolicyBody(
  input: Partial<AgentMailSenderPolicy> | undefined,
): AgentMailSenderPolicy {
  const policy = normalizeSenderPolicy(input);
  if (policy.allowedRegex) {
    try {
      new RegExp(policy.allowedRegex);
    } catch {
      throw new Error('Email sender regex is invalid');
    }
    if (hasCatastrophicBacktracking(policy.allowedRegex)) {
      throw new Error(
        'Email sender regex is not allowed: nested or ambiguous repetition can cause catastrophic backtracking (ReDoS)',
      );
    }
  }
  return policy;
}

function agentMailConnectErrorStatus(err: unknown): 409 | 502 | 504 {
  if (isAgentMailInboxLimitError(err)) return 409;
  if (agentMailUpstreamStatus(err) === 504) return 504;
  return 502;
}

function agentMailConnectErrorBody(stage: 'inbox_create' | 'webhook_create', err: unknown) {
  const upstreamStatus = agentMailUpstreamStatus(err);
  if (isAgentMailInboxLimitError(err)) {
    return {
      error:
        'AgentMail inbox limit reached. Delete an unused AgentMail inbox or connect an existing AgentMail inbox with inbox_id and email.',
      code: 'agentmail_inbox_limit',
      provider: 'agentmail',
      upstream_status: upstreamStatus,
      stage,
    };
  }
  if (upstreamStatus === 504) {
    return {
      error:
        stage === 'inbox_create'
          ? 'AgentMail inbox create timed out'
          : 'AgentMail webhook create timed out',
      code: 'agentmail_timeout',
      provider: 'agentmail',
      upstream_status: upstreamStatus,
      stage,
    };
  }
  return {
    error:
      stage === 'inbox_create'
        ? `AgentMail inbox create failed: ${(err as Error).message}`
        : `AgentMail webhook create failed: ${(err as Error).message}`,
    code: 'agentmail_upstream_error',
    provider: 'agentmail',
    upstream_status: upstreamStatus,
    stage,
  };
}

// POST /v1/projects/:projectId/turn-stream
// Agent-cli relay for the live Slack plan: kind=step appends a checkpoint,
// kind=answer finalizes the turn's streamed message with the agent's reply.

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/turn-stream',
    tags: ['projects'],
    summary: 'POST /:projectId/turn-stream',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: {
      200: {
        description: 'Event stream',
        content: { 'text/event-stream': { schema: z.any() } },
      },
      ...errors(400, 403, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');

    // Two valid callers: a project/session-scoped PAT (dashboard, operator, or
    // in-sandbox agent CLI) and the session sandbox's own service credential.
    // Each is scoped back to this projectId before a turn event is accepted.
    const authType = (c as any).get('authType') as string | undefined;
    let authenticatedSandboxId: string | null = null;
    if (authType === 'apiKey' && (c as any).get('apiKeyType') === 'sandbox') {
      const accountId = (c as any).get('accountId') as string | undefined;
      const sandboxId = (c as any).get('sandboxId') as string | undefined;
      if (!accountId || !sandboxId) {
        return c.json({ error: 'turn-stream requires a sandbox token' }, 403);
      }
      const [sandbox] = await db
        .select({ sandboxId: sessionSandboxes.sandboxId, sessionId: sessionSandboxes.sessionId })
        .from(sessionSandboxes)
        .where(
          and(
            eq(sessionSandboxes.sandboxId, sandboxId),
            eq(sessionSandboxes.projectId, projectId),
            eq(sessionSandboxes.accountId, accountId),
            inArray(sessionSandboxes.status, ['provisioning', 'active']),
          ),
        )
        .limit(1);
      if (!sandbox) {
        return c.json({ error: 'sandbox token is not scoped to this project' }, 403);
      }
      authenticatedSandboxId = sandbox.sandboxId;
    } else {
      const loaded = await loadProjectForUser(c, projectId, 'read');
      if (!loaded) return c.json({ error: 'Not found' }, 404);
      await assertProjectCapability(
        c,
        loaded.userId,
        loaded.row.accountId,
        projectId,
        PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE,
      );
    }

    let body: {
      session_id?: string;
      kind?: string;
      text?: string;
      detail?: string;
      output?: string;
      sources?: Array<{ url?: string; text?: string }>;
      blocks?: unknown[];
      status?: string;
      opencode_session_id?: string;
      // Turn-end error detail (opencode AssistantMessage.error / session.error),
      // so Slack can render "out of credits" / rate-limit / the real error.
      error_name?: string;
      error_message?: string;
      error_status?: number;
      error_retryable?: boolean;
      error_provider?: string;
      lease_ttl_seconds?: number;
    };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    const sessionId = body.session_id?.trim();
    if (!sessionId) {
      return c.json({ error: 'session_id is required' }, 400);
    }

    if (authenticatedSandboxId) {
      const [ownedSession] = await db
        .select({ sessionId: sessionSandboxes.sessionId })
        .from(sessionSandboxes)
        .where(
          and(
            eq(sessionSandboxes.sandboxId, authenticatedSandboxId),
            eq(sessionSandboxes.sessionId, sessionId),
            eq(sessionSandboxes.projectId, projectId),
          ),
        )
        .limit(1);
      if (!ownedSession)
        return c.json({ error: 'sandbox token is not scoped to this session' }, 403);
    }

    // session_id is caller-supplied — scope it back to :projectId so a caller
    // authed for their own project can't relay turn events into another
    // tenant's live session (IDOR).
    const [turnStreamSession] = await db
      .select({ sessionId: projectSessions.sessionId })
      .from(projectSessions)
      .where(
        and(eq(projectSessions.sessionId, sessionId), eq(projectSessions.projectId, projectId)),
      )
      .limit(1);
    if (!turnStreamSession) {
      return c.json({ error: 'Not found' }, 404);
    }

    if (
      body.kind === 'execution_heartbeat' ||
      body.kind === 'execution_lease_release' ||
      body.kind === 'execution_lease_discover'
    ) {
      if (!authenticatedSandboxId)
        return c.json({ error: 'execution lease requires a sandbox token' }, 403);
      const target = { sandboxId: authenticatedSandboxId, sessionId, projectId };
      if (body.kind === 'execution_lease_release')
        return c.json({ ok: await releaseExecutionLease(target) });
      if (body.kind === 'execution_lease_discover') {
        const provider = await discoverExecutionKeepAliveEndpoint(target);
        return c.json({
          ok: provider !== null,
          provider_url: provider?.url ?? null,
          provider_headers: provider?.headers ?? null,
        });
      }
      const result = await renewExecutionLease(target, body.lease_ttl_seconds);
      return c.json({
        ok: result.ok,
        lease_until: result.leaseUntil,
        provider_url: result.providerUrl,
        provider_headers: result.providerHeaders,
        provider_touched: result.providerUrl !== null,
      });
    }

    // `end` / `turn_end` carry no text — the sandbox observed the opencode turn
    // finish (idle) or die (error) without the agent closing its Slack message;
    // finalize it gracefully instead of letting it rot into a timeout failure.
    // (`turn_end` is the alias newer sandboxes send, with status + the opencode
    // session id for the server-side root-session guard.)
    if (body.kind === 'end' || body.kind === 'turn_end') {
      const status = body.status === 'error' ? 'error' : 'idle';
      const errorInfo =
        body.error_name || body.error_message || typeof body.error_status === 'number'
          ? {
              name: typeof body.error_name === 'string' ? body.error_name : undefined,
              message: typeof body.error_message === 'string' ? body.error_message : undefined,
              statusCode: typeof body.error_status === 'number' ? body.error_status : undefined,
              isRetryable:
                typeof body.error_retryable === 'boolean' ? body.error_retryable : undefined,
              providerID: typeof body.error_provider === 'string' ? body.error_provider : undefined,
            }
          : undefined;
      const ok = (await telegramTurnExists(sessionId))
        ? await relayTelegramTurnEnd(sessionId, status, errorInfo)
        : await relayTurnEnd(sessionId, status, errorInfo);
      return c.json({ ok });
    }

    // `opencode_session` carries the canonical opencode ROOT id the sandbox just
    // bootstrapped (or reused after a restart). Persist it as the durable pin so
    // the Kortix session resolves to the LIVE root with NO dependency on a browser
    // ever opening it — closing the null-pin gap that left Slack/trigger/cron
    // sessions resolving lazily onto the wrong (orphaned) root. The sandbox token
    // is already scoped to this project (checked above); the daemon only ever
    // reports its own pin-file root, never a subagent.
    if (body.kind === 'opencode_session') {
      const ocId = body.opencode_session_id?.trim();
      if (!ocId) return c.json({ error: 'opencode_session_id is required' }, 400);
      const updated = await db
        .update(projectSessions)
        .set({ opencodeSessionId: ocId, updatedAt: new Date() })
        .where(
          and(eq(projectSessions.sessionId, sessionId), eq(projectSessions.projectId, projectId)),
        )
        .returning({ sessionId: projectSessions.sessionId });
      return c.json({ ok: updated.length > 0 });
    }

    const text = (body.text ?? '').trim();
    if (!text) {
      return c.json({ error: 'text is required' }, 400);
    }

    const detail = body.detail?.trim() || undefined;
    const outputForPrev = body.output?.trim() || undefined;
    const sourcesForPrev = Array.isArray(body.sources)
      ? body.sources
          .filter((s): s is { url: string; text: string } => !!s?.url && !!s?.text)
          .map((s) => ({ url: s.url, text: s.text }))
      : undefined;
    const blocks = Array.isArray(body.blocks) && body.blocks.length > 0 ? body.blocks : undefined;

    // The turn-stream is platform-agnostic transport; the turn row itself says
    // which channel opened it (Slack stays the default for missing rows so its
    // warn-path diagnostics keep working).
    if (await telegramTurnExists(sessionId)) {
      const ok =
        body.kind === 'answer'
          ? await relayTelegramTurnAnswer(sessionId, text)
          : await relayTelegramTurnStep(sessionId, text);
      return c.json({ ok });
    }

    const ok =
      body.kind === 'answer'
        ? await relayTurnAnswer(sessionId, text, blocks)
        : await relayTurnStep(sessionId, text, {
            detail,
            outputForPrev,
            sourcesForPrev,
          });
    return c.json({ ok });
  },
);

// GET /v1/projects/:projectId/channels/slack/file?url=...
// Server-side download proxy: fetch a Slack-hosted file with the bot token
// (SSRF-guarded to *.slack.com) so the sandbox never holds the token. Backs
// `slack download` once the token is out of the box (KORTIX-206 Phase C2).
projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/channels/slack/file',
    tags: ['channels'],
    summary: 'GET /:projectId/channels/slack/file (download proxy)',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      query: z.object({ url: z.string() }),
    },
    responses: {
      200: {
        description: 'File bytes',
        content: { 'application/octet-stream': { schema: z.any() } },
      },
      ...errors(400, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    const result = await downloadSlackFile(projectId, c.req.query('url') ?? '');
    if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404);
    c.header('Content-Type', result.contentType);
    return c.body(result.body);
  },
);

// POST /v1/projects/:projectId/channels/slack/file/upload
// Server-side upload proxy: the 3-step external upload, bot token server-side.
// Backs `slack send --file` once the token is out of the box.
projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/channels/slack/file/upload',
    tags: ['channels'],
    summary: 'POST /:projectId/channels/slack/file/upload (upload proxy)',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: {
      200: json(z.object({ ok: z.boolean(), files: z.any() }).passthrough(), 'Uploaded'),
      ...errors(400, 403, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    // This is a SEND primitive (posts to Slack with the project's bot token), not
    // a read — a bare project-read gate let ANY project-read caller post
    // arbitrary files to the workspace. The channel.send leaf in iam/actions.ts
    // is cataloged but scoped to resource_type='channel' and was never wired
    // through assertProjectCapability's project-scoped fold (nothing asserts it
    // today — see the audit note removing CHANNEL_ACTIONS). Reuse the connector
    // capability that already gates connect/disconnect and the channel-bindings
    // route instead of inventing a parallel gate for the same resource.
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE,
    );
    const body = await readBody(c);
    const result = await uploadSlackFile(projectId, {
      channel: String(body.channel ?? ''),
      filename: String(body.filename ?? ''),
      contentBase64: String(body.content_base64 ?? body.contentBase64 ?? ''),
      comment: typeof body.comment === 'string' ? body.comment : undefined,
      threadTs:
        typeof body.thread_ts === 'string'
          ? body.thread_ts
          : typeof body.threadTs === 'string'
            ? body.threadTs
            : undefined,
    });
    if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404);
    return c.json({ ok: true, files: result.files });
  },
);

// GET /v1/projects/:projectId/channels/telegram/file?file_id=...
// Server-side download proxy: resolve the file_id + fetch the bytes with the
// bot token (URL constructed server-side; file_path validated) so the sandbox
// never holds the token. Backs `telegram download`.
projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/channels/telegram/file',
    tags: ['channels'],
    summary: 'GET /:projectId/channels/telegram/file (download proxy)',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      query: z.object({ file_id: z.string() }),
    },
    responses: {
      200: {
        description: 'File bytes',
        content: { 'application/octet-stream': { schema: z.any() } },
      },
      ...errors(400, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    const result = await downloadTelegramFile(projectId, c.req.query('file_id') ?? '');
    if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404);
    return new Response(result.body, {
      status: 200,
      headers: {
        'content-type': result.contentType,
        ...(result.fileName ? { 'x-telegram-file-name': encodeURIComponent(result.fileName) } : {}),
      },
    });
  },
);

// POST /v1/projects/:projectId/channels/telegram/file/upload
// Server-side upload proxy: multipart sendDocument, bot token server-side.
// Backs `telegram send --file`.
projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/channels/telegram/file/upload',
    tags: ['channels'],
    summary: 'POST /:projectId/channels/telegram/file/upload (upload proxy)',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: {
      200: json(z.object({ ok: z.boolean(), message_id: z.any() }).passthrough(), 'Uploaded'),
      ...errors(400, 403, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    // A SEND primitive (posts into the chat with the project's bot token) — the
    // same connector-write capability that gates Slack's upload proxy, connect/
    // disconnect, and the bindings route.
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE,
    );
    const body = await readBody(c);
    const result = await uploadTelegramFile(projectId, {
      chatId: String(body.chat_id ?? body.chatId ?? ''),
      filename: String(body.filename ?? ''),
      contentBase64: String(body.content_base64 ?? body.contentBase64 ?? ''),
      caption: typeof body.caption === 'string' ? body.caption : undefined,
      replyToMessageId:
        typeof body.reply_to_message_id === 'number' ? body.reply_to_message_id : undefined,
    });
    if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404);
    return c.json({ ok: true, message_id: result.messageId });
  },
);

// POST /v1/projects/:projectId/channels/slack/bind-thread
// Bind a Slack thread the agent created (e.g. from a webhook/cron run) to its
// session, so a later human reply in that thread routes back into this session
// (approval loops, follow-up Q&A). This writes the same `chat_threads` row the
// inbound `bind_chat_thread` post-create action does; without it, replies to a
// non-Slack-originated thread are classified `ignore` and dropped.
projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/channels/slack/bind-thread',
    tags: ['channels'],
    summary: 'POST /:projectId/channels/slack/bind-thread',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: {
      200: json(z.object({ ok: z.boolean(), bound: z.boolean() }).passthrough(), 'Bound'),
      ...errors(400, 403, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    // Same dual auth as turn-stream: the in-sandbox agent's sandbox token (scoped
    // back to this project) or a project/session-scoped user PAT.
    const authType = (c as any).get('authType') as string | undefined;
    if (authType === 'apiKey' && (c as any).get('apiKeyType') === 'sandbox') {
      const accountId = (c as any).get('accountId') as string | undefined;
      const sandboxId = (c as any).get('sandboxId') as string | undefined;
      if (!accountId || !sandboxId) {
        return c.json({ error: 'bind-thread requires a sandbox token' }, 403);
      }
      const [sandbox] = await db
        .select({ sandboxId: sessionSandboxes.sandboxId })
        .from(sessionSandboxes)
        .where(
          and(
            eq(sessionSandboxes.sandboxId, sandboxId),
            eq(sessionSandboxes.projectId, projectId),
            eq(sessionSandboxes.accountId, accountId),
            inArray(sessionSandboxes.status, ['provisioning', 'active']),
          ),
        )
        .limit(1);
      if (!sandbox) {
        return c.json({ error: 'sandbox token is not scoped to this project' }, 403);
      }
    } else {
      const loaded = await loadProjectForUser(c, projectId, 'read');
      if (!loaded) return c.json({ error: 'Not found' }, 404);
    }

    let body: {
      session_id?: string;
      channel?: string;
      thread_ts?: string;
      workspace_id?: string;
    };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    const sessionId = body.session_id?.trim();
    const channel = body.channel?.trim();
    const threadTs = body.thread_ts?.trim();
    if (!sessionId || !channel || !threadTs) {
      return c.json({ error: 'session_id, channel, and thread_ts are required' }, 400);
    }
    // the session must belong to this project
    const [sess] = await db
      .select({ sessionId: projectSessions.sessionId })
      .from(projectSessions)
      .where(
        and(eq(projectSessions.sessionId, sessionId), eq(projectSessions.projectId, projectId)),
      )
      .limit(1);
    if (!sess) {
      return c.json({ error: 'session not found in project' }, 404);
    }
    const workspaceId =
      body.workspace_id?.trim() || (await resolveWorkspaceIdForChannel(projectId, channel));
    if (!workspaceId) {
      return c.json(
        {
          error:
            'could not resolve Slack workspace for channel (is the channel bound to this project?)',
        },
        400,
      );
    }
    await bindChatThread({ projectId, workspaceId, threadId: threadTs, sessionId });
    return c.json({ ok: true, bound: true, channel, thread_ts: threadTs });
  },
);

// GET /v1/projects/:projectId/channels/meet/voices
// The voice picker: the predefined catalog + the project's current selection,
// plus whether speaking is wired (ElevenLabs configured).
projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/channels/meet/voices',
    tags: ['channels'],
    summary: 'GET /:projectId/channels/meet/voices',
    ...auth,
    request: { params: z.object({ projectId: z.string() }) },
    responses: {
      200: json(z.object({ ok: z.boolean() }).passthrough(), 'Voices'),
      ...errors(404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    const [selected, botName] = await Promise.all([
      resolveProjectVoice(projectId),
      resolveProjectBotName(projectId),
    ]);
    return c.json({
      ok: true,
      selected: selected.id,
      bot_name: botName,
      default_bot_name: DEFAULT_MEET_BOT_NAME,
      speak_enabled: Boolean(config.ELEVENLABS_API_KEY),
      voices: MEET_VOICES.map((v) => ({ id: v.id, name: v.name, desc: v.desc })),
    });
  },
);

// PUT /v1/projects/:projectId/channels/meet/name — set the bot's display name.
projectsApp.openapi(
  createRoute({
    method: 'put',
    path: '/{projectId}/channels/meet/name',
    tags: ['channels'],
    summary: 'PUT /:projectId/channels/meet/name',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: {
      200: json(z.object({ ok: z.boolean(), bot_name: z.string() }).passthrough(), 'Saved'),
      ...errors(400, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    // Floor 'read'; project.customize.write is the real gate (setting the bot
    // name is project customization). Built-in editor/manager hold the leaf.
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE,
    );
    const body = await readBody(c);
    const name = String(body.name ?? body.bot_name ?? '');
    const saved = await setProjectBotName(projectId, name);
    return c.json({ ok: true, bot_name: saved });
  },
);

// PUT /v1/projects/:projectId/channels/meet/voice — choose the meeting voice.
projectsApp.openapi(
  createRoute({
    method: 'put',
    path: '/{projectId}/channels/meet/voice',
    tags: ['channels'],
    summary: 'PUT /:projectId/channels/meet/voice',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: {
      200: json(z.object({ ok: z.boolean(), selected: z.string() }).passthrough(), 'Saved'),
      ...errors(400, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    // Floor 'read'; project.customize.write is the real gate (choosing the voice
    // is project customization). Built-in editor/manager hold the leaf.
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE,
    );
    const body = await readBody(c);
    const voiceId = String(body.voice ?? '');
    if (!isMeetVoice(voiceId)) return c.json({ error: 'unknown voice' }, 400);
    const voice = await setProjectVoice(projectId, voiceId);
    return c.json({ ok: true, selected: voice.id });
  },
);

// POST /v1/projects/:projectId/channels/meet/voices/:voiceId/preview
// Returns a base64 MP3 of a stock line in that voice (for the picker's preview).
projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/channels/meet/voices/{voiceId}/preview',
    tags: ['channels'],
    summary: 'POST /:projectId/channels/meet/voices/:voiceId/preview',
    ...auth,
    request: { params: z.object({ projectId: z.string(), voiceId: z.string() }) },
    responses: {
      200: json(
        z.object({ ok: z.boolean(), kind: z.string(), b64: z.string() }).passthrough(),
        'Preview',
      ),
      ...errors(400, 404, 502, 503),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    const voiceId = c.req.param('voiceId');
    if (!isMeetVoice(voiceId)) return c.json({ error: 'unknown voice' }, 400);
    const r = await previewVoiceB64(voiceId);
    if (!r.ok) return c.json({ error: r.error }, r.status as 400 | 404 | 502 | 503);
    return c.json({ ok: true, kind: 'mp3', b64: r.b64 });
  },
);

// POST /v1/projects/:projectId/channels/meet/speak — the bot speaks in the call.
// Server-side proxy: text → ElevenLabs (project voice) → Recall output_audio.
// Both keys stay server-side; backs `meet speak`.
projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/channels/meet/speak',
    tags: ['channels'],
    summary: 'POST /:projectId/channels/meet/speak',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: {
      200: json(z.object({ ok: z.boolean(), voice: z.string() }).passthrough(), 'Spoken'),
      ...errors(400, 403, 404, 502, 503),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    // Same reasoning as the Slack upload proxy above: this is a SEND primitive
    // (makes the meeting bot speak), not a read, so a bare project-read gate is
    // wrong here too. channel.send is dead/unwired (see audit note removing
    // CHANNEL_ACTIONS) — reuse the connector-write leaf instead.
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE,
    );
    const body = await readBody(c);
    const botId = String(body.bot_id ?? body.botId ?? '');
    const text = String(body.text ?? '');
    const voice = typeof body.voice === 'string' ? body.voice : undefined;
    if (!botId) return c.json({ error: 'bot_id required' }, 400);
    if (!text.trim()) return c.json({ error: 'text required' }, 400);
    const r = await speakInMeeting(projectId, botId, text, voice);
    if (!r.ok) return c.json({ error: r.error }, r.status as 400 | 404 | 502 | 503);
    return c.json({ ok: true, voice: r.voice });
  },
);

// GET /v1/projects/:projectId/llm-catalog
// Server-side source of truth for the gateway model catalog. The seed daemon
// fetches it at PARK with a sandbox token so the no-restart warm-fork bakes the
// full picker into opencode config. The web UI also reads it with normal project
// auth so the model picker is available before the sandbox runtime answers.
// The catalog is non-secret; access is still scoped to this project.
projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/llm-catalog',
    tags: ['projects'],
    summary: 'GET /:projectId/llm-catalog',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
    },
    responses: {
      200: {
        description: 'OK',
        content: { 'application/json': { schema: z.any() } },
      },
      ...errors(403, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const authType = c.get('authType') as string | undefined;
    const apiKeyType = c.get('apiKeyType') as string | undefined;
    const accountId = c.get('accountId') as string | undefined;
    const sandboxId = c.get('sandboxId') as string | undefined;
    let projectMetadata: unknown;
    let ownerAccountId: string | undefined;
    if (authType === 'apiKey' && apiKeyType === 'sandbox' && accountId && sandboxId) {
      const [sandbox] = await db
        .select({ sandboxId: sessionSandboxes.sandboxId })
        .from(sessionSandboxes)
        .where(
          and(
            eq(sessionSandboxes.sandboxId, sandboxId),
            eq(sessionSandboxes.projectId, projectId),
            eq(sessionSandboxes.accountId, accountId),
            inArray(sessionSandboxes.status, ['provisioning', 'active']),
          ),
        )
        .limit(1);
      if (!sandbox) {
        return c.json({ error: 'sandbox token is not scoped to this project' }, 403);
      }
      const [project] = await db
        .select({ metadata: projects.metadata })
        .from(projects)
        .where(and(eq(projects.projectId, projectId), eq(projects.accountId, accountId)))
        .limit(1);
      if (!project) return c.json({ error: 'Not found' }, 404);
      projectMetadata = project.metadata;
      ownerAccountId = accountId;
    } else {
      const loaded = await loadProjectForUser(c, projectId, 'read');
      if (!loaded) return c.json({ error: 'Not found' }, 404);
      projectMetadata = loaded.row.metadata;
      ownerAccountId = loaded.row.accountId as string | undefined;
    }
    if (!projectLlmGatewayEnabled(projectMetadata)) {
      return c.json(
        { error: 'LLM gateway is disabled for this project', code: 'llm_gateway_disabled' },
        404,
      );
    }
    // Free-tier accounts see only managed models explicitly marked free plus
    // their own BYOK/Codex-connected catalog entries. Paid managed models and
    // synthetic AUTO stay hidden from the picker.
    const freeManagedOnly =
      config.KORTIX_BILLING_INTERNAL_ENABLED && ownerAccountId
        ? accountIsFreeTierForModels(await getCachedAccountTier(ownerAccountId))
        : false;
    const models = gatewayModelCatalog(projectId, { freeManagedOnly });
    return c.json({ models });
  },
);

// GET /v1/projects/:projectId/model-picker
// UI-specific, connection-aware projection of the runtime catalog. The full
// /llm-catalog response remains available for sandbox/OpenCode configuration;
// interactive selectors should use this bounded payload instead.
projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/model-picker',
    tags: ['projects'],
    summary: 'GET /:projectId/model-picker',
    ...auth,
    request: { params: z.object({ projectId: z.string() }) },
    responses: {
      200: { description: 'OK', content: { 'application/json': { schema: z.any() } } },
      ...errors(403, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    if (!projectLlmGatewayEnabled(loaded.row.metadata)) {
      return c.json(
        { error: 'LLM gateway is disabled for this project', code: 'llm_gateway_disabled' },
        404,
      );
    }

    const accountId = loaded.row.accountId as string;
    const freeManagedOnly = config.KORTIX_BILLING_INTERNAL_ENABLED
      ? accountIsFreeTierForModels(await getCachedAccountTier(accountId))
      : false;
    const [secrets, defaults, routing] = await Promise.all([
      listProjectSecretsSnapshot(projectId).catch(() => ({ names: [] as string[] })),
      getAccountModelDefaults(accountId),
      getProjectRoutingPolicy(projectId),
    ]);
    const requiredModels = [
      defaults.projects[projectId],
      defaults.account,
      config.LLM_GATEWAY_DEFAULT_MODEL,
      routing?.visionModel,
      ...(routing?.defaultFallback?.models ?? []),
      ...(routing?.rules.flatMap((rule) => [rule.model, ...rule.fallbackModels]) ?? []),
    ].filter((model): model is string => !!model);
    const models = projectPickerCatalog(
      gatewayModelCatalog(projectId, { freeManagedOnly }),
      new Set(secrets.names.map((name) => name.toUpperCase())),
      requiredModels,
    );
    return c.json({ models });
  },
);

// ─── Default model preferences (account-scoped) ─────────────────────────────
// The gateway is the source of truth for the default model: a request for the
// synthetic `auto` resolves server-side to the per-agent default → account
// default → platform default. These routes manage the account/agent defaults;
// they operate on the project's OWNER account, the same account the gateway
// principal carries, so the picker and the gateway always agree. Stored values
// are gateway wire models (bare managed id, BYOK `provider/model`, or `codex/…`).

// GET /v1/projects/:projectId/model-defaults
projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/model-defaults',
    tags: ['projects'],
    summary: 'GET /:projectId/model-defaults',
    ...auth,
    request: { params: z.object({ projectId: z.string() }) },
    responses: {
      200: {
        description: 'OK',
        content: { 'application/json': { schema: z.any() } },
      },
      ...errors(403, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    const ownerAccountId = loaded.row.accountId as string;
    const userId = c.get('userId') as string;
    const defaults = await getAccountModelDefaults(ownerAccountId);
    const freeTier = config.KORTIX_BILLING_INTERNAL_ENABLED
      ? accountIsFreeTierForModels(await getCachedAccountTier(ownerAccountId))
      : false;
    // Honest project-level resolution (project → account → platform) + where it
    // came from, so the UI can show "Sonnet 4.6 · project default". The
    // authoritative per-request resolution still happens in the gateway.
    const resolved = await resolveEffectiveModel({
      userId,
      accountId: ownerAccountId,
      projectId,
      explicit: null,
      freeModelsOnly: freeTier,
    });
    return c.json({
      platformDefault: config.LLM_GATEWAY_DEFAULT_MODEL,
      accountDefault: defaults.account,
      agentDefaults: defaults.agents,
      projectDefault: defaults.projects[projectId] ?? null,
      resolvedForCaller: resolved.model ?? config.LLM_GATEWAY_DEFAULT_MODEL,
      resolvedSource: resolved.source,
      freeTier,
    });
  },
);

const ModelDefaultBody = z.object({
  scope: z.enum(['account', 'agent', 'project']),
  agentName: z.string().min(1).max(128).optional(),
  model: z.string().min(1).max(128),
});

// PUT /v1/projects/:projectId/model-defaults
projectsApp.openapi(
  createRoute({
    method: 'put',
    path: '/{projectId}/model-defaults',
    tags: ['projects'],
    summary: 'PUT /:projectId/model-defaults',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: { content: { 'application/json': { schema: ModelDefaultBody } } },
    },
    responses: {
      200: {
        description: 'OK',
        content: { 'application/json': { schema: z.any() } },
      },
      ...errors(400, 403, 404, 409),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    // Floor 'read'; project.customize.write is the real gate (model defaults are
    // project customization). NOTE: /{projectId}/model-defaults is ALSO defined in
    // routes/model-defaults.ts (registered later in projects/index.ts) — both are
    // gated here to be safe against route-registration order; dedupe is follow-up.
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE,
    );
    const ownerAccountId = loaded.row.accountId as string;
    const userId = c.get('userId') as string;

    const parsed = ModelDefaultBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: 'Invalid body', code: 'invalid_body' }, 400);
    }
    const { scope, agentName, model } = parsed.data;
    if (scope === 'agent' && !agentName) {
      return c.json(
        { error: 'agentName is required for scope=agent', code: 'agent_name_required' },
        400,
      );
    }

    const freeModelsOnly = config.KORTIX_BILLING_INTERNAL_ENABLED
      ? accountIsFreeTierForModels(await getCachedAccountTier(ownerAccountId))
      : false;
    const servable = await isModelServableForAccount({
      userId,
      accountId: ownerAccountId,
      projectId,
      freeModelsOnly,
      model,
    });
    if (!servable) {
      return c.json(
        {
          error: `Model "${model}" is not available for this account`,
          code: 'model_not_servable',
        },
        409,
      );
    }

    await upsertAccountModelPreference({
      accountId: ownerAccountId,
      scope,
      // agent → agent name; project → the project id; account → '' (in the repo).
      scopeKey: scope === 'agent' ? agentName : scope === 'project' ? projectId : undefined,
      model,
      updatedBy: userId,
    });
    invalidateAccountModelDefaults(ownerAccountId);
    return c.json({
      ok: true,
      scope,
      agentName: scope === 'agent' ? agentName : undefined,
      model,
    });
  },
);

// DELETE /v1/projects/:projectId/model-defaults?scope=account|agent&agentName=
projectsApp.openapi(
  createRoute({
    method: 'delete',
    path: '/{projectId}/model-defaults',
    tags: ['projects'],
    summary: 'DELETE /:projectId/model-defaults',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      query: z.object({
        scope: z.enum(['account', 'agent', 'project']),
        agentName: z.string().min(1).max(128).optional(),
      }),
    },
    responses: {
      200: {
        description: 'OK',
        content: { 'application/json': { schema: z.any() } },
      },
      ...errors(400, 403, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    // Floor 'read'; project.customize.write is the real gate (see PUT above; also
    // mirrored in routes/model-defaults.ts).
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE,
    );
    const ownerAccountId = loaded.row.accountId as string;
    const scope = c.req.query('scope');
    const agentName = c.req.query('agentName');
    if (scope !== 'account' && scope !== 'agent' && scope !== 'project') {
      return c.json(
        { error: "scope must be 'account', 'agent', or 'project'", code: 'invalid_scope' },
        400,
      );
    }
    if (scope === 'agent' && !agentName) {
      return c.json(
        { error: 'agentName is required for scope=agent', code: 'agent_name_required' },
        400,
      );
    }
    const scopeKey = scope === 'agent' ? agentName : scope === 'project' ? projectId : undefined;
    await deleteAccountModelPreference({ accountId: ownerAccountId, scope, scopeKey });
    invalidateAccountModelDefaults(ownerAccountId);
    return c.json({ ok: true, scope, agentName: scope === 'agent' ? agentName : undefined });
  },
);

// POST /v1/projects/:projectId/turn-question
// Sandbox-to-apps/api relay for opencode's `question.asked` event. The
// sandbox subscribes to opencode's SSE stream; when the agent calls the
// built-in `question` tool, the sandbox relays the QuestionInfo[] here.
// We post a Block Kit form, block on Submit, return `answers: string[][]`,
// and the sandbox POSTs the same payload to opencode's
// /question/{requestID}/reply so the tool resumes.

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/turn-question',
    tags: ['projects'],
    summary: 'POST /:projectId/turn-question',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: {
      200: json(z.any(), 'OK'),
      ...errors(400, 403, 404, 409),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');

    const authType = (c as any).get('authType') as string | undefined;
    if (authType === 'apiKey' && (c as any).get('apiKeyType') === 'sandbox') {
      const accountId = (c as any).get('accountId') as string | undefined;
      const sandboxId = (c as any).get('sandboxId') as string | undefined;
      if (!accountId || !sandboxId) {
        return c.json({ error: 'turn-question requires a sandbox token' }, 403);
      }
      const [sandbox] = await db
        .select({ sandboxId: sessionSandboxes.sandboxId })
        .from(sessionSandboxes)
        .where(
          and(
            eq(sessionSandboxes.sandboxId, sandboxId),
            eq(sessionSandboxes.projectId, projectId),
            eq(sessionSandboxes.accountId, accountId),
            inArray(sessionSandboxes.status, ['provisioning', 'active']),
          ),
        )
        .limit(1);
      if (!sandbox) {
        return c.json({ error: 'sandbox token is not scoped to this project' }, 403);
      }
    } else {
      const loaded = await loadProjectForUser(c, projectId, 'read');
      if (!loaded) return c.json({ error: 'Not found' }, 404);
    }

    let body: {
      session_id?: string;
      request_id?: string;
      questions?: unknown[];
    };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    const sessionId = body.session_id?.trim();
    if (!sessionId) {
      return c.json({ error: 'session_id is required' }, 400);
    }

    // session_id is caller-supplied — scope it back to :projectId so a caller
    // authed for their own project can't relay a question into another
    // tenant's live session (IDOR).
    const [turnQuestionSession] = await db
      .select({ sessionId: projectSessions.sessionId })
      .from(projectSessions)
      .where(
        and(eq(projectSessions.sessionId, sessionId), eq(projectSessions.projectId, projectId)),
      )
      .limit(1);
    if (!turnQuestionSession) {
      return c.json({ error: 'Not found' }, 404);
    }

    if (!Array.isArray(body.questions) || body.questions.length === 0) {
      return c.json({ error: 'at least one question is required' }, 400);
    }

    // Validate + coerce to QuestionInfo[]. Tolerate the v2 SDK schema variants.
    const questions: QuestionInfo[] = [];
    for (const q of body.questions) {
      if (!q || typeof q !== 'object') continue;
      const obj = q as Record<string, unknown>;
      const question = String(obj.question ?? '').trim();
      if (!question) continue;
      const optionsRaw = Array.isArray(obj.options) ? obj.options : [];
      const options = optionsRaw
        .map((o) => (o && typeof o === 'object' ? (o as Record<string, unknown>) : null))
        // opencode's QuestionInfo carries `value` (required) + optional `label`. The
        // harness `question` tool uses `label`. Accept EITHER so an option that only
        // has `value` still renders a button instead of silently vanishing.
        .filter(
          (o): o is Record<string, unknown> =>
            !!o && (typeof o.label === 'string' || typeof o.value === 'string'),
        )
        .map((o) => ({
          label: String(o.label ?? o.value),
          description: typeof o.description === 'string' ? String(o.description) : undefined,
        }));
      questions.push({
        question,
        header: obj.header ? String(obj.header) : undefined,
        options,
        multiple: !!obj.multiple,
        custom: obj.custom === false ? false : true,
      });
    }
    if (questions.length === 0) {
      return c.json({ error: 'no valid questions provided' }, 400);
    }

    // Non-blocking: post the question(s) into the thread and return immediately
    // with sentinel `answers`. The agent does NOT wait for an inline answer — the
    // user's in-thread reply arrives as a follow-up turn. Returning `answers` keeps
    // BOTH the new sandbox (ignores them, uses its own sentinel) and an old sandbox
    // image (resumes opencode from them) unblocked.
    // Telegram is dispatched off the turn row (same as /turn-stream) — the shared
    // relayTurnQuestion only knows Slack/Teams, so a telegram session would
    // otherwise fall through to Slack and fail.
    const result = (await telegramTurnExists(sessionId))
      ? await postTelegramQuestion(sessionId, questions)
      : await relayTurnQuestion(sessionId, questions);
    if (!result.ok) return c.json({ ok: false, error: result.error }, 409);
    return c.json({ ok: true, answers: result.answers });
  },
);

// POST /v1/projects/:projectId/triggers/:slug/fire
//
// Manual fire for git-backed triggers. Reads the file, renders the prompt
// against a synthetic payload, spawns a session. Manage role required.

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/triggers/{slug}/fire',
    tags: ['triggers'],
    summary: 'POST /:projectId/triggers/:slug/fire',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), slug: z.string() }),
    },
    responses: {
      202: json(z.any(), 'OK'),
      ...errors(404, 500),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const slug = c.req.param('slug');
    // Floor 'read' (membership); project.trigger.fire is the real gate. The floor
    // was 'manage' (= project.write) — which the floor `member` role LACKS even
    // though it HOLDS trigger.fire, so a plain member could never fire a trigger
    // (its designed fire grant was dead behind the floor). Now member/editor/
    // manager all fire (all hold the leaf); a custom role without it is denied.
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_TRIGGER_FIRE,
    );

    const { specs } = await loadProjectTriggers(await withProjectGitAuth(loaded.row));
    const spec = specs.find((s) => s.slug === slug);
    if (!spec) return c.json({ error: 'Not found' }, 404);

    const now = new Date();
    const payload = {
      trigger: { slug: spec.slug, type: spec.type, kind: 'git' },
      fired_at: now.toISOString(),
      source: 'manual',
      actor: loaded.userId,
      message: { text: '', source: 'manual_test' },
    };
    const renderedPrompt = renderPromptTemplate(spec.promptTemplate, payload);

    const result = await fireGitTrigger({
      spec,
      project: loaded.row,
      payload,
      renderedPrompt,
      source: 'manual',
      request: requestAuditContext(c),
    });

    if (result.status === 'queued') {
      await markGitTriggerFired(projectId, slug, now);
      return c.json(
        {
          status: 'queued',
          command_id: result.commandId ?? null,
          session_id: result.sessionId ?? null,
          reason: result.reason ?? null,
          deduped: result.deduped ?? false,
        },
        202,
      );
    }
    if (result.status === 'failed') {
      return c.json({ error: result.error ?? 'Failed to fire trigger' }, 500);
    }
    await markGitTriggerFired(projectId, slug, now);
    return c.json(
      {
        status: result.deduped ? 'deduped' : 'fired',
        command_id: result.commandId ?? null,
        session_id: result.sessionId ?? null,
        deduped: result.deduped ?? false,
      },
      202,
    );
  },
);
