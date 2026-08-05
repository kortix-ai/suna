import { createRoute, z } from '@hono/zod-openapi';
import {
  ConnectorAuthorizationMetadataSchema,
  ConnectorAuthorizationSchema,
  ReconcileConnectorAuthorizationInputSchema,
  UpdateConnectorAuthorizationCredentialInputSchema,
} from '@kortix/api-contract';
import {
  executorConnectionProfiles,
  executorConnectors,
  projectSessionConnectorBindings,
  projectSessions,
  projectTriggerRuntime,
  projects,
  sessionSandboxes,
} from '@kortix/db';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { getCachedAccountTier } from '../../billing/services/entitlements';
import { accountIsFreeTierForModels } from '../../billing/services/tiers';
import {
  agentMailProvisioningClientIds,
  agentMailUpstreamStatus,
  createAgentMailInbox,
  createAgentMailWebhook,
  isAgentMailInboxLimitError,
  resolveAgentMailApiKey,
} from '../../channels/agentmail-api';
import { compileEmailSenderRegex } from '../../channels/email/sender-policy-regex';
import {
  type AgentMailSenderPolicy,
  deleteAgentMailInstall,
  deleteSlackInstall,
  deleteTeamsInstall,
  listProjectsForWorkspace,
  loadAgentMailInstall,
  loadSlackInstall,
  loadTeamsAppIdForProject,
  loadTeamsInstall,
  normalizeSenderPolicy,
  saveAgentMailInstall,
  saveSlackInstall,
  saveTeamsInstall,
  updateAgentMailSenderPolicy,
} from '../../channels/install-store';
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
  relayTurnAnswer,
  relayTurnEnd,
  relayTurnQuestion,
  relayTurnStep,
} from '../../channels/turn-relay';
import { setProjectBotName } from '../../channels/voice-identity';
import { config } from '../../config';
import { upsertProfileCredential, upsertProfileOAuth2Credential } from '../../executor/credentials';
import { revokeProfileOAuth2 } from '../../executor/oauth2-store';
import {
  finalizePipedreamProfileConnection,
  pipedreamConfigured,
  pipedreamConnectUrl,
} from '../../executor/pipedream';
import { reconcileChannelConnectors } from '../../executor/sync';
import { resolveExperimentalFeature } from '../../experimental/features';
import { PROJECT_ACTIONS } from '../../iam';
import { setContextField } from '../../lib/request-context';
import { projectLlmGatewayEnabled } from '../../llm-gateway/enablement';
import { resolveEnablement } from '../../llm-gateway/model-enablement';
import { gatewayModelCatalog } from '../../llm-gateway/models/catalog-models';
import { projectPickerCatalog } from '../../llm-gateway/models/picker-catalog';
import { runtimeModelCatalog } from '../../llm-gateway/models/runtime-catalog';
import { platformDefaultModelId } from '../../llm-gateway/models/served-managed-models';
import {
  invalidateAccountModelDefaults,
  isModelServableForAccount,
  resolveEffectiveModel,
} from '../../llm-gateway/resolution/default-model';
import { toWireModel } from '../../llm-gateway/resolution/effective';
import { auth, errors, json } from '../../openapi';
import {
  deleteAccountModelPreference,
  getAccountModelDefaults,
  upsertAccountModelPreference,
} from '../../repositories/model-preferences';
import {
  getProjectRoutingPolicy,
  setProjectModelOverrides,
} from '../../repositories/project-routing-policies';
import { db } from '../../shared/db';
import { continueSession } from '../session-lifecycle';
import {
  getOpenQuestion,
  recordPendingQuestion,
  renderAnswerPrompt,
  resolvePendingQuestion,
} from '../lib/pending-questions';
import { loadProjectAgents } from '../agents';
import { getAgentGrant } from '../../iam/agent-scope';
import {
  assertProjectCapability,
  loadProjectForUser,
  projectCapabilityAllowed,
  loadVisibleSession,
} from '../lib/access';
import { AnyObject, TriggerSchema, projectsApp } from '../lib/app';
import { callerKortixSessionId } from '../lib/caller-session';
import {
  type ConnectorAuthorizationOwnerType,
  type ConnectorAuthorizationStrategy,
  connectorAuthorizationMatchesStrategy,
  isTrustedManagedChannelAuthorization,
} from '../lib/connector-authorization-strategy';
import { sessionMayEnumerateProfile } from '../lib/connector-profile-visibility';
import { withProjectGitAuth } from '../lib/git';
import { metadataMerge } from '../lib/metadata-merge';
import { sandboxTokenMayActOnSession } from '../lib/sandbox-token-session';
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
} from '../lib/triggers';
import { childIdleGraceMs, shortenSandboxDeadlineOnTurnEnd } from '../sandbox-deadline';
import { generateSessionTitleFromFirstPrompt } from '../session-title-generate';
import { listProjectSecretNamesForConsumer } from '../secrets';
import { reconcileProjectTriggerRuntime } from '../trigger-runtime-catalog';
import { type ParsedManifest, extractTriggers, loadProjectTriggers } from '../triggers';
import { turnStreamKindField } from './r4-turn-stream-kind';

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
  'session_key',
  'sessionKey',
  'filter',
] as const;

interface SlackAuthTest {
  ok: boolean;
  team_id?: string;
  team?: string;
  user_id?: string;
  error?: string;
}

// Keep the existing OpenAPI component id for generated-client compatibility.
const ConnectorAuthorizationViewSchema = ConnectorAuthorizationSchema.openapi('ConnectionProfile');

/**
 * The owner/admin roster shape is narrower than ConnectorAuthorization.
 * It answers "who has connected this connector, and does it still work?" and
 * nothing else. `label` and `metadata` are omitted on purpose: they are a
 * member's own annotations on a PRIVATE connection and can carry personal
 * identifiers (an email, an inbox id, a workspace id), which a peer manager has
 * no need to see. Credentials are never in any profile shape.
 */
const ConnectorAuthorizationRosterEntrySchema = z
  .object({
    profile_id: z.string().uuid(),
    connector_alias: z.string(),
    owner_type: z.enum(['project', 'agent', 'member', 'subject', 'external']),
    owner_id: z.string().nullable(),
    status: z.enum(['active', 'revoked', 'error']),
  })
  .openapi('ConnectionRosterEntry');

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

function mayReadConnectionProfile(
  profile: {
    profileId: string;
    ownerType: ConnectorAuthorizationOwnerType;
    ownerId: string | null;
    isDefault: boolean;
    metadata: Record<string, unknown>;
    authorizationStrategy: ConnectorAuthorizationStrategy;
    providerType: string;
    connectorConfig: Record<string, unknown>;
  },
  userId: string,
  actingPrincipalIsServiceAccount: boolean,
  /** Profile ids the CALLER'S session is bound to, or null when the caller is
   *  not session-bound. See connector-profile-visibility.ts: a sandbox's token
   *  carries the WRAPPER's user id, so without this every end-user's agent could
   *  enumerate every other end-user's connection and then bind it. */
  sessionBoundProfileIds: ReadonlySet<string> | null,
): boolean {
  if (!sessionMayEnumerateProfile(profile, sessionBoundProfileIds)) return false;
  return connectorAuthorizationMatchesStrategy({
    strategy: profile.authorizationStrategy,
    ownerType: profile.ownerType,
    ownerId: profile.ownerId,
    actingUserId: userId,
    actingPrincipalIsServiceAccount,
    trustedManagedSystem: isTrustedManagedChannelAuthorization({
      providerType: profile.providerType,
      platform:
        typeof profile.connectorConfig.platform === 'string'
          ? profile.connectorConfig.platform
          : null,
      ownerType: profile.ownerType,
      ownerId: profile.ownerId,
      metadata: profile.metadata,
    }),
  });
}

function mayMutateConnectionProfile(
  profile: {
    ownerType: ConnectorAuthorizationOwnerType;
    ownerId: string | null;
    metadata: Record<string, unknown>;
    authorizationStrategy: ConnectorAuthorizationStrategy;
    providerType: string;
    connectorConfig: Record<string, unknown>;
  },
  userId: string,
  actingPrincipalIsServiceAccount: boolean,
  mayManageSystemProfiles: boolean,
): boolean {
  const strategyMatches = connectorAuthorizationMatchesStrategy({
    strategy: profile.authorizationStrategy,
    ownerType: profile.ownerType,
    ownerId: profile.ownerId,
    actingUserId: userId,
    actingPrincipalIsServiceAccount,
    trustedManagedSystem: isTrustedManagedChannelAuthorization({
      providerType: profile.providerType,
      platform:
        typeof profile.connectorConfig.platform === 'string'
          ? profile.connectorConfig.platform
          : null,
      ownerType: profile.ownerType,
      ownerId: profile.ownerId,
      metadata: profile.metadata,
    }),
  });
  if (!strategyMatches) return false;
  return profile.authorizationStrategy === 'user' || mayManageSystemProfiles;
}

async function reconcileConnectionProfileRow(input: {
  accountId: string;
  projectId: string;
  connectorId: string;
  ownerType: 'project' | 'agent' | 'member' | 'subject' | 'external';
  /** null for a `project` (team-shared) connection — the CHECK constraint
   *  requires owner_id IS NULL there; every other owner type carries an id. */
  ownerId: string | null;
  label: string;
  metadata: Record<string, unknown>;
  createdBy: string;
}) {
  // Identity includes the LABEL: an owner may hold several connections on one
  // connector ("Work", "Personal"), so reconciling a NEW label adds a connection
  // while the same label stays idempotent (updates metadata in place). Matches
  // idx_executor_connection_profiles_owner.
  const identity = and(
    eq(executorConnectionProfiles.connectorId, input.connectorId),
    eq(executorConnectionProfiles.ownerType, input.ownerType),
    input.ownerId === null
      ? isNull(executorConnectionProfiles.ownerId)
      : eq(executorConnectionProfiles.ownerId, input.ownerId),
    eq(executorConnectionProfiles.label, input.label),
  );
  const [existing] = await db.select().from(executorConnectionProfiles).where(identity).limit(1);
  if (existing) {
    const [profile] = await db
      .update(executorConnectionProfiles)
      .set({ label: input.label, metadata: input.metadata, updatedAt: new Date() })
      .where(eq(executorConnectionProfiles.profileId, existing.profileId))
      .returning();
    return { profile, created: false };
  }
  const [inserted] = await db
    .insert(executorConnectionProfiles)
    .values({
      accountId: input.accountId,
      projectId: input.projectId,
      connectorId: input.connectorId,
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      label: input.label,
      metadata: input.metadata,
      createdBy: input.createdBy,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted) return { profile: inserted, created: true };
  const [raced] = await db.select().from(executorConnectionProfiles).where(identity).limit(1);
  return { profile: raced, created: false };
}

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/connector-profiles',
    tags: ['connectors'],
    summary: 'List connector authorizations',
    ...auth,
    request: { params: z.object({ projectId: z.string() }) },
    responses: {
      200: json(z.object({ profiles: z.array(ConnectorAuthorizationViewSchema) }), 'Profiles'),
      ...errors(403, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    const actingPrincipalIsServiceAccount = c.get('authType') === 'service_account';
    // A sandbox executor token is bound to ONE session. Load what that session was
    // actually GIVEN so the enumeration below can be narrowed to it. null for
    // every non-session caller, which leaves the operator's view unchanged.
    const callerSessionId = callerKortixSessionId(c);
    let sessionBoundProfileIds: ReadonlySet<string> | null = null;
    if (callerSessionId) {
      const bound = await db
        .select({ profileId: projectSessionConnectorBindings.profileId })
        .from(projectSessionConnectorBindings)
        .where(
          and(
            eq(projectSessionConnectorBindings.sessionId, callerSessionId),
            eq(projectSessionConnectorBindings.projectId, projectId),
          ),
        );
      sessionBoundProfileIds = new Set(bound.map((row) => row.profileId));
    }
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
        authorizationStrategy: executorConnectors.authorizationStrategy,
        providerType: executorConnectors.providerType,
        connectorConfig: executorConnectors.config,
      })
      .from(executorConnectionProfiles)
      .innerJoin(
        executorConnectors,
        eq(executorConnectors.connectorId, executorConnectionProfiles.connectorId),
      )
      .where(eq(executorConnectionProfiles.projectId, projectId));
    return c.json({
      profiles: rows
        .filter((profile) =>
          mayReadConnectionProfile(
            profile,
            loaded.userId,
            actingPrincipalIsServiceAccount,
            sessionBoundProfileIds,
          ),
        )
        .map(serializeConnectionProfile),
    });
  },
);

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/connector-profiles/all',
    tags: ['connectors'],
    summary: "List every member's connector authorization",
    ...auth,
    request: { params: z.object({ projectId: z.string() }) },
    responses: {
      200: json(
        z.object({ profiles: z.array(ConnectorAuthorizationRosterEntrySchema) }),
        'Authorization roster',
      ),
      ...errors(403, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    // A read-only roster of EVERY member's connection for this project: WHO has
    // connected which connector, and whether it still works. Manage-gated
    // (owner/manager), and deliberately NARROWER than the caller-scoped list —
    // it returns identity + status ONLY. `label` and `metadata` are excluded on
    // purpose: they are a member's own annotations on a PRIVATE connection and
    // can carry personal identifiers (an email, an inbox_id, a workspace id).
    // The plain list hides other members' profiles entirely, so this route is
    // the one place peer rows are visible — it must disclose the minimum that
    // answers "has this person connected?", nothing more.
    const mayManage = await projectCapabilityAllowed(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_CONNECTOR_PROFILES_MANAGE,
    );
    if (!mayManage) {
      return c.json(
        {
          error: 'You do not have permission to view all connector authorizations',
          code: 'FORBIDDEN',
        },
        403,
      );
    }
    const rows = await db
      .select({
        profileId: executorConnectionProfiles.profileId,
        connectorAlias: executorConnectors.slug,
        ownerType: executorConnectionProfiles.ownerType,
        ownerId: executorConnectionProfiles.ownerId,
        status: executorConnectionProfiles.status,
      })
      .from(executorConnectionProfiles)
      .innerJoin(
        executorConnectors,
        eq(executorConnectors.connectorId, executorConnectionProfiles.connectorId),
      )
      .where(eq(executorConnectionProfiles.projectId, projectId));
    return c.json({
      profiles: rows.map((row) => ({
        profile_id: row.profileId,
        connector_alias: row.connectorAlias,
        owner_type: row.ownerType,
        owner_id: row.ownerId,
        status: row.status,
      })),
    });
  },
);

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/connector-profiles/me',
    tags: ['connectors'],
    summary: "Create or reconcile the calling member's connector authorization",
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: {
        content: {
          'application/json': {
            schema: z
              .object({
                connector_alias: z.string().regex(/^[a-z][a-z0-9_-]{0,127}$/),
                label: z.string().trim().min(1).max(255),
                metadata: ConnectorAuthorizationMetadataSchema.optional(),
              })
              .strict(),
          },
        },
      },
    },
    responses: {
      200: json(ConnectorAuthorizationViewSchema, 'Reconciled authorization'),
      201: json(ConnectorAuthorizationViewSchema, 'Created authorization'),
      ...errors(400, 403, 404, 409),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    if (c.get('authType') === 'service_account') {
      return c.json(
        { error: 'Only human members can reconcile user connector authorizations' },
        403,
      );
    }
    const body = await readBody(c);
    const connectorAlias = canonicalConnectorAlias(
      typeof body.connector_alias === 'string' ? body.connector_alias.trim() : '',
    );
    const label = typeof body.label === 'string' ? body.label.trim() : '';
    const metadata =
      body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
        ? (body.metadata as Record<string, unknown>)
        : {};
    if (!connectorAlias || !label) {
      return c.json({ error: 'connector_alias and label are required' }, 400);
    }
    const [connector] = await db
      .select({
        connectorId: executorConnectors.connectorId,
        providerType: executorConnectors.providerType,
        authorizationStrategy: executorConnectors.authorizationStrategy,
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
    if (connector.authorizationStrategy !== 'user') {
      return c.json(
        {
          error: 'This connector uses project-owned authorizations',
          code: 'CONNECTOR_AUTHORIZATION_STRATEGY_MISMATCH',
        },
        409,
      );
    }
    const ownerType = 'member' as const;
    const ownerId = loaded.userId;
    const { profile, created } = await reconcileConnectionProfileRow({
      accountId: loaded.row.accountId,
      projectId,
      connectorId: connector.connectorId,
      ownerType,
      ownerId,
      label,
      metadata,
      createdBy: loaded.userId,
    });
    if (!profile) return c.json({ error: 'Profile could not be reconciled' }, 409);
    return c.json(serializeConnectionProfile({ ...profile, connectorAlias }), created ? 201 : 200);
  },
);

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/connector-profiles',
    tags: ['connectors'],
    summary: 'Create or reconcile a connector authorization',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: {
        content: {
          'application/json': { schema: ReconcileConnectorAuthorizationInputSchema },
        },
      },
    },
    responses: {
      200: json(ConnectorAuthorizationViewSchema, 'Reconciled authorization'),
      201: json(ConnectorAuthorizationViewSchema, 'Created authorization'),
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
    if (ownerType === 'member' && c.get('authType') === 'service_account') {
      return c.json(
        { error: 'Only human members can reconcile user connector authorizations' },
        403,
      );
    }
    // Backwards-compatible manager path: a submitted member owner is always
    // rewritten to the caller. Managers may create their own member profile,
    // but never mint one on behalf of (or later impersonate) another member.
    const ownerId =
      ownerType === 'member'
        ? loaded.userId
        : typeof body.owner_id === 'string'
          ? body.owner_id.trim()
          : '';
    const label = typeof body.label === 'string' ? body.label.trim() : '';
    const metadata =
      body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
        ? (body.metadata as Record<string, unknown>)
        : {};
    if (
      !connectorAlias ||
      !['project', 'agent', 'member', 'subject', 'external'].includes(ownerType)
    ) {
      return c.json({ error: 'connector_alias and a valid owner_type are required' }, 400);
    }
    // A `project` (team-shared) connection belongs to the whole project and takes
    // NO owner_id — several may exist per connector, distinguished by label.
    // Creating one is already gated: this route asserts the profiles-manage
    // capability above, so reaching here means the caller may administer them.
    if (ownerType === 'project') {
      if (!label) return c.json({ error: 'label is required' }, 400);
    } else if (!ownerId || !label) {
      return c.json({ error: 'owner_id and label are required' }, 400);
    }
    const [connector] = await db
      .select({
        connectorId: executorConnectors.connectorId,
        providerType: executorConnectors.providerType,
        authorizationStrategy: executorConnectors.authorizationStrategy,
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
    const normalizedOwnerId = ownerType === 'project' ? null : ownerId;
    if (
      !connectorAuthorizationMatchesStrategy({
        strategy: connector.authorizationStrategy,
        ownerType: ownerType as ConnectorAuthorizationOwnerType,
        ownerId: normalizedOwnerId,
        actingUserId: loaded.userId,
        actingPrincipalIsServiceAccount: c.get('authType') === 'service_account',
      })
    ) {
      return c.json(
        {
          error: `This connector uses ${connector.authorizationStrategy}-owned authorizations`,
          code: 'CONNECTOR_AUTHORIZATION_STRATEGY_MISMATCH',
        },
        409,
      );
    }
    const { profile, created } = await reconcileConnectionProfileRow({
      accountId: loaded.row.accountId,
      projectId,
      connectorId: connector.connectorId,
      ownerType: ownerType as 'project' | 'agent' | 'member' | 'subject' | 'external',
      ownerId: normalizedOwnerId,
      label,
      metadata,
      createdBy: loaded.userId,
    });
    if (!profile) return c.json({ error: 'Profile could not be reconciled' }, 409);
    const view = serializeConnectionProfile({ ...profile, connectorAlias });
    return c.json(view, created ? 201 : 200);
  },
);

for (const operation of ['credential', 'revoke', 'activate', 'default'] as const) {
  projectsApp.openapi(
    createRoute({
      method: 'put',
      path: `/{projectId}/connector-profiles/{profileId}/${operation}`,
      tags: ['connectors'],
      summary: `${operation} connector authorization`,
      ...auth,
      request: {
        params: z.object({ projectId: z.string(), profileId: z.string().uuid() }),
        body: {
          content: {
            'application/json': {
              schema:
                operation === 'credential'
                  ? UpdateConnectorAuthorizationCredentialInputSchema
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
      const actingPrincipalIsServiceAccount = c.get('authType') === 'service_account';
      const mayManageSystemProfiles = await projectCapabilityAllowed(
        c,
        loaded.userId,
        loaded.row.accountId,
        projectId,
        PROJECT_ACTIONS.PROJECT_CONNECTOR_PROFILES_MANAGE,
      );
      const [profile] = await db
        .select({
          connectorId: executorConnectionProfiles.connectorId,
          ownerType: executorConnectionProfiles.ownerType,
          ownerId: executorConnectionProfiles.ownerId,
          metadata: executorConnectionProfiles.metadata,
          authorizationStrategy: executorConnectors.authorizationStrategy,
          providerType: executorConnectors.providerType,
          connectorConfig: executorConnectors.config,
        })
        .from(executorConnectionProfiles)
        .innerJoin(
          executorConnectors,
          and(
            eq(executorConnectors.connectorId, executorConnectionProfiles.connectorId),
            eq(executorConnectors.accountId, executorConnectionProfiles.accountId),
            eq(executorConnectors.projectId, executorConnectionProfiles.projectId),
          ),
        )
        .where(
          and(
            eq(executorConnectionProfiles.profileId, profileId),
            eq(executorConnectionProfiles.projectId, projectId),
            eq(executorConnectionProfiles.accountId, loaded.row.accountId),
          ),
        )
        .limit(1);
      if (!profile) return c.json({ error: 'Not found' }, 404);
      if (
        !mayMutateConnectionProfile(
          profile,
          loaded.userId,
          actingPrincipalIsServiceAccount,
          mayManageSystemProfiles,
        )
      ) {
        return c.json({ error: 'Not found' }, 404);
      }
      if (operation === 'credential') {
        const body = await readBody(c);
        const parsed = UpdateConnectorAuthorizationCredentialInputSchema.safeParse(body);
        if (!parsed.success) {
          return c.json(
            {
              error:
                body?.oauth2 != null
                  ? (parsed.error.issues[0]?.message ?? 'invalid OAuth2 credential')
                  : 'value is required',
            },
            400,
          );
        }
        try {
          if ('oauth2' in parsed.data) {
            await upsertProfileOAuth2Credential({
              projectId,
              connectorId: profile.connectorId,
              profileId,
              oauth2: parsed.data.oauth2,
              createdBy: loaded.userId,
            });
          } else {
            await upsertProfileCredential({
              projectId,
              connectorId: profile.connectorId,
              profileId,
              value: parsed.data.value,
              kind: parsed.data.kind,
              createdBy: loaded.userId,
            });
          }
        } catch (error) {
          return c.json({ error: (error as Error).message || 'credential validation failed' }, 400);
        }
      } else if (operation === 'default') {
        // Make THIS the default connection for its owner scope. Defaults are
        // per-owner (one team default; one per member), and the partial unique
        // indexes enforce that — so clear the current default in the SAME scope
        // first, in one transaction, or the update would collide.
        await db.transaction(async (tx) => {
          const sameScope = and(
            eq(executorConnectionProfiles.connectorId, profile.connectorId),
            eq(executorConnectionProfiles.ownerType, profile.ownerType),
            profile.ownerId === null
              ? isNull(executorConnectionProfiles.ownerId)
              : eq(executorConnectionProfiles.ownerId, profile.ownerId),
          );
          await tx
            .update(executorConnectionProfiles)
            .set({ isDefault: false, updatedAt: new Date() })
            .where(and(sameScope, eq(executorConnectionProfiles.isDefault, true)));
          await tx
            .update(executorConnectionProfiles)
            .set({ isDefault: true, updatedAt: new Date() })
            .where(eq(executorConnectionProfiles.profileId, profileId));
        });
      } else {
        if (operation === 'revoke') await revokeProfileOAuth2(profileId);
        await db
          .update(executorConnectionProfiles)
          .set({ status: operation === 'revoke' ? 'revoked' : 'active', updatedAt: new Date() })
          .where(eq(executorConnectionProfiles.profileId, profileId));
      }
      return c.json({ ok: true });
    },
  );
}

for (const operation of ['connect', 'connect/finalize'] as const) {
  projectsApp.openapi(
    createRoute({
      method: 'post',
      path: `/{projectId}/connector-profiles/{profileId}/${operation}`,
      tags: ['connectors'],
      summary:
        operation === 'connect'
          ? 'Start Pipedream OAuth for a connector authorization'
          : 'Finalize Pipedream OAuth for a connector authorization',
      ...auth,
      request: {
        params: z.object({ projectId: z.string(), profileId: z.string().uuid() }),
        body: {
          content: {
            'application/json': {
              schema:
                operation === 'connect'
                  ? z
                      .object({
                        success_redirect_uri: z.string().optional(),
                        error_redirect_uri: z.string().optional(),
                      })
                      .strict()
                  : z.object({}).strict(),
            },
          },
        },
      },
      responses: {
        200: json(z.any(), 'Pipedream connection result'),
        ...errors(400, 403, 404, 409, 501),
      },
    }),
    async (c: any) => {
      const projectId = c.req.param('projectId');
      const profileId = c.req.param('profileId');
      const loaded = await loadProjectForUser(c, projectId, 'read');
      if (!loaded) return c.json({ error: 'Not found' }, 404);
      const actingPrincipalIsServiceAccount = c.get('authType') === 'service_account';
      const mayManageSystemProfiles = await projectCapabilityAllowed(
        c,
        loaded.userId,
        loaded.row.accountId,
        projectId,
        PROJECT_ACTIONS.PROJECT_CONNECTOR_PROFILES_MANAGE,
      );
      const [profile] = await db
        .select({
          connectorId: executorConnectionProfiles.connectorId,
          ownerType: executorConnectionProfiles.ownerType,
          ownerId: executorConnectionProfiles.ownerId,
          isDefault: executorConnectionProfiles.isDefault,
          metadata: executorConnectionProfiles.metadata,
          connectorAlias: executorConnectors.slug,
          providerType: executorConnectors.providerType,
          connectorConfig: executorConnectors.config,
          authorizationStrategy: executorConnectors.authorizationStrategy,
        })
        .from(executorConnectionProfiles)
        .innerJoin(
          executorConnectors,
          and(
            eq(executorConnectors.connectorId, executorConnectionProfiles.connectorId),
            eq(executorConnectors.accountId, executorConnectionProfiles.accountId),
            eq(executorConnectors.projectId, executorConnectionProfiles.projectId),
          ),
        )
        .where(
          and(
            eq(executorConnectionProfiles.profileId, profileId),
            eq(executorConnectionProfiles.projectId, projectId),
            eq(executorConnectionProfiles.accountId, loaded.row.accountId),
          ),
        )
        .limit(1);
      if (
        !profile ||
        !mayMutateConnectionProfile(
          profile,
          loaded.userId,
          actingPrincipalIsServiceAccount,
          mayManageSystemProfiles,
        )
      ) {
        return c.json({ error: 'Not found' }, 404);
      }
      if (profile.isDefault) {
        return c.json(
          { error: 'Use the shared connector connect endpoint for the default profile' },
          409,
        );
      }
      if (!pipedreamConfigured()) {
        return c.json({ error: 'pipedream not configured' }, 501);
      }
      const app = (profile.connectorConfig as Record<string, unknown> | null)?.app;
      if (profile.providerType !== 'pipedream' || typeof app !== 'string' || !app) {
        return c.json({ error: 'not a pipedream connector' }, 404);
      }
      if (operation === 'connect') {
        const body = await readBody(c);
        const redirects =
          body.success_redirect_uri || body.error_redirect_uri
            ? {
                success:
                  typeof body.success_redirect_uri === 'string'
                    ? body.success_redirect_uri
                    : undefined,
                error:
                  typeof body.error_redirect_uri === 'string' ? body.error_redirect_uri : undefined,
              }
            : undefined;
        const result = await pipedreamConnectUrl(
          projectId,
          profile.connectorAlias,
          app,
          profileId,
          redirects,
        );
        return c.json({
          token: result.token,
          app,
          connectUrl: result.connectUrl,
          expiresAt: result.expiresAt,
        });
      }
      const result = await finalizePipedreamProfileConnection({
        projectId,
        slug: profile.connectorAlias,
        app,
        connectorId: profile.connectorId,
        profileId,
        createdBy: loaded.userId,
      });
      return c.json(result);
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
      ...errors(400, 404, 409, 502),
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
      return c.json({ error: result.error }, result.status as 400 | 409 | 502);
    }
    await reconcileProjectTriggerRuntime(projectId, extractTriggers(next).specs);

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
    // FIX-J: SQL-side atomic merge of ONLY `triggers_paused` (set true / delete)
    // so this kill-switch write can't revert a routing pin written concurrently.
    const [row] = await db
      .update(projects)
      .set({
        metadata: paused
          ? metadataMerge({ triggers_paused: true })
          : metadataMerge({}, ['triggers_paused']),
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
      ...errors(400, 404, 409, 502),
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
      const base = specToBody(current);
      // Setting a `session_key` is itself the opt-in to keyed sessions (see
      // parseTriggerDraft). The merge base always carries an explicit
      // `session_mode`, which would outvote a caller that sent ONLY a key — so
      // drop it and let the key decide. An explicit mode in the patch still wins.
      const patchesKey = 'session_key' in body || 'sessionKey' in body;
      const patchesMode = 'session_mode' in body || 'sessionMode' in body;
      if (patchesKey && !patchesMode) delete base.session_mode;
      const draft = parseTriggerDraft({ ...base, ...body, slug: slug }, { existingSlug: slug });
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
        return c.json({ error: result.error }, result.status as 400 | 409 | 502);
      }
      await reconcileProjectTriggerRuntime(projectId, extractTriggers(next).specs);
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
      ...errors(400, 404, 409, 502),
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
      return c.json({ error: result.error }, result.status as 400 | 409 | 502);
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
    const enabled = teamsChannelEnabled(loaded.row.metadata);
    return c.json({
      ...teamsMode(baseUrl, { enabled, projectId, byoAppId }),
      orgConsentUrl: byoAppId ? null : teamsOrgConsentUrl({ projectId, baseUrl, enabled }),
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
    const mode = teamsMode(baseUrl, {
      enabled: teamsChannelEnabled(loaded.row.metadata),
      projectId,
      byoAppId,
    });
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
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'manage');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    // Connecting a Teams bot is a connector-write capability — a custom role can
    // withhold it and a scoped agent must hold it (central fold), mirroring the
    // Slack (r4 slack/connect) and email connect twins.
    // Authz before the feature-flag check so an unauthorized caller never gets a
    // capability-independent answer (same order as the file-upload twin below).
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE,
    );
    if (!teamsChannelEnabled(loaded.row.metadata)) return c.json({ error: 'Not found' }, 404);

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
    // Disconnecting the Teams bot is connector-write — twin of the Slack/email
    // disconnect gates; a custom role can withhold it, a scoped agent must hold it.
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE,
    );
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
    // Posting a consent card drives the project bot to SEND into the customer's
    // Teams channel — a send primitive gated on connector-write like the Slack
    // (r4 slack/file/upload) and meet/speak twins. Authz before the feature-flag
    // check so an unauthorized caller never gets a capability-independent answer.
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE,
    );
    if (!teamsChannelEnabled(loaded.row.metadata)) return c.json({ error: 'Not found' }, 404);
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
      agent_name?: string | null;
      agentName?: string | null;
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
    const requestedAgent = body.agent_name ?? body.agentName;
    const agentName =
      typeof requestedAgent === 'string' && requestedAgent.trim() ? requestedAgent.trim() : null;
    if (requestedAgent !== undefined && requestedAgent !== null && !agentName) {
      return c.json({ error: 'agent_name cannot be blank', code: 'invalid_agent' }, 400);
    }
    if (agentName) {
      const loadedAgents = await loadProjectAgents(loaded.row, {
        forceRefresh: true,
        rethrowReadErrors: true,
      });
      if (!loadedAgents.specs.some((agent) => agent.enabled && agent.name === agentName)) {
        return c.json(
          {
            error: `Agent "${agentName}" is not declared or is disabled`,
            code: 'invalid_agent',
          },
          400,
        );
      }
    }
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
    const clientIds = agentMailProvisioningClientIds(projectId, connectorSlug);

    let inbox: Awaited<ReturnType<typeof createAgentMailInbox>>;
    if (existingInboxId && existingEmail) {
      // Ownership gate (pentest 2026-07-27): before claiming an existing
      // AgentMail inbox, confirm no OTHER project already owns it. Without this,
      // a caller with connector.write on their own project could supply a
      // victim's inbox_id and hijack inbound mail resolution. The scoped delete
      // in saveAgentMailInstall is defense-in-depth; this 409 is the front gate.
      const owners = await listProjectsForWorkspace('email', existingInboxId);
      const foreignOwner = owners.find((id) => id !== projectId);
      if (foreignOwner) {
        return c.json({ error: 'AgentMail inbox is already connected to another project' }, 409);
      }
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
          clientId: clientIds.inbox,
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
        clientId: clientIds.webhook,
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
      agentName,
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

function parseSenderPolicyBody(
  input: Partial<AgentMailSenderPolicy> | undefined,
): AgentMailSenderPolicy {
  const policy = normalizeSenderPolicy(input);
  if (policy.allowedRegex) compileEmailSenderRegex(policy.allowedRegex);
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
        description: 'Relay result',
        content: { 'application/json': { schema: z.any() } },
      },
      ...errors(400, 403, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
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
    };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    setContextField('kind', turnStreamKindField(body.kind));
    const sessionId = body.session_id?.trim();
    if (!sessionId) {
      return c.json({ error: 'session_id is required' }, 400);
    }

    // Two valid callers: a project/session-scoped PAT (dashboard, operator, or
    // in-sandbox agent CLI) and the session sandbox's own service credential.
    // Each is scoped back to this projectId before a turn event is accepted.
    const authType = (c as any).get('authType') as string | undefined;
    const apiKeyType = (c as any).get('apiKeyType') as string | undefined;
    let authenticatedSandboxId: string | null = null;
    if (authType === 'apiKey' && apiKeyType === 'sandbox') {
      const accountId = (c as any).get('accountId') as string | undefined;
      const sandboxId = (c as any).get('sandboxId') as string | undefined;
      if (!accountId || !sandboxId) {
        return c.json({ error: 'turn-stream requires a sandbox token' }, 403);
      }
      // Sandbox images baked before 2026-07-29 still POST the retired
      // `execution_heartbeat` / `execution_lease_*` kinds here. They fall
      // through to the generic relay below and get a harmless `{ ok: false }`;
      // the in-sandbox reporter treated every non-2xx as best-effort anyway.
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
      .select({
        sessionId: projectSessions.sessionId,
        accountId: projectSessions.accountId,
        createdBy: projectSessions.createdBy,
        metadata: projectSessions.metadata,
      })
      .from(projectSessions)
      .where(
        and(eq(projectSessions.sessionId, sessionId), eq(projectSessions.projectId, projectId)),
      )
      .limit(1);
    if (!turnStreamSession) {
      return c.json({ error: 'Not found' }, 404);
    }
    const turnStreamMetadata = (turnStreamSession.metadata ?? {}) as Record<string, unknown>;
    // Coordinator-spawned worker: its idle tail is minutes, not the default
    // grace — the box wakes on demand when the coordinator returns to it.
    const childSession = typeof turnStreamMetadata.spawned_by_session === 'string';

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
      // SANDBOX-REPORTED turn end. `shortenSandboxDeadline` is LEAST-only, so
      // it is structurally incapable of EXTENDING the box's life — which is
      // exactly why it is safe to trust a payload the sandbox authored, and
      // why it needs no auth gate of its own. This is the "die 15 minutes
      // after the last turn ended" half of the model.
      //
      // But ONLY for a turn that genuinely ended. `session.error` also fires
      // while opencode is RETRYING (a 429 backoff, a transient upstream 5xx),
      // and pulling the deadline in to 15 minutes there killed the box mid-turn
      // on any backoff longer than that — the exact state the deleted execution
      // lease treated correctly, because it renewed on 'busy' OR 'retry'. The
      // classifier lives with the write (shortenSandboxDeadlineOnTurnEnd) so it
      // cannot be re-wired here without it.
      void shortenSandboxDeadlineOnTurnEnd(
        sessionId,
        status,
        errorInfo,
        childSession ? childIdleGraceMs() : undefined,
      ).catch((err) =>
        console.warn(
          `[deadline] shorten failed for session ${sessionId}:`,
          err instanceof Error ? err.message : err,
        ),
      );
      // Second-chance auto-title: create-time generation is a single in-memory
      // best-effort call, and a session whose only prompt was baked in-guest
      // (`KORTIX_INITIAL_PROMPT`) never crosses a titling hook again. Turn end
      // is the natural retry point — the generator is idempotent (needsTitle +
      // CAS) so an already-titled session is a cheap no-op. The stored
      // `title_source` outranks the supplied text inside the generator.
      const titleRetrySource = [turnStreamMetadata.title_source, turnStreamMetadata.initial_prompt]
        .find((v): v is string => typeof v === 'string' && v.trim().length > 0);
      if (titleRetrySource && turnStreamSession.createdBy) {
        void generateSessionTitleFromFirstPrompt({
          projectId,
          sessionId,
          accountId: turnStreamSession.accountId,
          userId: turnStreamSession.createdBy,
          firstPromptText: titleRetrySource,
        }).catch((err) =>
          console.warn(
            `[title-generate] turn-end retry failed for session ${sessionId}:`,
            err instanceof Error ? err.message : err,
          ),
        );
      }
      const ok = await relayTurnEnd(sessionId, status, errorInfo);
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
      // Binding a Slack thread creates channel→session routing (inbound Slack
      // messages drive this session) — a connector-write action, matching the
      // Slack connect/disconnect/file-upload twins. Threads the acting token so
      // a custom role that withholds connector.write, or a scoped agent lacking
      // it, is denied. The sandbox-token branch above is already project-scoped.
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
      listProjectSecretNamesForConsumer({
        projectId,
        principalUserId: loaded.userId,
        consumer: 'llm_gateway',
      }).catch(() => [] as string[]),
      getAccountModelDefaults(accountId, projectId),
      getProjectRoutingPolicy(projectId),
    ]);
    // What `auto` resolves to for this project. Served below so the client can
    // LOCK its switch instead of offering a toggle that always 409s.
    const effectiveDefault = toWireModel(
      defaults.projects[projectId] ?? defaults.account ?? platformDefaultModelId() ?? '',
    );
    const requiredModels = [
      defaults.projects[projectId],
      defaults.account,
      platformDefaultModelId(),
      routing?.visionModel,
      ...(routing?.defaultFallback?.models ?? []),
      ...(routing?.rules.flatMap((rule) => [rule.model, ...rule.fallbackModels]) ?? []),
    ].filter((model): model is string => !!model);
    const models = projectPickerCatalog(
      gatewayModelCatalog(projectId, { freeManagedOnly }),
      new Set(secrets),
      requiredModels,
    );
    // Server-owned per-project enablement, resolved HERE and stamped onto each
    // model so every client renders the same answer. The session picker shows
    // the enabled ones; "Manage models" shows them all and switches on this
    // flag. Neither re-derives it. Display-only: the gateway never refuses a
    // request over enablement (that 400'd in-use models — the #5932 revert).
    const enabled = resolveEnablement(models, routing?.modelOverrides ?? {}, requiredModels);
    return c.json({
      models: Object.fromEntries(
        Object.entries(models).map(([id, model]) => [
          id,
          { ...model, enabled: enabled.get(id) ?? true },
        ]),
      ),
      // The stored EXCEPTIONS, so a client toggling one model can PUT the
      // merged map back without having to reconstruct it by diffing the
      // resolved flags against a default it would have to recompute.
      modelOverrides: routing?.modelOverrides ?? {},
      // The model `auto` resolves to. It cannot be turned off (that would break
      // every default request — the PUT refuses it with 409), so the client
      // renders its switch as locked rather than letting the user click into an
      // error.
      defaultModel: effectiveDefault || undefined,
      // True while the project has made no exceptions at all — the only thing
      // "reset to defaults" has left to act on, and not derivable from the
      // `enabled` flags alone (they look identical either way).
      usingDefaults: Object.keys(routing?.modelOverrides ?? {}).length === 0,
    });
  },
);

// PUT /v1/projects/:projectId/model-enablement  { modelOverrides: {id: boolean} }
// Replace the project's EXCEPTIONS to the default model set (the newest model
// per family). Display-only: it decides what the pickers OFFER, never what the
// gateway serves. An empty object restores the pure default. Refuses to turn
// off the project's own default model (the picker would hide what `auto`
// resolves to).
const modelEnablementBody = z.object({
  modelOverrides: z.record(z.string().min(1).max(128), z.boolean()),
});

projectsApp.openapi(
  createRoute({
    method: 'put',
    path: '/{projectId}/model-enablement',
    tags: ['projects'],
    summary: 'PUT /:projectId/model-enablement',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: { content: { 'application/json': { schema: modelEnablementBody } } },
    },
    responses: {
      200: { description: 'OK', content: { 'application/json': { schema: z.any() } } },
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
      PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE,
    );
    const accountId = loaded.row.accountId as string;
    const userId = c.get('userId') as string;

    const parsed = modelEnablementBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: 'Invalid body', code: 'invalid_body' }, 400);
    }
    const modelOverrides: Record<string, boolean> = {};
    for (const [model, enabled] of Object.entries(parsed.data.modelOverrides)) {
      const wire = toWireModel(model.trim());
      if (wire) modelOverrides[wire] = enabled;
    }

    // A project must never turn off the model its own `auto` resolves to. Only
    // an explicit `false` can do that — omitting it leaves the default in
    // charge, which always offers the current one.
    const defaults = await getAccountModelDefaults(accountId, projectId);
    const effectiveDefault =
      defaults.projects[projectId] ?? defaults.account ?? platformDefaultModelId();
    if (effectiveDefault && modelOverrides[toWireModel(effectiveDefault)] === false) {
      return c.json(
        {
          error: 'Cannot disable the project default model — change the default first.',
          code: 'cannot_disable_default',
        },
        409,
      );
    }

    await setProjectModelOverrides({ projectId, updatedBy: userId, modelOverrides });
    return c.json({ ok: true, modelOverrides });
  },
);

// GET /v1/projects/:projectId/llm-catalog/providers
// The PROVIDER-level rows the connect modal needs (id, name, auth-relevant
// env vars, docs URL) — /llm-catalog above only ever serialized MODEL-level
// entries (Record<"provider/model", GatewayModel>), so the web connect modal
// (apps/web/src/lib/llm-providers.ts) fell back to piggybacking on
// @kortix/llm-catalog's BAKED catalog.generated.json snapshot as its only
// source, which nothing in CI refreshes (models.dev moves; this doesn't).
// This route serves the SAME live, 24h-refreshed, atomic-last-known-good
// runtimeModelCatalog every other gateway/model endpoint already reads —
// literally the `Catalog` shape @kortix/llm-catalog exports, so the web
// client can feed it through the exact same toEntry()/order() it already
// has, no reshaping.
//
// Deliberately NOT gated by projectLlmGatewayEnabled unlike /llm-catalog and
// /model-picker above: the BYOK provider connect modal (which env vars to
// collect, which providers show "connected") is meaningful for EVERY
// project, including native (non-gateway) ones — that's the majority of
// projects and exactly the surface the connect modal serves. Non-secret
// model metadata; scoped to project auth only for consistency with the
// other catalog routes, not because it needs to be secret.
projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/llm-catalog/providers',
    tags: ['projects'],
    summary: 'GET /:projectId/llm-catalog/providers',
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
    return c.json(runtimeModelCatalog.snapshot());
  },
);

// ─── Default model preferences (account-scoped) ─────────────────────────────
// The gateway is the source of truth for concrete model defaults. These routes
// manage account, project, and agent defaults. Stored values are gateway wire
// models (bare managed id, BYOK `provider/model`, or `codex/…`).

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
    const defaults = await getAccountModelDefaults(ownerAccountId, projectId);
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
      platformDefault: platformDefaultModelId(),
      accountDefault: defaults.account,
      agentDefaults: defaults.agents,
      projectDefault: defaults.projects[projectId] ?? null,
      resolvedForCaller: resolved.model ?? (freeTier ? null : platformDefaultModelId()),
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
    // Floor 'read'; project.customize.write is the real gate.
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
      // agent-scope pins are project-scoped — see repositories/model-preferences.ts.
      projectId: scope === 'agent' ? projectId : undefined,
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
    // Floor 'read'; project.customize.write is the real gate.
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
    await deleteAccountModelPreference({
      accountId: ownerAccountId,
      scope,
      scopeKey,
      projectId: scope === 'agent' ? projectId : undefined,
    });
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

    // The session this credential is BOUND to, when it is a sandbox token.
    // Null for a human caller.
    let callerSandboxSessionId: string | null = null;

    const authType = (c as any).get('authType') as string | undefined;
    if (authType === 'apiKey' && (c as any).get('apiKeyType') === 'sandbox') {
      const accountId = (c as any).get('accountId') as string | undefined;
      const sandboxId = (c as any).get('sandboxId') as string | undefined;
      if (!accountId || !sandboxId) {
        return c.json({ error: 'turn-question requires a sandbox token' }, 403);
      }
      const [sandbox] = await db
        .select({
          sandboxId: sessionSandboxes.sandboxId,
          sessionId: sessionSandboxes.sessionId,
        })
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
      callerSandboxSessionId = sandbox.sessionId ?? sandbox.sandboxId;
    } else {
      // A question card finalizes and re-posts a LIVE turn, so it is a
      // mutation of that session — 'read' is too weak. The sibling turn-stream
      // route already requires more than read for the same reason.
      const loaded = await loadProjectForUser(c, projectId, 'session');
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

    // session_id is caller-supplied. Scoping it to :projectId closes the
    // cross-TENANT hole, but a sandbox token acts for exactly ONE session, so
    // project scope still let sandbox A finalize and repost session B's live
    // turn. sandbox_id == session_id by construction — bind to it.
    if (
      callerSandboxSessionId !== null &&
      !sandboxTokenMayActOnSession(callerSandboxSessionId, sessionId)
    ) {
      return c.json({ error: 'sandbox token is not scoped to this session' }, 403);
    }

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

    // PERSIST FIRST, and independently of any channel.
    //
    // A waiting turn makes no gateway LLM calls, earns no deadline extension,
    // and its box is parked on schedule — correct, and the bounded-lifetime
    // invariant depends on it. What parking used to destroy is the question
    // itself: opencode restarts cold, so the user returned to a session that had
    // forgotten what it asked. Storing it out here lets the box die on time and
    // the conversation survive it. See lib/pending-questions.ts.
    //
    // Deliberately does NOT touch the deadline. A box that could keep itself
    // alive by reporting "still waiting" is the self-renewal this design
    // deleted.
    const resolvedAccountId = (c as any).get('accountId') as string | undefined;
    if (resolvedAccountId) {
      await recordPendingQuestion({
        accountId: resolvedAccountId,
        projectId,
        sessionId,
        requestId: body.request_id?.trim() || `q-${sessionId}`,
        opencodeSessionId: (body as { opencode_session_id?: string }).opencode_session_id ?? null,
        questions,
      }).catch((err) => {
        // Never fail the relay on a bookkeeping error — the agent is blocked and
        // the channel render is still worth attempting.
        console.warn('[turn-question] could not persist pending question:', err);
        return null;
      });
    }

    // Non-blocking: post the question(s) into the thread and return immediately
    // with sentinel `answers`. The agent does NOT wait for an inline answer — the
    // user's in-thread reply arrives as a follow-up turn. Returning `answers` keeps
    // BOTH the new sandbox (ignores them, uses its own sentinel) and an old sandbox
    // image (resumes opencode from them) unblocked.
    //
    // A session with no channel has nothing to post to. That is not an error now
    // that the question is durable: it is the ordinary web case, and failing here
    // would make the relay look broken for every non-Slack session.
    const result = await relayTurnQuestion(sessionId, questions);
    if (!result.ok) {
      return c.json({ ok: true, persisted: true, answers: [], channel_error: result.error });
    }
    return c.json({ ok: true, persisted: true, answers: result.answers });
  },
);

// GET  /v1/projects/:projectId/sessions/:sessionId/question
// POST /v1/projects/:projectId/sessions/:sessionId/question
//
// The restore half of park-and-restore. The ask survives its sandbox (see
// lib/pending-questions.ts); these two close the loop.
//
// GET returns the open question so a resumed session can render what it is
// waiting on, instead of showing a conversation that mysteriously stopped.
//
// POST answers it. The answer CANNOT go back to the call that blocked — that
// opencode process was parked and restarted cold, so its request id no longer
// exists and nothing is waiting on it. It is delivered as a FOLLOW-UP TURN,
// which is exactly how the channel path has always worked ("the user's
// in-thread reply arrives as a follow-up turn", above), and continueSession
// already owns waking a parked box and queueing until it is ready.

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/sessions/{sessionId}/question',
    tags: ['sessions'],
    summary: 'GET /:projectId/sessions/:sessionId/question',
    ...auth,
    request: { params: z.object({ projectId: z.string(), sessionId: z.string() }) },
    responses: { 200: json(AnyObject, 'Open question, or null'), ...errors(404) },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const sessionId = c.req.param('sessionId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    // The question text is session CONTENT, so it sits behind the same leaf the
    // other session-content reads use (r7.ts). `loadProjectForUser(…, 'read')`
    // is only the coarse project floor: a caller whose custom role or scoped
    // token has `project.session.read` revoked still clears it.
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_SESSION_READ,
    );
    const visible = await loadVisibleSession(loaded, sessionId, c.get('sessionId') ?? null);
    if (!visible) return c.json({ error: 'Not found' }, 404);
    return c.json({ question: await getOpenQuestion(sessionId) });
  },
);

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/sessions/{sessionId}/question',
    tags: ['sessions'],
    summary: 'POST /:projectId/sessions/:sessionId/question',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), sessionId: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: { 200: json(AnyObject, 'Answer delivered'), ...errors(400, 404, 409) },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const sessionId = c.req.param('sessionId');
    // The `question` tool exists so the agent YIELDS TO A HUMAN. An
    // agent-session token is scoped to its own session, which is precisely the
    // session holding the question it just asked — so if it could POST here it
    // would answer itself and resume, and the tool would be decorative.
    //
    // Denied outright rather than scope-gated: `assertAgentScope(…
    // PROJECT_SESSION_START)` is the usual bar for starting a turn, but that
    // leaf ships in the default agent preset (accounts/iam/role-presets.ts), so
    // it would admit the self-answer on a stock grant. Answering is a human
    // operation. Same shape as the token-minting guard in r3.ts.
    if (getAgentGrant(c)) {
      return c.json({ error: 'Agent-session tokens cannot answer their own question' }, 403);
    }
    // Answering resumes a parked box and starts a turn, so this is a mutation
    // of the session — the same bar the question relay itself uses.
    const loaded = await loadProjectForUser(c, projectId, 'session');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    const visible = await loadVisibleSession(loaded, sessionId, c.get('sessionId') ?? null);
    if (!visible) return c.json({ error: 'Not found' }, 404);

    const body = await readBody(c);
    const answers = (body as { answers?: unknown }).answers;
    if (!Array.isArray(answers) || answers.length === 0) {
      return c.json({ error: 'answers must be a non-empty array' }, 400);
    }

    const open = await getOpenQuestion(sessionId);
    if (!open) return c.json({ error: 'no open question for this session' }, 409);

    const requestId = (body as { request_id?: string }).request_id?.trim() || open.request_id;
    // CAS: closing the question is what claims the right to deliver it. Two
    // clients answering at once must produce ONE follow-up turn, not two.
    const claimed = await resolvePendingQuestion({ sessionId, requestId, answers });
    if (!claimed) {
      return c.json({ error: 'question was already answered', code: 'ALREADY_ANSWERED' }, 409);
    }

    const outcome = await continueSession({
      source: 'ui',
      sessionId,
      text: renderAnswerPrompt(open.questions, answers),
      userId: loaded.userId,
    });

    // 'pending' is success: the box is parked and continueSession has queued the
    // turn for when it is back. Reporting that as failure would invite a retry
    // that the CAS above would refuse, stranding the answer.
    return c.json({ ok: outcome === 'delivered' || outcome === 'pending', delivery: outcome });
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
