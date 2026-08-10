import { parseSharingIntent } from '../../connectors/share';
import { PROJECT_ACTIONS } from '../../iam';
import { agentMayUseEnv, getAgentGrant } from '../../iam/agent-scope';
import { auth, errors, json } from '../../openapi';
import { createAccountToken, listAccountTokens, revokeAccountToken } from '../../repositories/account-tokens';
import { inferAuditSource, recordAuditEvent, runAuditedTransaction } from '../../shared/audit';
import { db } from '../../shared/db';
import { kickRoutedPreBuild, templateBuildProviders } from '../../snapshots/builder';
import { getTemplateById } from '../../snapshots/templates';
import { roleAllows } from '../access';
import { loadProjectConfig } from '../git';
import { parseBasicAuthHeader } from '../git-backends';
import { pollCodexDeviceAuth, startCodexDeviceAuth } from '../codex-device-auth';
import { decryptProjectSecret, encryptProjectSecret, identifierKeyConflicts, isValidIdentifier, isValidSecretName, resolveProjectSecretForConsumer } from '../secrets';
import {
  propagateProjectSecretsToActiveSandboxes,
  type ProjectSecretPropagationResult,
} from '../lib/sandbox-env-sync';
import { isGatewayManagedEnv } from '../../llm-gateway/sandbox-credentials';
import { seedProjectDefaultModelOnConnect } from '../../llm-gateway/models/seed-default';
import { createRoute, z } from '@hono/zod-openapi';
import {
  SecretConsumerSchema,
  SecretSchema as ContractSecretSchema,
  UpdateSecretStrategyInputSchema,
} from '@kortix/api-contract';
import { parseEgressPolicy } from '../../secrets/strategy';
import {
  findBoundaryDestinationConflict,
  networkBoundaryPolicyError,
  type BoundaryDestinationConflict,
} from '../../secrets/network-boundary';
import { networkBoundaryDeliveryAvailable } from '../../secrets/network-boundary-availability';
import {
  connectors,
  projectSecrets,
  projectSessionSecretHandles,
  projects,
  sessionSandboxes,
  type SecretEgressPolicy,
} from '@kortix/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  assertAgentSessionWorkspaceAllowsRepository,
  loadProjectForUser,
  assertProjectCapability,
} from '../lib/access';
import { AnyObject, SecretSchema, projectsApp } from '../lib/app';
import { getProjectGitConnection, getProjectGitRemote, hasServerManagedGitAuth, loadGitProject, resolveProjectGitAuth, resolveProjectUpstream, upsertProjectGitConnection, upsertProjectGitCredential, withProjectGitAuth } from '../lib/git';
import { CODEX_AUTH_JSON_SECRET_NAME, isSystemProjectSecretName, loadSecretViewsForUser, normalizeString, readBody, serializeProjectGitConnection, type SecretAgentGrantConfig } from '../lib/serializers';
import { sessionWorkspaceAllowsRepositoryAccess } from '../lib/session-workspace-access';

type ProjectSecretConsumer = z.infer<typeof SecretConsumerSchema>;

// ─── Secret write responses ─────────────────────────────────────────────────
// A secret write may also have to reach every LIVE sandbox in the project. The
// two write routes that can move a network-boundary credential report what that
// fan-out actually did, because a save that stored fine and delivered nowhere
// otherwise looks identical to a save that worked. `delivery_sync` is null when
// no fan-out ran. It is NOT part of `SecretSchema` — a secret READ has no sync
// to report.

const SecretDeliverySyncSchema = z
  .object({
    ok: z.boolean(),
    targeted: z.number(),
    synced: z.number(),
    failed: z.number(),
    failures: z.array(
      z.object({
        session_id: z.string(),
        sandbox_id: z.string().nullable(),
        reason: z.string(),
      }),
    ),
  })
  .nullable()
  .optional();

type SecretDeliverySync = NonNullable<z.infer<typeof SecretDeliverySyncSchema>>;

const SecretWriteResultSchema = ContractSecretSchema.extend({
  delivery_sync: SecretDeliverySyncSchema,
}).openapi('SecretWriteResult');

/** Keep the per-sandbox reasons; drop the rows that succeeded. */
function summarizeDeliverySync(result: ProjectSecretPropagationResult): SecretDeliverySync {
  return {
    ok: result.ok,
    targeted: result.targeted,
    synced: result.synced,
    failed: result.failed,
    failures: result.results
      .filter((target) => target.status === 'failed')
      .map((target) => ({
        session_id: target.session_id,
        sandbox_id: target.sandbox_id,
        reason: target.reason ?? 'sandbox sync failed',
      })),
  };
}

/**
 * The other network-boundary secret in this project that already claims one of
 * the candidate's (host, header) destinations, or null.
 *
 * The provider edge maps one destination to one credential. A second claim is
 * refused at session provision, so the stored pair takes down every NEW session
 * in the project with an error the author cannot connect to their edit. Both
 * write routes call this BEFORE the row lands.
 */
async function boundaryDestinationConflict(
  projectId: string,
  identifier: string,
  policy: SecretEgressPolicy,
): Promise<BoundaryDestinationConflict | null> {
  const rows = await db
    .select({ identifier: projectSecrets.identifier, egressPolicy: projectSecrets.egressPolicy })
    .from(projectSecrets)
    .where(
      and(
        eq(projectSecrets.projectId, projectId),
        eq(projectSecrets.strategy, 'egress'),
        isNull(projectSecrets.ownerUserId),
      ),
    );
  return findBoundaryDestinationConflict(
    { identifier, policy },
    rows.map((other) => ({ identifier: other.identifier, policy: other.egressPolicy })),
  );
}

function boundaryConflictBody(identifier: string, conflict: BoundaryDestinationConflict) {
  return {
    error:
      `${conflict.identifier} already injects the "${conflict.header}" header for ${conflict.host}. ` +
      `Two secrets cannot target the same host and header — give ${identifier} a different header, ` +
      'or a different host.',
    code: 'secret_boundary_destination_conflict',
    conflict,
  };
}

async function connectorSecretBindings(projectId: string, identifier: string): Promise<string[]> {
  const rows = await db
    .select({ slug: connectors.slug })
    .from(connectors)
    .where(
      and(
        eq(connectors.projectId, projectId),
        eq(connectors.authSecret, identifier),
      ),
    );
  return rows.map((row) => row.slug).sort();
}

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/sandbox-templates/{templateId}/build',
    tags: ['sandboxes'],
    summary: 'POST /:projectId/sandbox-templates/:templateId/build',
    ...auth,
      request: {
        params: z.object({ projectId: z.string(), templateId: z.string() }),
      },
    responses: {
        202: json(z.any(), 'OK'),
        ...errors(404, 503),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const templateId = c.req.param('templateId');
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  // Capability gate: building a sandbox template provisions infra. Gated on
  // project.customize.write so a custom role can withhold it (humans) AND the
  // agent-grant fold applies (agent sessions). Editors hold it by default.
  await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE);

  const row = await getTemplateById(templateId);
  if (!row) return c.json({ error: 'Not found' }, 404);
  if (row.projectId !== null && row.projectId !== projectId) {
    return c.json({ error: 'Not found' }, 404);
  }

  const project = await loadGitProject(loaded);
  const providers = templateBuildProviders();
  if (providers.length === 0) {
    return c.json({ error: 'No sandbox template provider is enabled' }, 503);
  }
  kickRoutedPreBuild(project, {
    slug: row.slug,
    accountId: loaded.row.accountId,
    source: 'manual',
  });
  return c.json({
    status: 'started',
    template_id: row.templateId,
    slug: row.slug,
    providers,
  }, 202);
},
);

// ─── Project-scoped CLI tokens ─────────────────────────────────────────────
// These are PATs (`kortix_pat_...`) bound to a single project. The auth
// middleware enforces that the URL's `:projectId` matches the token's
// project_id, so the token is useless outside this one project. They're
// auto-minted at session-create time and injected into the sandbox as
// `KORTIX_CLI_TOKEN` so the in-container CLI works with zero config.


projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/cli-token',
    tags: ['projects'],
    summary: 'GET /:projectId/cli-token',
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
  const tokens = await listAccountTokens(loaded.row.accountId, projectId);
  return c.json({
    items: tokens.map((t) => ({
      token_id: t.tokenId,
      name: t.name,
      public_key: t.publicKey,
      status: t.status,
      expires_at: t.expiresAt?.toISOString() ?? null,
      last_used_at: t.lastUsedAt?.toISOString() ?? null,
      created_at: t.createdAt.toISOString(),
      revoked_at: t.revokedAt?.toISOString() ?? null,
    })),
  });
},
);


projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/cli-token',
    tags: ['projects'],
    summary: 'POST /:projectId/cli-token',
    ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
    responses: {
        201: json(z.any(), 'OK'),
        ...errors(404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  // Authorization is enforced by loadProjectForUser(... 'manage') above,
  // which routes through the IAM engine (project.write).

  // Privilege-escalation guard: an agent-session token is itself a project
  // account token carrying a (possibly narrow) AgentGrant. If it could mint a
  // fresh project token, the new token would carry NO grant — letting a scoped
  // agent issue an unscoped sibling and escape its own ceiling. Token minting
  // is a human/manage operation; agents are denied outright.
  if (getAgentGrant(c)) {
    return c.json({ error: 'Agent-session tokens cannot mint project tokens' }, 403);
  }

  // One body field: `name`. Defaults to "cli · <project name>".
  let body: { name?: unknown } = {};
  try {
    body = (await c.req.json()) ?? {};
  } catch {
    /* empty body is fine */
  }
  const name =
    typeof body.name === 'string' && body.name.trim()
      ? body.name.trim().slice(0, 255)
      : `cli · ${loaded.row.name}`;

  const userId = c.get('userId') as string;
  const created = await createAccountToken({
    accountId: loaded.row.accountId,
    userId,
    projectId,
    name,
  });

  return c.json(
    {
      token_id: created.tokenId,
      name: created.name,
      public_key: created.publicKey,
      secret_key: created.secretKey,
      status: created.status,
      project_id: created.projectId,
      expires_at: created.expiresAt?.toISOString() ?? null,
      created_at: created.createdAt.toISOString(),
    },
    201,
  );
},
);


projectsApp.openapi(
  createRoute({
    method: 'delete',
    path: '/{projectId}/cli-token/{tokenId}',
    tags: ['projects'],
    summary: 'DELETE /:projectId/cli-token/:tokenId',
    ...auth,
      request: {
        params: z.object({ projectId: z.string(), tokenId: z.string() }),
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const tokenId = c.req.param('tokenId');
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  // Authorization is enforced by loadProjectForUser(... 'manage') above.
  // Token management is a human/manage operation: an agent-session token must
  // not revoke project tokens (it could knock out its own siblings / the human
  // CLI token as a DoS). Symmetric with the mint guard above.
  if (getAgentGrant(c)) {
    return c.json({ error: 'Agent-session tokens cannot manage project tokens' }, 403);
  }
  const ok = await revokeAccountToken(tokenId, loaded.row.accountId, projectId);
  if (!ok) return c.json({ error: 'token not found or already revoked' }, 404);
  return c.json({ ok: true });
},
);

// GET /v1/projects/:projectId/git/clone-credential
// Runtime-only clone credential fetch. A session sandbox calls this endpoint
// with its sandbox-scoped KORTIX_TOKEN and gets a fresh provider credential
// just-in-time. Browser sessions must not receive raw Git tokens.

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/git/clone-credential',
    tags: ['github'],
    summary: 'GET /:projectId/git/clone-credential',
    ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(403, 404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const authType = (c as any).get('authType') as string | undefined;
  const tokenProjectId = (c as any).get('tokenProjectId') as string | undefined;

  let projectRow: typeof projects.$inferSelect | null = null;

  if (authType === 'pat') {
    if (tokenProjectId !== projectId) {
      return c.json({ error: 'clone credentials require a project-scoped runtime token' }, 403);
    }
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertAgentSessionWorkspaceAllowsRepository(c, loaded.row.accountId, projectId);
    projectRow = loaded.row;
  } else if (authType === 'apiKey' && (c as any).get('apiKeyType') === 'sandbox') {
    const accountId = (c as any).get('accountId') as string | undefined;
    const sandboxId = (c as any).get('sandboxId') as string | undefined;
    if (!accountId || !sandboxId) {
      return c.json({ error: 'clone credentials require a sandbox token' }, 403);
    }
    const [sandbox] = await db
      .select({
        sandboxId: sessionSandboxes.sandboxId,
        sessionId: sessionSandboxes.sessionId,
      })
      .from(sessionSandboxes)
      .where(and(
        eq(sessionSandboxes.sandboxId, sandboxId),
        eq(sessionSandboxes.projectId, projectId),
        eq(sessionSandboxes.accountId, accountId),
        inArray(sessionSandboxes.status, ['provisioning', 'active']),
      ))
      .limit(1);
    if (!sandbox) {
      return c.json({ error: 'sandbox token is not scoped to this project' }, 403);
    }
    if (
      !(await sessionWorkspaceAllowsRepositoryAccess({
        sessionId: sandbox.sessionId,
        accountId,
        projectId,
      }))
    ) {
      return c.json({ error: 'sandbox workspace does not allow repository access' }, 403);
    }
    const [row] = await db
      .select()
      .from(projects)
      .where(and(
        eq(projects.projectId, projectId),
        eq(projects.accountId, accountId),
      ))
      .limit(1);
    if (!row || row.status === 'archived') return c.json({ error: 'Not found' }, 404);
    projectRow = row;
  } else {
    return c.json({ error: 'clone credentials are only available to runtime tokens' }, 403);
  }
  if (!projectRow) return c.json({ error: 'Not found' }, 404);

  const gitAuth = await resolveProjectGitAuth(projectRow);
  const upstream = await resolveProjectUpstream(projectRow, 'write');
  const credential = parseBasicAuthHeader(upstream?.headers.Authorization);
  if (!credential) {
    return c.json({
      repo_url: upstream?.url ?? projectRow.repoUrl,
      auth: null,
      source: gitAuth.authSource,
    });
  }

  return c.json({
    repo_url: upstream?.url ?? projectRow.repoUrl,
    auth: {
      username: credential.username,
      token: credential.token,
      type: 'basic',
    },
    source: gitAuth.authSource,
    expires_at: null,
  });
},
);

// PUT /v1/projects/:projectId/git-credential
// Stores provider-neutral BYO git credentials as platform credentials, not as
// user-readable/injectable runtime secrets. The managed GitHub backend mints
// credentials server-side; this exists for generic future providers such as
// GitLab/Bitbucket until they have first-class adapters.

projectsApp.openapi(
  createRoute({
    method: 'put',
    path: '/{projectId}/git-credential',
    tags: ['github'],
    summary: 'PUT /:projectId/git-credential',
    ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(400, 404, 409),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const body = await readBody(c);
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  // Storing a git credential is a connector-write capability — a custom role can
  // omit project.connector.write to take credential management away from a
  // department, and an agent grant must include it (central fold) to write one.
  await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE);

  if (await hasServerManagedGitAuth(loaded.row)) {
    return c.json({ error: 'Git auth is already managed by Kortix for this project' }, 409);
  }

  const token =
    typeof body.token === 'string'
      ? body.token.trim()
      : typeof body.value === 'string'
        ? body.value.trim()
        : '';
  if (!token) return c.json({ error: 'token is required' }, 400);

  const existingConnection = await getProjectGitConnection(projectId);
  const remote = getProjectGitRemote(loaded.row, existingConnection);
  const provider = normalizeString(body.provider) ?? (remote.provider === 'github' ? 'generic' : remote.provider);
  if (provider === 'github') {
    return c.json({ error: 'GitHub credentials are managed through the GitHub App connection' }, 409);
  }

  const credential = await upsertProjectGitCredential({
    accountId: loaded.row.accountId,
    projectId,
    provider,
    token,
    createdBy: loaded.userId,
  });
  const connection = await upsertProjectGitConnection({
    accountId: loaded.row.accountId,
    projectId,
    provider,
    repoUrl: loaded.row.repoUrl,
    defaultBranch: loaded.row.defaultBranch,
    authMethod: 'project_credential',
    credentialRef: credential.credentialId,
    status: 'connected',
    metadata: { credential_kind: 'token' },
  });

  return c.json({
    configured: true,
    provider,
    git_connection: serializeProjectGitConnection(connection),
  }, 200);
},
);

// GET /v1/projects/:projectId/secrets
// Readable by any project member: returns each secret IDENTIFIER as the
// per-user view (the shared row + that member's own override, no plaintext)
// plus the manifest-declared required/optional env KEYS. Every project member
// with read access sees every secret — there is no per-secret member/group
// sharing. Members manage only their own override; managers additionally
// manage the shared row (`can_manage_shared`).

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/secrets',
    tags: ['secrets'],
    summary: 'GET /:projectId/secrets',
    ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
      },
    responses: {
        200: json(
          z.object({
            items: z.array(SecretSchema),
            required: z.array(z.string()),
            optional: z.array(z.string()),
            can_manage: z.boolean(),
            manifest_status: z.enum(['loaded', 'missing', 'error']),
            manifest_path: z.string(),
            manifest_error: z.string().optional(),
          }),
          'Secret configuration metadata',
        ),
        ...errors(404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  // Leaf-gate the read (a custom role can omit project.secret.read) — and, via
  // the central agent-grant fold, an agent token must hold it in its kortixCli.
  await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_SECRET_READ);

  const canManageShared = roleAllows(loaded.effectiveRole, 'manage');

  // Manifest is optional — a project without kortix.yaml just gets empty
  // required/optional lists. We surface loaded/missing/error explicitly so the
  // UI can distinguish "no envs declared" from "we couldn't read the manifest".
  let required: string[] = [];
  let optional: string[] = [];
  let manifestStatus: 'loaded' | 'missing' | 'error' = 'missing';
  let manifestError: string | null = null;
  // The same load answers `delivery_blocked_reason` (which agents may receive an
  // egress/broker secret). Threading the config costs no extra I/O; leaving it
  // null on a failed load is what keeps the warning from firing on a guess.
  let agentGrants: SecretAgentGrantConfig | null = null;
  try {
    const projectConfig = await loadProjectConfig(await withProjectGitAuth(loaded.row), []);
    required = projectConfig?.env?.required ?? [];
    optional = projectConfig?.env?.optional ?? [];
    manifestStatus = projectConfig?.manifest_raw ? 'loaded' : 'missing';
    agentGrants = projectConfig ?? null;
  } catch (err) {
    manifestStatus = 'error';
    manifestError = err instanceof Error ? err.message : String(err);
    console.warn('[projects] secrets: manifest load failed', {
      projectId,
      manifestPath: loaded.row.manifestPath,
      error: manifestError,
    });
  }

  // Per-agent secrets scoping: a scoped agent token only sees the IDENTIFIERS
  // in its standing agent grant. A session secretsAllowlist is a delivery
  // policy, not a configuration-plane read policy. Applying it here made a
  // session with `secrets_allowlist: []` accept a shared write and then hide the
  // written row from the same caller. Runtime materialization still intersects
  // the agent grant with the session allowlist in sandbox-env-sync.ts.
  //
  // This route returns metadata only. It never returns a secret value. The
  // standing agent grant remains the enumeration ceiling for agent tokens.
  const agentGrant = getAgentGrant(c);

  const items = (await loadSecretViewsForUser(projectId, loaded.userId, canManageShared, agentGrants))
    .filter((item) => !item.system)
    .filter((item) => agentMayUseEnv(agentGrant, item.identifier));

  return c.json({
    items,
    required,
    optional,
    // Page-level: may this member edit shared rows (add/set/share), or only
    // manage their own overrides?
    can_manage: canManageShared,
    manifest_status: manifestStatus,
    manifest_path: loaded.row.manifestPath,
    ...(manifestError ? { manifest_error: manifestError } : {}),
  });
},
);

// POST /v1/projects/:projectId/secrets
// Upsert a project secret. The response intentionally omits value/value_enc.

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/secrets',
    tags: ['secrets'],
    summary: 'POST /:projectId/secrets',
    ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
    responses: {
        200: json(SecretWriteResultSchema, 'The created secret'),
        ...errors(400, 404, 409),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const body = await readBody(c);
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_SECRET_WRITE);

  const name = normalizeString(body.name)?.toUpperCase();
  if (!name) return c.json({ error: 'name is required' }, 400);
  if (!isValidSecretName(name)) {
    return c.json({ error: 'name must be a valid env var name (A-Z, 0-9, _; max 64 chars)' }, 400);
  }
  if (name.startsWith('KORTIX_')) {
    return c.json({ error: 'KORTIX_* names are reserved for platform/runtime-managed variables' }, 400);
  }
  if (name === CODEX_AUTH_JSON_SECRET_NAME) {
    return c.json({ error: `${CODEX_AUTH_JSON_SECRET_NAME} is managed by ChatGPT subscription onboarding` }, 400);
  }

  // Identifier — the unique-per-project handle agents grant + the UI shows.
  // Defaults to the KEY when omitted (the simple/migrated case).
  const identifier = normalizeString(body.identifier) ?? name;
  if (!isValidIdentifier(identifier)) {
    return c.json({ error: 'identifier must be alphanumeric (A-Z, 0-9, _, ., -; max 128 chars)' }, 400);
  }

  const value = typeof body.value === 'string' ? body.value : null;
  const requestedConsumer =
    body.consumer === undefined ? undefined : SecretConsumerSchema.nullable().safeParse(body.consumer);
  if (requestedConsumer && !requestedConsumer.success) {
    return c.json({ error: 'consumer is invalid' }, 400);
  }
  const requestedConsumerData = requestedConsumer?.success
    ? requestedConsumer.data
    : undefined;
  const requestedStrategy = body.strategy;
  if (
    requestedStrategy !== undefined &&
    !['runtime', 'broker', 'egress', 'denied'].includes(String(requestedStrategy))
  ) {
    return c.json({ error: 'secret creation supports runtime, broker, egress, or denied delivery' }, 400);
  }
  if (
    requestedStrategy === 'broker' &&
    requestedConsumerData !== 'llm_gateway' &&
    requestedConsumerData !== 'connector' &&
    requestedConsumerData !== 'http_broker'
  ) {
    return c.json({ error: 'broker creation requires a supported server consumer' }, 400);
  }
  if (
    requestedStrategy === 'runtime' &&
    requestedConsumer !== undefined &&
    requestedConsumerData !== 'sandbox'
  ) {
    return c.json({ error: 'runtime creation requires the sandbox consumer' }, 400);
  }
  if (
    requestedStrategy === 'egress' &&
    requestedConsumer !== undefined &&
    requestedConsumerData !== 'network'
  ) {
    return c.json({ error: 'egress creation requires the network consumer' }, 400);
  }
  if (
    requestedStrategy === 'denied' &&
    requestedConsumer !== undefined &&
    requestedConsumerData !== null
  ) {
    return c.json({ error: 'denied creation cannot have a consumer' }, 400);
  }
  if (requestedStrategy === undefined && requestedConsumer !== undefined) {
    return c.json({ error: 'consumer requires a strategy' }, 400);
  }
  const defaultToGateway =
    requestedStrategy === undefined &&
    requestedConsumer === undefined &&
    isGatewayManagedEnv(name);
  const explicitStrategy = (requestedStrategy ?? (defaultToGateway ? 'broker' : undefined)) as
    | 'runtime'
    | 'broker'
    | 'egress'
    | 'denied'
    | undefined;
  const explicitConsumer =
    requestedConsumer === undefined
      ? defaultToGateway
        ? 'llm_gateway'
        : requestedStrategy === 'runtime'
          ? 'sandbox'
          : requestedStrategy === 'egress'
            ? 'network'
          : requestedStrategy === 'denied'
            ? null
            : undefined
      : requestedConsumerData;
  let explicitPolicy = null;
  if (explicitConsumer === 'http_broker' || explicitConsumer === 'network') {
    const policy = parseEgressPolicy(body.egress_policy);
    if (!policy.ok) {
      return c.json({ error: policy.error, code: 'secret_delivery_policy_invalid' }, 400);
    }
    if (explicitConsumer === 'http_broker' && policy.policy.backend !== 'kortix_fetch') {
      return c.json({ error: 'HTTP broker requires the kortix_fetch backend' }, 400);
    }
    if (explicitConsumer === 'network') {
      const boundaryError = networkBoundaryPolicyError(policy.policy);
      if (boundaryError) {
        return c.json(
          { error: boundaryError, code: 'secret_delivery_policy_invalid' },
          400,
        );
      }
      if (!networkBoundaryDeliveryAvailable()) {
        return c.json(
          {
            error: 'Network-boundary delivery requires the Platinum sandbox provider',
            code: 'secret_delivery_unavailable',
          },
          409,
        );
      }
      const conflict = await boundaryDestinationConflict(projectId, identifier, policy.policy);
      if (conflict) return c.json(boundaryConflictBody(identifier, conflict), 409);
    }
    explicitPolicy = policy.policy;
  } else if (body.egress_policy !== undefined) {
    return c.json({ error: 'This consumer does not accept an outbound policy' }, 400);
  }
  const explicitHandlePrefix =
    explicitConsumer === 'http_broker' && typeof body.handle_prefix === 'string'
      ? body.handle_prefix.trim()
      : null;
  if (explicitHandlePrefix && explicitHandlePrefix.length > 48) {
    return c.json({ error: 'handle_prefix must contain at most 48 characters' }, 400);
  }

  // Look up the existing SHARED row by IDENTIFIER so a key-unchanged edit
  // doesn't force re-entering the value. Creating a brand-new secret still
  // requires a value.
  const [existing] = await db
    .select({
      secretId: projectSecrets.secretId,
      name: projectSecrets.name,
      strategy: projectSecrets.strategy,
      consumer: projectSecrets.consumer,
    })
    .from(projectSecrets)
    .where(and(
      eq(projectSecrets.projectId, projectId),
      eq(projectSecrets.identifier, identifier),
      isNull(projectSecrets.ownerUserId),
    ))
    .limit(1);
  if (!existing && value === null) {
    return c.json({ error: 'value is required' }, 400);
  }
  // An identifier is a stable handle to ONE secret — redefining its underlying
  // KEY via upsert would silently retarget every agent grant that references
  // it. Reject instead of a surprising in-place key swap.
  if (identifierKeyConflicts(existing?.name ?? null, name)) {
    return c.json({
      error: `identifier "${identifier}" already exists with key "${existing!.name}" — delete it first to reuse the identifier with a different key`,
    }, 409);
  }

  const now = new Date();
  const actorType =
    c.get('authType') === 'service_account'
      ? 'service_account'
      : getAgentGrant(c)
        ? 'agent'
        : 'human';
  await runAuditedTransaction(
    async (tx) => {
      if (value !== null) {
        const [row] = await tx
          .insert(projectSecrets)
          .values({
            projectId,
            identifier,
            name,
            valueEnc: encryptProjectSecret(projectId, value),
            ...(explicitStrategy ? { strategy: explicitStrategy } : {}),
            ...(explicitConsumer !== undefined ? { consumer: explicitConsumer } : {}),
            ...(explicitPolicy ? { egressPolicy: explicitPolicy } : {}),
            ...(explicitHandlePrefix ? { handlePrefix: explicitHandlePrefix } : {}),
            createdBy: loaded.userId,
            rotatedAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [projectSecrets.projectId, projectSecrets.identifier],
            targetWhere: isNull(projectSecrets.ownerUserId),
            set: {
              valueEnc: encryptProjectSecret(projectId, value),
              ...(explicitStrategy ? { strategy: explicitStrategy } : {}),
              ...(explicitConsumer !== undefined ? { consumer: explicitConsumer } : {}),
              ...(explicitConsumer !== undefined ? { egressPolicy: explicitPolicy } : {}),
              ...(explicitConsumer !== undefined ? { handlePrefix: explicitHandlePrefix } : {}),
              rotatedAt: now,
              updatedAt: now,
            },
          })
          .returning({ secretId: projectSecrets.secretId });
        return row.secretId;
      }

      await tx
        .update(projectSecrets)
        .set({ updatedAt: now })
        .where(eq(projectSecrets.secretId, existing!.secretId));
      return existing!.secretId;
    },
    (resourceId) => ({
      accountId: loaded.row.accountId,
      projectId,
      actorUserId: loaded.userId,
      actorType,
      source: inferAuditSource(c, actorType),
      action: existing ? 'secret.updated' : 'secret.created',
      resourceType: 'project_secret',
      resourceId,
      before: existing
        ? { configured: true, strategy: existing.strategy, consumer: existing.consumer }
        : null,
      after: {
        configured: true,
        strategy: explicitStrategy ?? existing?.strategy ?? 'runtime',
        consumer:
          explicitConsumer !== undefined ? explicitConsumer : (existing?.consumer ?? 'sandbox'),
        egress_policy: explicitPolicy,
        rotated: value !== null,
      },
      metadata: { identifier, name },
    }),
  );

  // Only a network-boundary secret waits for the fan-out. Its value never
  // reaches the sandbox, so a failed push is the difference between "the agent
  // can call that host" and "it cannot" — the author has to see it. Awaiting is
  // up to 15s per live sandbox, which no ordinary secret save should pay, so
  // every other strategy keeps the detached push.
  const boundaryDelivery = explicitStrategy === 'egress' || existing?.strategy === 'egress';
  let deliverySync: SecretDeliverySync | null = null;
  if (boundaryDelivery) {
    deliverySync = summarizeDeliverySync(
      await propagateProjectSecretsToActiveSandboxes(projectId, {
        refreshModels: isGatewayManagedEnv(name),
      }),
    );
  } else {
    void propagateProjectSecretsToActiveSandboxes(projectId, { refreshModels: isGatewayManagedEnv(name) });
  }

  // First provider connect on a default-less project → seed a sensible project
  // default model (that provider's flagship). Detached + idempotent; never seeds
  // over an existing default.
  if (value !== null && isGatewayManagedEnv(name)) {
    void seedProjectDefaultModelOnConnect({
      projectId,
      accountId: loaded.row.accountId,
      userId: loaded.userId,
      secretName: name,
    });
  }

  const views = await loadSecretViewsForUser(projectId, loaded.userId, true);
  const view = views.find((v) => v.identifier === identifier);
  if (!view) {
    throw new Error(`Secret view not found after upsert: ${identifier}`);
  }
  return c.json({ ...view, delivery_sync: deliverySync }, 200);
},
);

projectsApp.openapi(
  createRoute({
    method: 'put',
    path: '/{projectId}/secrets/{identifier}/strategy',
    tags: ['secrets'],
    summary: 'PUT /:projectId/secrets/:identifier/strategy',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), identifier: z.string() }),
      body: { content: { 'application/json': { schema: UpdateSecretStrategyInputSchema } } },
    },
    responses: {
      200: json(SecretWriteResultSchema, 'Updated secret delivery strategy'),
      ...errors(400, 403, 404, 409),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const identifier = c.req.param('identifier')?.trim();
    const parsed = UpdateSecretStrategyInputSchema.safeParse(await readBody(c));
    if (!identifier || !isValidIdentifier(identifier)) {
      return c.json({ error: 'Invalid secret identifier' }, 400);
    }
    if (!parsed.success) {
      return c.json({ error: 'strategy must be runtime, egress, broker, or denied' }, 400);
    }

    const loaded = await loadProjectForUser(c, projectId, 'manage');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_SECRET_WRITE,
    );
    if (getAgentGrant(c)) {
      return c.json({ error: 'Agent sessions cannot change secret delivery policy' }, 403);
    }
    if (isSystemProjectSecretName(identifier)) {
      return c.json({ error: `${identifier} is managed by Kortix` }, 403);
    }
    let nextPolicy = null;
    const policyBackend = parsed.data.egress_policy?.backend;
    const inferredConsumer =
      parsed.data.strategy === 'runtime'
        ? 'sandbox'
        : parsed.data.strategy === 'denied'
          ? null
          : parsed.data.strategy === 'egress'
            ? 'network'
            : policyBackend === 'kortix_fetch'
              ? 'http_broker'
              : policyBackend === 'llm_gateway' || policyBackend === 'git_proxy'
                ? policyBackend
                : 'http_broker';
    const nextConsumer =
      parsed.data.consumer === undefined
        ? inferredConsumer
        : parsed.data.consumer;

    if (parsed.data.strategy === 'runtime' && nextConsumer !== 'sandbox') {
      return c.json({ error: 'runtime delivery requires the sandbox consumer' }, 400);
    }
    if (parsed.data.strategy === 'denied' && nextConsumer !== null) {
      return c.json({ error: 'denied delivery cannot have a consumer' }, 400);
    }
    if (parsed.data.strategy === 'egress' && nextConsumer !== 'network') {
      return c.json({ error: 'egress delivery requires the network consumer' }, 400);
    }
    if (
      parsed.data.strategy === 'broker' &&
      !['llm_gateway', 'git_proxy', 'http_broker', 'connector'].includes(
        String(nextConsumer),
      )
    ) {
      return c.json({ error: 'broker delivery requires a server consumer' }, 400);
    }

    const requiresNetworkPolicy =
      parsed.data.strategy === 'egress' || nextConsumer === 'http_broker';
    if (requiresNetworkPolicy) {
      if (!parsed.data.egress_policy) {
        return c.json(
          {
            error: `${parsed.data.strategy} delivery requires an outbound policy`,
            code: 'secret_delivery_policy_required',
          },
          400,
        );
      }
      const policy = parseEgressPolicy(parsed.data.egress_policy);
      if (!policy.ok) {
        return c.json(
          { error: policy.error, code: 'secret_delivery_policy_invalid' },
          400,
        );
      }
      nextPolicy = policy.policy;
      if (parsed.data.strategy === 'egress') {
        const boundaryError = networkBoundaryPolicyError(policy.policy);
        if (boundaryError) {
          return c.json(
            { error: boundaryError, code: 'secret_delivery_policy_invalid' },
            400,
          );
        }
      }
    } else if (parsed.data.egress_policy) {
      return c.json({ error: 'This consumer does not accept an outbound policy' }, 400);
    }
    if (parsed.data.strategy === 'egress') {
      if (!networkBoundaryDeliveryAvailable()) {
        return c.json(
          {
            error: 'Network-boundary delivery requires the Platinum sandbox provider',
            code: 'secret_delivery_unavailable',
          },
          409,
        );
      }
    }
    if (
      parsed.data.strategy === 'broker' &&
      nextConsumer !== 'llm_gateway' &&
      nextConsumer !== 'connector' &&
      nextConsumer !== 'http_broker'
    ) {
      return c.json(
        {
          error: 'The selected broker backend is unavailable',
          code: 'secret_delivery_unavailable',
        },
        409,
      );
    }

    const [existing] = await db
      .select({
        secretId: projectSecrets.secretId,
        name: projectSecrets.name,
        strategy: projectSecrets.strategy,
        consumer: projectSecrets.consumer,
        rotatedAt: projectSecrets.rotatedAt,
        updatedAt: projectSecrets.updatedAt,
        strategyLocked: projectSecrets.strategyLocked,
        egressPolicy: projectSecrets.egressPolicy,
        handlePrefix: projectSecrets.handlePrefix,
      })
      .from(projectSecrets)
      .where(
        and(
          eq(projectSecrets.projectId, projectId),
          eq(projectSecrets.identifier, identifier),
          isNull(projectSecrets.ownerUserId),
        ),
      )
      .limit(1);
    if (!existing) return c.json({ error: 'Not found' }, 404);
    if (existing.strategyLocked && existing.strategy !== parsed.data.strategy) {
      return c.json(
        { error: 'This secret delivery strategy is locked', code: 'secret_strategy_locked' },
        409,
      );
    }
    if (
      parsed.data.strategy === 'runtime' &&
      existing.strategy !== 'runtime' &&
      (!existing.rotatedAt || existing.rotatedAt < existing.updatedAt)
    ) {
      return c.json(
        {
          error: 'Rotate the secret before restoring runtime delivery',
          code: 'secret_rotation_required',
        },
        409,
      );
    }
    if (!(parsed.data.strategy === 'broker' && nextConsumer === 'connector')) {
      const connectors = await connectorSecretBindings(projectId, identifier);
      if (connectors.length > 0) {
        return c.json(
          {
            error: 'Remove connector bindings before changing this secret delivery policy',
            code: 'secret_connector_binding_exists',
            connectors,
          },
          409,
        );
      }
    }

    // Last gate before the write: the destination has to be free. Checked here,
    // after the 404 and the lock checks, so an author sees the specific reason
    // rather than a collision report for a secret they cannot edit anyway.
    if (parsed.data.strategy === 'egress' && nextPolicy) {
      const conflict = await boundaryDestinationConflict(projectId, identifier, nextPolicy);
      if (conflict) return c.json(boundaryConflictBody(identifier, conflict), 409);
    }

    const nextHandlePrefix =
      nextConsumer === 'http_broker' ? (parsed.data.handle_prefix ?? null) : null;
    const deliveryChanged =
      existing.strategy !== parsed.data.strategy ||
      existing.consumer !== nextConsumer ||
      JSON.stringify(existing.egressPolicy ?? null) !== JSON.stringify(nextPolicy) ||
      existing.handlePrefix !== nextHandlePrefix;
    let deliverySync: SecretDeliverySync | null = null;
    if (deliveryChanged) {
      const changedAt = new Date();
      const actorType =
        c.get('authType') === 'service_account' ? 'service_account' : 'human';
      await runAuditedTransaction(
        async (tx) => {
          await tx
            .update(projectSecrets)
            .set({
              strategy: parsed.data.strategy,
              consumer: nextConsumer,
              egressPolicy: nextPolicy,
              handlePrefix: nextHandlePrefix,
              updatedAt: changedAt,
            })
            .where(eq(projectSecrets.secretId, existing.secretId));
          await tx
            .update(projectSessionSecretHandles)
            .set({ status: 'revoked', revokedAt: changedAt })
            .where(
              and(
                eq(projectSessionSecretHandles.secretId, existing.secretId),
                eq(projectSessionSecretHandles.status, 'active'),
              ),
            );
        },
        () => ({
          accountId: loaded.row.accountId,
          projectId,
          actorUserId: loaded.userId,
          actorType,
          source: inferAuditSource(c, actorType),
          action: 'secret.strategy.changed',
          resourceType: 'project_secret',
          resourceId: existing.secretId,
          before: {
            strategy: existing.strategy,
            consumer: existing.consumer,
            egress_policy: existing.egressPolicy ?? null,
            handle_prefix: existing.handlePrefix ?? null,
          },
          after: {
            strategy: parsed.data.strategy,
            consumer: nextConsumer,
            egress_policy: nextPolicy,
            handle_prefix: nextHandlePrefix,
            requires_rotation: parsed.data.strategy !== 'runtime',
          },
          metadata: { identifier, name: existing.name },
        }),
      );
      // This route already paid for the fan-out and discarded the report. A
      // network-boundary secret that stored fine and reached no live sandbox is
      // otherwise indistinguishable from one that worked.
      deliverySync = summarizeDeliverySync(
        await propagateProjectSecretsToActiveSandboxes(projectId, {
          refreshModels: isGatewayManagedEnv(existing.name),
        }),
      );
    }

    const views = await loadSecretViewsForUser(projectId, loaded.userId, true);
    const view = views.find((item) => item.identifier === identifier);
    if (!view) return c.json({ error: 'Not found' }, 404);

    return c.json({ ...view, delivery_sync: deliverySync }, 200);
  },
);

// ─── Provider OAuth device flow (poll-based) ───────────────────────────────
//
// Connect a subscription-backed LLM provider (today: a ChatGPT Plus/Pro
// account via the OpenAI Codex device grant) and save the resulting login as
// the project's CODEX_AUTH_JSON secret. Only the LLM gateway can decrypt this
// value. The sandbox receives neither the token nor an opaque handle.
//
// Two quick, NON-streaming calls so they survive any edge (a long-lived
// streaming response gets reset by Cloudflare) and any replica:
//   POST …/oauth/:provider/start → kicks the device flow in a DETACHED
//        background task on this replica, returns the device challenge.
//   POST …/oauth/:provider/poll  → ANY replica reads the shared DB flow row;
//        once the user finishes authorizing, writes the secret and returns it.
// The in-flight flow lives in `kortix.oauth_provider_flows` (not replica
// memory), so start and poll need not hit the same pod. The detached task
// isn't tied to a client connection, so nothing the edge does can kill it.

// Kortix provider id → the secret we persist the resulting auth.json under.
// Only OpenAI (ChatGPT) is wired today; the shape generalizes to others.
const OAUTH_PROVIDERS: Record<string, { secretName: string }> = {
  openai: { secretName: CODEX_AUTH_JSON_SECRET_NAME },
};

// How long the encrypted flow handle stays valid (OpenAI expires the device
// code on its side too; this just bounds the opaque handle clients hold).
const DEVICE_AUTH_TTL_MS = 15 * 60 * 1000;
// Floor for the client poll cadence (OpenAI returns its own suggested interval).
const OAUTH_POLL_INTERVAL_MS = 3000;

// Persists the Codex auth.json as the CODEX_AUTH_JSON project secret — private
// (the caller's own per-user OAuth login, ownerUserId-scoped) when `sharing`
// says so, else the project-wide shared row — then returns the caller's view
// of it. Codex-specific on purpose: a generic OPENCODE_AUTH_JSON row is never
// overwritten by this. `sharing` only ever chooses private-vs-shared here —
// member/group secret sharing was retired (see projects/secrets.ts).
async function writeCodexAuthSecret(input: {
  projectId: string;
  accountId: string;
  userId: string;
  value: string;
  sharing?: ReturnType<typeof parseSharingIntent>;
}) {
  const { projectId, accountId, userId, value, sharing } = input;
  const now = new Date();
  let secretId: string;

  if (sharing?.mode === 'private') {
    const [written] = await db
      .insert(projectSecrets)
      .values({
        projectId,
        identifier: CODEX_AUTH_JSON_SECRET_NAME,
        name: CODEX_AUTH_JSON_SECRET_NAME,
        valueEnc: encryptProjectSecret(projectId, value),
        ownerUserId: userId,
        active: true,
        strategy: 'broker',
        consumer: 'llm_gateway',
        strategyLocked: true,
        rotatedAt: now,
        createdBy: userId,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [projectSecrets.projectId, projectSecrets.name, projectSecrets.ownerUserId],
        targetWhere: sql`${projectSecrets.ownerUserId} is not null`,
        set: {
          valueEnc: encryptProjectSecret(projectId, value),
          active: true,
          strategy: 'broker',
          consumer: 'llm_gateway',
          egressPolicy: null,
          handlePrefix: null,
          strategyLocked: true,
          rotatedAt: now,
          updatedAt: now,
        },
      })
      .returning({ secretId: projectSecrets.secretId });
    if (!written) throw new Error('Failed to store the private Codex credential');
    secretId = written.secretId;
  } else {
    const [written] = await db
      .insert(projectSecrets)
      .values({
        projectId,
        identifier: CODEX_AUTH_JSON_SECRET_NAME,
        name: CODEX_AUTH_JSON_SECRET_NAME,
        valueEnc: encryptProjectSecret(projectId, value),
        strategy: 'broker',
        consumer: 'llm_gateway',
        strategyLocked: true,
        rotatedAt: now,
        createdBy: userId,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [projectSecrets.projectId, projectSecrets.identifier],
        targetWhere: isNull(projectSecrets.ownerUserId),
        set: {
          valueEnc: encryptProjectSecret(projectId, value),
          strategy: 'broker',
          consumer: 'llm_gateway',
          egressPolicy: null,
          handlePrefix: null,
          strategyLocked: true,
          rotatedAt: now,
          updatedAt: now,
        },
      })
      .returning({ secretId: projectSecrets.secretId });
    if (!written) throw new Error('Failed to store the shared Codex credential');
    secretId = written.secretId;
  }

  await recordAuditEvent({
    accountId,
    projectId,
    actorUserId: userId,
    actorType: 'human',
    source: 'api',
    action: 'secret.oauth.connected',
    resourceType: 'project_secret',
    resourceId: secretId,
    metadata: {
      identifier: CODEX_AUTH_JSON_SECRET_NAME,
      consumer: 'llm_gateway',
      sharing: sharing?.mode === 'private' ? 'private' : 'project',
    },
  });

  void propagateProjectSecretsToActiveSandboxes(projectId, { refreshModels: true });

  const views = await loadSecretViewsForUser(projectId, userId, true);
  return views.find((v) => v.identifier === CODEX_AUTH_JSON_SECRET_NAME)
    ?? { identifier: CODEX_AUTH_JSON_SECRET_NAME, name: CODEX_AUTH_JSON_SECRET_NAME };
}

// Best-effort token expiry (ms remaining) from a stored auth.json, for display.
function authExpiresInMs(authJson: string): number | null {
  try {
    const parsed = JSON.parse(authJson);
    // opencode auth.json is keyed by provider: { openai: { expires, ... } }.
    for (const entry of Object.values(parsed ?? {})) {
      const expires = (entry as { expires?: unknown })?.expires;
      if (typeof expires === 'number' && Number.isFinite(expires)) {
        return Math.max(0, expires - Date.now());
      }
    }
  } catch {
    // not parseable / no expiry — treat as unknown
  }
  return null;
}

// ─── POST /v1/projects/:projectId/oauth/:provider/start ────────────────────
// Kick the device flow in a detached background task; return the challenge.
projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/oauth/{provider}/start',
    tags: ['secrets'],
    summary: 'POST /:projectId/oauth/:provider/start',
    ...auth,
      request: {
        params: z.object({ projectId: z.string(), provider: z.string() }),
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
    responses: {
        200: json(z.any(), 'Device challenge'),
        ...errors(400, 401, 403, 404, 502),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const provider = c.req.param('provider');
  const body = await readBody(c);
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  if (!OAUTH_PROVIDERS[provider]) {
    return c.json({ error: `OAuth device flow is not available for "${provider}"` }, 400);
  }

  let sharing: ReturnType<typeof parseSharingIntent> | undefined;
  if (body.sharing != null) {
    sharing = parseSharingIntent(body.sharing, loaded.userId);
    if (!sharing) {
      return c.json({ error: 'invalid sharing — mode must be project|private|members' }, 400);
    }
  }
  // A shared credential is a project SECRET WRITE (the device flow persists it
  // via writeCodexAuthSecret on poll). Gate on the leaf so a custom role can
  // withhold it and the agent-grant fold applies — closing the gap where the
  // flow wrote a shared credential behind only loadProjectForUser('read'). A
  // private (owner-only) credential is the member's own, so read still suffices.
  // The poll step is reachable only with the project-key-encrypted flow handle
  // minted here, so gating start transitively protects the write on poll.
  if (sharing?.mode !== 'private') {
    await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_SECRET_WRITE);
  }

  // Request a device code straight from OpenAI — a couple HTTPS calls, no
  // subprocess, no server-side flow record. Everything `poll` needs is sealed
  // into the opaque `flow_id` (encrypted with the project key), so any replica
  // can serve any poll and there's nothing to leak or OOM.
  let challenge;
  try {
    challenge = await startCodexDeviceAuth();
  } catch (err) {
    return c.json({
      error: err instanceof Error ? err.message : 'Failed to start ChatGPT authorization',
    }, 502);
  }

  const expiresAt = Date.now() + DEVICE_AUTH_TTL_MS;
  const flowId = encryptProjectSecret(
    projectId,
    JSON.stringify({
      d: challenge.deviceAuthId,
      u: challenge.userCode,
      s: sharing ?? null,
      uid: loaded.userId,
      e: expiresAt,
    }),
  );

  return c.json({
    flow_id: flowId,
    verification_url: challenge.verificationUrl,
    user_code: challenge.userCode,
    expires_at: expiresAt,
    interval_ms: Math.max(challenge.intervalMs, OAUTH_POLL_INTERVAL_MS),
  });
},
);

// ─── POST /v1/projects/:projectId/oauth/:provider/poll ─────────────────────
// Any replica: read the shared flow row; on success persist the secret.
projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/oauth/{provider}/poll',
    tags: ['secrets'],
    summary: 'POST /:projectId/oauth/:provider/poll',
    ...auth,
      request: {
        params: z.object({ projectId: z.string(), provider: z.string() }),
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
    responses: {
        200: json(z.any(), 'Poll result'),
        ...errors(400, 401, 404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const provider = c.req.param('provider');
  const body = await readBody(c);
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const flowId = normalizeString(body.flow_id);
  if (!flowId) return c.json({ error: 'flow_id is required' }, 400);

  // Decrypt the opaque flow handle. The key is project-scoped, so a handle from
  // another project — or a tampered one — simply won't decrypt → expired.
  let state: { d?: string; u?: string; s?: unknown; uid?: string; e?: number };
  try {
    state = JSON.parse(decryptProjectSecret(projectId, flowId));
  } catch {
    return c.json({ status: 'expired' });
  }
  // Only the member who started it may poll it, and only before it expires.
  if (
    !state.d || !state.u ||
    state.uid !== loaded.userId ||
    typeof state.e !== 'number' || Date.now() > state.e
  ) {
    return c.json({ status: 'expired' });
  }

  const result = await pollCodexDeviceAuth({ deviceAuthId: state.d, userCode: state.u });
  if (result.status === 'pending') {
    return c.json({ status: 'pending', next_poll_ms: OAUTH_POLL_INTERVAL_MS });
  }
  if (result.status === 'failed') {
    return c.json({ status: 'failed', error: result.error });
  }

  // Authorized — persist the auth.json as the project secret with the sharing
  // chosen at start time (sealed, tamper-proof, in the flow handle).
  const sharing = state.s ? (parseSharingIntent(state.s, loaded.userId) ?? undefined) : undefined;
  await writeCodexAuthSecret({
    projectId,
    accountId: loaded.row.accountId,
    userId: loaded.userId,
    value: result.authJson,
    sharing,
  });

  return c.json({
    status: 'success',
    credential: {
      provider_id: provider,
      expires_in_ms: authExpiresInMs(result.authJson),
      updated_at: new Date().toISOString(),
    },
  });
},
);

// ─── GET /v1/projects/:projectId/oauth ─────────────────────────────────────
// List configured OAuth credentials (derived from the saved project secrets).
projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/oauth',
    tags: ['secrets'],
    summary: 'GET /:projectId/oauth',
    ...auth,
      request: { params: z.object({ projectId: z.string() }) },
    responses: {
        200: json(z.any(), 'Configured OAuth credentials'),
        ...errors(401, 404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_CONNECTOR_READ);

  const items: Array<{ provider_id: string; expires_in_ms: number | null; updated_at: string }> = [];
  for (const [providerId, cfg] of Object.entries(OAUTH_PROVIDERS)) {
    const credential = await resolveProjectSecretForConsumer({
      projectId,
      accountId: loaded.row.accountId,
      actorUserId: loaded.userId,
      principalUserId: loaded.userId,
      name: cfg.secretName,
      consumer: 'llm_gateway',
    });
    if (!credential) continue;
    items.push({
      provider_id: providerId,
      expires_in_ms: authExpiresInMs(credential.value),
      updated_at: credential.updatedAt.toISOString(),
    });
  }

  return c.json({ items });
},
);

// ─── DELETE /v1/projects/:projectId/oauth/:provider ────────────────────────
// Remove an OAuth credential (deletes the backing secret).
projectsApp.openapi(
  createRoute({
    method: 'delete',
    path: '/{projectId}/oauth/{provider}',
    tags: ['secrets'],
    summary: 'DELETE /:projectId/oauth/:provider',
    ...auth,
      request: { params: z.object({ projectId: z.string(), provider: z.string() }) },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(401, 403, 404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const provider = c.req.param('provider');
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE);

  const cfg = OAUTH_PROVIDERS[provider];
  if (!cfg) return c.json({ error: 'Not found' }, 404);

  await runAuditedTransaction(
    async (tx) => {
      await tx
        .delete(projectSecrets)
        .where(
          and(eq(projectSecrets.projectId, projectId), eq(projectSecrets.name, cfg.secretName)),
        );
    },
    () => ({
      accountId: loaded.row.accountId,
      projectId,
      actorUserId: loaded.userId,
      actorType: 'human',
      source: 'api',
      action: 'secret.oauth.disconnected',
      resourceType: 'project_secret',
      metadata: {
        identifier: cfg.secretName,
        consumer: 'llm_gateway',
      },
    }),
  );
  void propagateProjectSecretsToActiveSandboxes(projectId, { refreshModels: isGatewayManagedEnv(cfg.secretName) });

  return c.json({ ok: true });
},
);

// DELETE /v1/projects/:projectId/secrets/:identifier
// `:identifier` addresses the secret's unique IDENTIFIER (defaults to its KEY
// for the simple/migrated case, so a plain key-name delete keeps working).

projectsApp.openapi(
  createRoute({
    method: 'delete',
    path: '/{projectId}/secrets/{name}',
    tags: ['secrets'],
    summary: 'DELETE /:projectId/secrets/:identifier',
    ...auth,
      request: {
        params: z.object({ projectId: z.string(), name: z.string() }),
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(400, 403, 404, 409),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const identifier = c.req.param('name')?.trim();
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_SECRET_WRITE);
  if (!identifier || !isValidIdentifier(identifier)) {
    return c.json({ error: 'Invalid secret identifier' }, 400);
  }
  // A system row's identifier always equals its reserved KORTIX_* key (the
  // manifest never lets a human create one), so this alone protects it — no
  // DB read needed before the delete.
  if (isSystemProjectSecretName(identifier)) {
    return c.json({ error: `${identifier} is managed by Kortix and cannot be removed` }, 403);
  }
  if (identifier.toUpperCase() === CODEX_AUTH_JSON_SECRET_NAME) {
    return c.json(
      { error: `${CODEX_AUTH_JSON_SECRET_NAME} must be disconnected as an OAuth provider` },
      400,
    );
  }

  const [existing] = await db
    .select({
      secretId: projectSecrets.secretId,
      name: projectSecrets.name,
      strategy: projectSecrets.strategy,
    })
    .from(projectSecrets)
    .where(and(
      eq(projectSecrets.projectId, projectId),
      eq(projectSecrets.identifier, identifier),
      isNull(projectSecrets.ownerUserId),
    ))
    .limit(1);

  if (existing) {
    const connectors = await connectorSecretBindings(projectId, identifier);
    if (connectors.length > 0) {
      return c.json(
        {
          error: 'Remove connector bindings before deleting this secret',
          code: 'secret_connector_binding_exists',
          connectors,
        },
        409,
      );
    }
    const actorType =
      c.get('authType') === 'service_account'
        ? 'service_account'
        : getAgentGrant(c)
        ? 'agent'
        : 'human';
    await runAuditedTransaction(
      async (tx) => {
        await tx
          .delete(projectSecrets)
          .where(and(
            eq(projectSecrets.projectId, projectId),
            eq(projectSecrets.identifier, identifier),
            isNull(projectSecrets.ownerUserId),
          ));
      },
      () => ({
        accountId: loaded.row.accountId,
        projectId,
        actorUserId: loaded.userId,
        actorType,
        source: inferAuditSource(c, actorType),
        action: 'secret.deleted',
        resourceType: 'project_secret',
        resourceId: existing.secretId,
        before: { configured: true, strategy: existing.strategy },
        after: { configured: false },
        metadata: { identifier, name: existing.name },
      }),
    );
  } else {
    await db
      .delete(projectSecrets)
      .where(and(
        eq(projectSecrets.projectId, projectId),
        eq(projectSecrets.identifier, identifier),
        isNull(projectSecrets.ownerUserId),
      ));
  }

  void propagateProjectSecretsToActiveSandboxes(projectId, {
    refreshModels: existing ? isGatewayManagedEnv(existing.name) : false,
  });

  return c.json({ ok: true });
},
);

// PUT /v1/projects/:projectId/secrets/:name/personal
// Any project member sets/updates THEIR OWN per-key override (the "use mine"
// value) and/or flips whether it's active. Operates only on the caller's row;
// never touches the shared value or anyone else's override.

projectsApp.openapi(
  createRoute({
    method: 'put',
    path: '/{projectId}/secrets/{name}/personal',
    tags: ['secrets'],
    summary: 'PUT /:projectId/secrets/:name/personal',
    ...auth,
      request: {
        params: z.object({ projectId: z.string(), name: z.string() }),
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(400, 404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const body = await readBody(c);
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const name = c.req.param('name')?.trim().toUpperCase();
  if (!name || !isValidSecretName(name)) {
    return c.json({ error: 'Invalid secret name' }, 400);
  }
  if (isSystemProjectSecretName(name)) {
    return c.json({ error: 'KORTIX_* names are reserved and cannot be overridden' }, 400);
  }
  if (name === CODEX_AUTH_JSON_SECRET_NAME) {
    return c.json({ error: `${CODEX_AUTH_JSON_SECRET_NAME} is managed by ChatGPT subscription onboarding` }, 400);
  }
  // LLM provider credentials are always project-wide. The gateway resolves
  // BYOK keys from the SHARED row only (getProjectSecretValue), so a personal
  // override would show the provider as connected in the UI while every model
  // turn 400s with "No upstream configured" (2026-07-07 prod incident).
  if (isGatewayManagedEnv(name)) {
    return c.json(
      {
        error: `${name} is an LLM provider credential — provider keys are always project-wide, update the shared value instead`,
        code: 'llm_credentials_project_wide',
      },
      400,
    );
  }

  const value = typeof body.value === 'string' ? body.value : null;
  const active = typeof body.active === 'boolean' ? body.active : undefined;
  if (value === null && active === undefined) {
    return c.json({ error: 'value or active is required' }, 400);
  }

  const [existingMine] = await db
    .select({ secretId: projectSecrets.secretId })
    .from(projectSecrets)
    .where(and(
      eq(projectSecrets.projectId, projectId),
      eq(projectSecrets.name, name),
      eq(projectSecrets.ownerUserId, loaded.userId),
    ))
    .limit(1);

  const now = new Date();
  if (!existingMine) {
    if (value === null) {
      return c.json({ error: 'value is required to create an override' }, 400);
    }
    await db.insert(projectSecrets).values({
      projectId,
      identifier: name,
      name,
      valueEnc: encryptProjectSecret(projectId, value),
      ownerUserId: loaded.userId,
      active: active ?? true,
      createdBy: loaded.userId,
      updatedAt: now,
    });
  } else {
    await db
      .update(projectSecrets)
      .set({
        ...(value !== null ? { valueEnc: encryptProjectSecret(projectId, value) } : {}),
        ...(active !== undefined ? { active } : {}),
        updatedAt: now,
      })
      .where(eq(projectSecrets.secretId, existingMine.secretId));
  }

  void propagateProjectSecretsToActiveSandboxes(projectId, { refreshModels: isGatewayManagedEnv(name) });

  const views = await loadSecretViewsForUser(projectId, loaded.userId, roleAllows(loaded.effectiveRole, 'manage'));
  return c.json(views.find((v) => v.name === name) ?? { name }, 200);
},
);

// DELETE /v1/projects/:projectId/secrets/:name/personal
// Remove the caller's own override for this key (falls back to the shared value).

projectsApp.openapi(
  createRoute({
    method: 'delete',
    path: '/{projectId}/secrets/{name}/personal',
    tags: ['secrets'],
    summary: 'DELETE /:projectId/secrets/:name/personal',
    ...auth,
      request: {
        params: z.object({ projectId: z.string(), name: z.string() }),
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(400, 404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const name = c.req.param('name')?.trim().toUpperCase();
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  if (!name || !isValidSecretName(name)) {
    return c.json({ error: 'Invalid secret name' }, 400);
  }
  if (name === CODEX_AUTH_JSON_SECRET_NAME) {
    return c.json(
      { error: `${CODEX_AUTH_JSON_SECRET_NAME} must be disconnected as an OAuth provider` },
      400,
    );
  }

  await db
    .delete(projectSecrets)
    .where(and(
      eq(projectSecrets.projectId, projectId),
      eq(projectSecrets.name, name),
      eq(projectSecrets.ownerUserId, loaded.userId),
    ));

  void propagateProjectSecretsToActiveSandboxes(projectId, { refreshModels: isGatewayManagedEnv(name) });

  return c.json({ ok: true });
},
);

// POST /v1/projects/:projectId/secrets/sync
// Force a re-push of all project secrets to all active sandboxes. Use after
// setting a secret via the intake link or when secrets are missing from a
// session's environment despite being set in the store.
projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/secrets/sync',
    tags: ['secrets'],
    summary: 'POST /:projectId/secrets/sync — force re-push secrets to active sandboxes',
    ...auth,
    request: { params: z.object({ projectId: z.string() }) },
    responses: {
      200: json(
        z.object({
          ok: z.boolean(),
          active_sandboxes: z.number().int().nonnegative(),
          targeted: z.number().int().nonnegative(),
          synced: z.number().int().nonnegative(),
          failed: z.number().int().nonnegative(),
          exported: z.number().int().nonnegative(),
          results: z.array(z.object({
            session_id: z.string(),
            sandbox_id: z.string().nullable(),
            status: z.enum(['synced', 'failed']),
            scope: z.enum(['inherit', 'restricted', 'none']).nullable(),
            revision: z.string().nullable(),
            exported: z.number().int().nonnegative(),
            managed: z.number().int().nonnegative().nullable(),
            withheld: z.number().int().nonnegative().nullable(),
            agent_env_written: z.boolean(),
            reason: z.string().optional(),
          })),
        }),
        'Secret delivery verification result',
      ),
      ...errors(403, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_SECRET_WRITE);
    const result = await propagateProjectSecretsToActiveSandboxes(projectId);
    return c.json(result);
  },
);

// GET /v1/projects/:projectId/triggers
//
// Lists triggers defined as files in `.opencode/triggers/*.md` on the
// project's default branch, plus any parse errors and runtime state
// (last_fired_at). The repo is the source of truth — POST/PATCH/DELETE
// below commit/update/delete the underlying file.
