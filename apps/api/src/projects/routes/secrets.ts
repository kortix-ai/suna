/** Project secrets: list, create, delete, personal values, and sandbox sync. */
import { PROJECT_ACTIONS } from '../../iam';
import { agentMayUseEnv, getAgentGrant, isProjectSessionPrincipal } from '../../iam/agent-scope';
import { auth, errors, json } from '../../openapi';
import { inferAuditSource, runAuditedTransaction } from '../../shared/audit';
import { createProjectSecretWriteRateLimitMiddleware } from '../../shared/rate-limit';
import { db } from '../../shared/db';
import { roleAllows } from '../access';
import { loadProjectConfig } from '../git';
import { requestPersonalOwner } from '../lib/personal-resources';
import {
  encryptProjectSecret,
  identifierKeyConflicts,
  isValidIdentifier,
  isValidSecretName,
} from '../secrets';
import { propagateProjectSecretsToActiveSandboxes } from '../lib/sandbox-env-sync';
import { isGatewayManagedEnv } from '../../llm-gateway/sandbox-credentials';
import { seedProjectDefaultModelOnConnect } from '../../llm-gateway/models/seed-default';
import { projectLlmGatewayEnabled } from '../../llm-gateway/enablement';
import { createRoute, z } from '@hono/zod-openapi';
import { SecretConsumerSchema } from '@kortix/api-contract';
import { parseEgressPolicy } from '../../secrets/strategy';
import { featureDisabledBody } from '../../feature-flags/gate';
import { resolveFeatureFlag } from '../../feature-flags/registry';
import { networkBoundaryPolicyError } from '../../secrets/network-boundary';
import { projectSecrets } from '@kortix/db';
import { and, eq, isNull } from 'drizzle-orm';
import {
  loadProjectForUser,
  assertProjectCapability,
} from '../lib/access';
import { AnyObject, SecretSchema, projectsApp } from '../lib/app';
import { withProjectGitAuth } from '../lib/git';
import {
  CODEX_AUTH_JSON_SECRET_NAME,
  isSystemProjectSecretName,
  loadSecretViewsForUser,
  normalizeString,
  readBody,
  type SecretAgentGrantConfig,
} from '../lib/serializers';
import {
  SecretWriteResultSchema,
  type SecretDeliverySync,
  boundaryConflictBody,
  boundaryDestinationConflict,
  connectorSecretBindings,
  summarizeDeliverySync,
} from '../lib/secret-writes';

// Registered before this file's routes so it runs for every secret WRITE
// (including /broker and /sync) and for nothing else. See the middleware's
// doc comment for the 2026-08-21 storm it exists to stop. The pattern is
// concatenated because unit-iam-gate-codemod-pin.test.ts strips block comments
// with a regex, and a literal slash-star inside this string would read as a
// comment-opener and swallow the next hundred lines of this file from its view.
projectsApp.use('/:projectId/secrets/' + '*', createProjectSecretWriteRateLimitMiddleware());

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
  // the central agent-grant fold, an agent token must hold it in its Kortix permissions.
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

  const items = (await loadSecretViewsForUser({
    projectId,
    // Spec 2026-09-22 §2.3: an agent-principal session sees personal
    // overrides of its on-behalf-of human in a private session only.
    userId: await requestPersonalOwner(c, loaded),
    canManageShared,
    agentGrants,
  }))
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
  // Agent sessions must not choose a delivery policy. This mirrors the
  // PUT /:identifier/strategy guard below: an agent-session PAT that can create
  // a secret must not also set egress/broker/denied delivery or an outbound
  // host list, because a later session mints a spendable handle against that
  // policy — widening a host list is exactly the exfil vector. A plain
  // runtime/default secret (no policy field, or an explicit sandbox default)
  // stays allowed, matching existing product behavior.
  if (
    isProjectSessionPrincipal(c) &&
    ((requestedStrategy !== undefined && requestedStrategy !== 'runtime') ||
      (requestedConsumerData !== undefined && requestedConsumerData !== 'sandbox') ||
      body.egress_policy !== undefined)
  ) {
    return c.json({ error: 'Agent sessions cannot change secret delivery policy' }, 403);
  }
  // The server does NOT infer delivery from the secret's NAME.
  //
  // It used to: a create with no `strategy`/`consumer` whose name matched any
  // provider credential env in the models.dev catalogue was stamped
  // `broker`/`llm_gateway`. That catalogue has 204 providers and one of them,
  // `github-copilot`, claims `GITHUB_TOKEN` — so an ordinary GitHub PAT was
  // classified as a model credential and withheld from the sandbox. The user
  // set a secret, the agent could not read it, and nothing said why (prod
  // 2026-08-27). Any name a provider happens to claim had the same problem;
  // carving out one name would only move it.
  //
  // The callers that actually mean "model credential" all say so explicitly —
  // web provider-connect, the custom-provider form, `kortix providers set`, and
  // the Codex OAuth flow, which writes its row directly with `strategyLocked`.
  // Every other caller means "a secret for my sandbox", which is now what they
  // get. The web secrets manager already sent `runtime`/`sandbox` outright, so
  // this also ends a split-brain where the same name landed differently
  // depending on which surface created it.
  const explicitStrategy = requestedStrategy as
    | 'runtime'
    | 'broker'
    | 'egress'
    | 'denied'
    | undefined;
  const explicitConsumer =
    requestedConsumer === undefined
      ? requestedStrategy === 'runtime'
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
  // Network-Enforced Secrets is an experimental feature (`secrets_egress`).
  // With the flag off a project cannot MOVE a secret into egress delivery — a
  // new egress secret, or an existing non-egress one switched to it. A secret
  // that is already egress keeps serving and stays editable, so turning the
  // flag off never strands one. Runtime/broker/denied are unaffected.
  if (
    explicitStrategy === 'egress' &&
    existing?.strategy !== 'egress' &&
    !resolveFeatureFlag(loaded.row.metadata, 'secrets_egress')
  ) {
    return c.json(featureDisabledBody('secrets_egress'), 403);
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
      : isProjectSessionPrincipal(c)
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
  // over an existing default. Gateway projects only: model defaults are a
  // gateway-catalog concept — off-gateway, OpenCode resolves its own default
  // from the keys now in the box, and a seeded wire id would be a dead ref.
  if (value !== null && isGatewayManagedEnv(name) && projectLlmGatewayEnabled(loaded.row.metadata)) {
    void seedProjectDefaultModelOnConnect({
      projectId,
      accountId: loaded.row.accountId,
      userId: loaded.userId,
      secretName: name,
    });
  }

  const views = await loadSecretViewsForUser({
    projectId,
    userId: loaded.userId,
    canManageShared: true,
  });
  const view = views.find((v) => v.identifier === identifier);
  if (!view) {
    throw new Error(`Secret view not found after upsert: ${identifier}`);
  }
  return c.json({ ...view, delivery_sync: deliverySync }, 200);
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
    // Deleting a secret that carries a delivery policy (egress/broker) removes
    // that policy — a policy-affecting operation. Mirror the PUT /strategy and
    // POST guards: an agent session cannot touch the delivery control, only a
    // plain runtime secret. Otherwise an agent could delete a tightly-scoped
    // egress row and re-create it (defeated separately by the POST guard).
    if (isProjectSessionPrincipal(c) && existing.strategy && existing.strategy !== 'runtime') {
      return c.json({ error: 'Agent sessions cannot change secret delivery policy' }, 403);
    }
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
        : isProjectSessionPrincipal(c)
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
  // Spec 2026-09-22 §2.3: an agent-principal session writes a personal
  // override only for its on-behalf-of human, inside a private session.
  if ((await requestPersonalOwner(c, loaded)) !== loaded.userId) {
    return c.json(
      { error: 'This session cannot change a personal secret', code: 'personal_resource_unreachable' },
      403,
    );
  }

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

  const views = await loadSecretViewsForUser({
    projectId,
    userId: loaded.userId,
    canManageShared: roleAllows(loaded.effectiveRole, 'manage'),
  });
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
  // Spec 2026-09-22 §2.3: an agent-principal session writes a personal
  // override only for its on-behalf-of human, inside a private session.
  if ((await requestPersonalOwner(c, loaded)) !== loaded.userId) {
    return c.json(
      { error: 'This session cannot change a personal secret', code: 'personal_resource_unreachable' },
      403,
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
    // Sync force-re-pushes (re-mints) every secret handle into active sandboxes.
    // That is the re-mint half of the policy-widening exfil chain, so an agent
    // session must not trigger it. Mirror the PUT /strategy guard.
    if (isProjectSessionPrincipal(c)) {
      return c.json({ error: 'Agent sessions cannot change secret delivery policy' }, 403);
    }
    const result = await propagateProjectSecretsToActiveSandboxes(projectId);
    return c.json(result);
  },
);
