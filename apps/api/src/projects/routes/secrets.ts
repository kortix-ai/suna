/**
 * Project secrets: list, create, delete. The personal-override routes live in
 * secret-personal.ts and the sandbox-sync route in secret-sync.ts;
 * registerSecretsRoutes() registers both, after its secret-write rate limit.
 * The create handler's validation ladder lives in
 * lib/secret-write-input.ts.
 */
import { randomUUID } from 'node:crypto';
import { PROJECT_ACTIONS } from '../../iam';
import { agentMayUseEnv, getAgentGrant, isBorrowedSessionPrincipal, isProjectSessionPrincipal } from '../../iam/agent-scope';
import { auth, errors, json, lenientBody } from '../../openapi';
import {
  SecretConsumerSchema,
  SecretDeliveryStrategySchema,
  SecretEgressPolicySchema,
} from '@kortix/api-contract';
import { inferAuditSource, runAuditedTransaction } from '../../shared/audit';
import { db } from '../../shared/db';
import { roleAllows } from '../access';
import { loadProjectConfig } from '../git';
import { requestPersonalOwner } from '../lib/personal-resources';
import {
  encryptProjectSecret,
  identifierKeyConflicts,
  isValidIdentifier,
} from '../secrets';
import { propagateProjectSecretsToActiveSandboxes } from '../lib/sandbox-env-sync';
import { isGatewayManagedEnv } from '../../llm-gateway/sandbox-credentials';
import { seedProjectDefaultModelOnConnect } from '../../llm-gateway/models/seed-default';
import { projectLlmGatewayEnabled } from '../../llm-gateway/enablement';
import { createRoute, z } from '@hono/zod-openapi';
import { featureDisabledBody } from '../../feature-flags/gate';
import { resolveFeatureFlag } from '../../feature-flags/registry';
import { projectSecrets } from '@kortix/db';
import { and, eq, isNull } from 'drizzle-orm';
import {
  loadProjectForUser,
  assertProjectCapability,
} from '../lib/access';
import { SecretSchema, projectsApp } from '../lib/app';
import { withProjectGitAuth } from '../lib/git';
import {
  CODEX_AUTH_JSON_SECRET_NAME,
  isSystemProjectSecretName,
  isTeamsInstallSecretName,
  loadSecretViewsForUser,
  type SecretAgentGrantConfig,
} from '../lib/serializers';
import { readJsonObject } from '../../shared/http-body';
import {
  SecretWriteResultSchema,
  type SecretDeliverySync,
  boundaryConflictBody,
  boundaryDestinationConflict,
  connectorSecretBindings,
  summarizeDeliverySync,
} from '../lib/secret-writes';
import { resolveSecretWriteInput } from '../lib/secret-write-input';
import { callerKortixSessionId } from '../lib/caller-session';
import { loadConnectionSharing } from '../lib/connection-sharing';
import {
  clearSecretAudience,
  loadSecretReach,
  secretAudienceSubject,
  setSecretAudience,
  type SecretAudiencePrincipal,
} from '../lib/secret-audience';

import { registerSecretRateLimitRoutes } from './secret-rate-limit';
import { registerSecretPersonalRoutes } from './secret-personal';
import { registerSecretSyncRoutes } from './secret-sync';

const SecretSharePrincipalSchema = z.object({
  /** `agent`: the id is the agent's service account (`/iam/agent-identities`). */
  principal_type: z.enum(['user', 'group', 'agent']),
  principal_id: z.string().uuid(),
});

/** `shared_with` of a secret write: null = leave the audience unchanged. */
function parseSecretSharedWith(
  raw: unknown,
): { ok: true; value: SecretAudiencePrincipal[] | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  const parsed = z.array(SecretSharePrincipalSchema).max(50).safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error:
        'shared_with must be a list of at most 50 { principal_type: "user" | "group" | "agent", principal_id: <uuid> }',
    };
  }
  const unique = new Map(parsed.data.map((p) => [`${p.principal_type}:${p.principal_id}`, p]));
  return { ok: true, value: [...unique.values()] };
}

export function registerSecretsRoutes(): void {
  // Route registration order is dispatch order in Hono: the write rate limit
  // must register before every secrets route, so it goes first.
  registerSecretRateLimitRoutes();
  registerSecretPersonalRoutes();
  registerSecretSyncRoutes();

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
      summary: 'List project secrets (names only, no values)',
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
              agent_scope: z
                .object({
                  agent: z.string(),
                  secrets: z.union([z.literal('all'), z.array(z.string())]),
                })
                .nullable(),
            }),
            'Secret configuration metadata',
          ),
          ...errors(404),
      },
    }),
    async (c: any) => {
    const projectId = c.req.param('projectId');
    const started = performance.now();
    const stages: Record<string, number> = {};
    const loaded = await loadProjectForUser(c, projectId, 'read');
    stages.project = Math.round(performance.now() - started);
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    // Leaf-gate the read (a custom role can omit project.secret.read) — and, via
    // the central agent-grant fold, an agent token must hold it in its Kortix permissions.
    await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_SECRET_READ);

    stages.capability = Math.round(performance.now() - started);
    const canManageShared = roleAllows(loaded.effectiveRole, 'manage');

    // Manifest is optional — a project without kortix.yaml just gets empty
    // required/optional lists. We surface loaded/missing/error explicitly so the
    // UI can distinguish "no envs declared" from "we couldn't read the manifest".
    let required: string[] = [];
    let optional: string[] = [];
    let manifestStatus: 'loaded' | 'missing' | 'error';
    let manifestError: string | null = null;
    // The same load answers `delivery_blocked_reason` (which agents may receive an
    // egress/broker secret). Threading the config costs no extra I/O; leaving it
    // null on a failed load is what keeps the warning from firing on a guess.
    let agentGrants: SecretAgentGrantConfig | null = null;
    // Independent of the manifest load below (an IAM/agent-principal reach
    // check, no git or manifest dependency) — start it now instead of after the
    // manifest read finishes, so its latency overlaps the git-auth resolve +
    // manifest read instead of adding to it (measured prod: git 383ms/14 ops
    // dominates this route's server time).
    const personalOwnerPromise = requestPersonalOwner(c, loaded);
    try {
      const gitRow = await withProjectGitAuth(loaded.row);
      stages.git_auth = Math.round(performance.now() - started);
      const projectConfig = await loadProjectConfig(gitRow, []);
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

    stages.manifest = Math.round(performance.now() - started);

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

    const viewItems = (await loadSecretViewsForUser({
      projectId,
      // Spec 2026-09-22 §2.3: an agent-principal session sees personal
      // overrides of its on-behalf-of human in a private session only.
      userId: await personalOwnerPromise,
      canManageShared,
      agentGrants,
    }))
      .filter((item) => !item.system)
      .filter((item) => agentMayUseEnv(agentGrant, item.identifier));

    // Audience of each shared value, for the person and agent this read acts
    // for. A value
    // narrowed away from the caller stays listed for someone who manages shared
    // secrets from outside a session (so they can widen it again), marked
    // `usable: false`; a session never sees it — it could not use it anyway.
    const callerSessionId = callerKortixSessionId(c);
    const [sharing, reachOf] = await Promise.all([
      loadConnectionSharing({
        projectId,
        accountId: loaded.row.accountId,
        projectName: loaded.row.name,
        objectType: 'secret',
      }),
      secretAudienceSubject({
        projectId,
        accountId: loaded.row.accountId,
        sessionId: callerSessionId,
        actorUserId: loaded.userId,
      }).then((subject) => loadSecretReach({ projectId, accountId: loaded.row.accountId, subject })),
    ]);
    const items = viewItems
      .map((item) => ({
        ...item,
        shared_with: item.secret_id ? (sharing.get(item.secret_id) ?? []) : [],
        usable: !item.secret_id || reachOf(item.secret_id) !== 'out',
      }))
      .filter((item) => item.usable || (canManageShared && !callerSessionId));

    const elapsed = Math.round(performance.now() - started);
    if (elapsed >= 3_000) {
      console.warn('[projects] secrets: slow read', {
        project_ms: stages.project,
        capability_ms: stages.capability - stages.project,
        git_auth_ms: (stages.git_auth ?? stages.manifest) - stages.capability,
        manifest_ms: stages.manifest - (stages.git_auth ?? stages.manifest),
        secrets_ms: elapsed - stages.manifest,
      });
    }

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
      // The caller's OWN secrets grant (null for a non-agent caller). `items` is
      // filtered by it, and without saying so a client could only report a
      // declared-but-filtered name as "missing" — the agent then tells the human
      // a saved secret is unset. This is the caller's own policy, not a list of
      // what exists, so it widens nothing an agent can enumerate.
      agent_scope: agentGrant ? { agent: agentGrant.agent, secrets: agentGrant.env ?? 'all' } : null,
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
      summary: 'Set a project secret',
      description:
        'Create or update a project secret by `name` (upper-cased; A-Z, 0-9, _; max 64; KORTIX_* is reserved). The value is write-only: responses never echo it.',
      ...auth,
        request: {
          params: z.object({ projectId: z.string() }),
          body: {
            content: {
              'application/json': {
                schema: lenientBody({
                  name: z.string().openapi({ description: 'Env var name, e.g. OPENAI_API_KEY' }),
                  value: z.string().optional().openapi({
                    description: 'Secret value. Required when creating; omit to change only delivery settings.',
                  }),
                  identifier: z.string().optional().openapi({
                    description: 'Handle agents grant and the UI shows (A-Z, 0-9, _, ., -; max 128). Defaults to name.',
                  }),
                  strategy: SecretDeliveryStrategySchema.optional().openapi({
                    description: 'Delivery mode: runtime, egress, broker, or denied.',
                  }),
                  consumer: SecretConsumerSchema.nullable().optional(),
                  egress_policy: SecretEgressPolicySchema.optional(),
                  handle_prefix: z.string().optional().openapi({ description: 'For consumer http_broker only.' }),
                  shared_with: z.array(SecretSharePrincipalSchema).max(50).optional().openapi({
                    description:
                      'Who can use this value: people, groups, and agents (their service-account id). [] = everyone in the project. Omit to keep it unchanged. A person sets it; an agent session gets 403.',
                  }),
                }),
              },
            },
          },
        },
      responses: {
          200: json(SecretWriteResultSchema, 'The created secret'),
          ...errors(400, 404, 409),
      },
    }),
    async (c: any) => {
    const projectId = c.req.param('projectId');
    const body = await readJsonObject(c);
    const loaded = await loadProjectForUser(c, projectId, 'manage');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_SECRET_WRITE);

    const resolved = resolveSecretWriteInput(body, isBorrowedSessionPrincipal(c));
    if (!resolved.ok) return c.json(resolved.body, resolved.status);
    const { name, identifier, value, explicitStrategy, explicitConsumer, explicitPolicy, explicitHandlePrefix } =
      resolved.input;
    const sharedWith = parseSecretSharedWith(body.shared_with);
    if (!sharedWith.ok) return c.json({ error: sharedWith.error }, 400);
    if (sharedWith.value && isBorrowedSessionPrincipal(c)) {
      return c.json(
        { error: 'An agent cannot change who can use a secret. A person changes it in Customize → Secrets.' },
        403,
      );
    }

    // The one ladder check that needs the database: a policy that parses and
    // passes the boundary rules can still claim a (host, header) destination
    // another network secret already pins. Network always carries the parsed
    // policy — resolveSecretWriteInput returns ok with it.
    if (explicitConsumer === 'network') {
      const conflict = await boundaryDestinationConflict(projectId, identifier, explicitPolicy!);
      if (conflict) return c.json(boundaryConflictBody(identifier, conflict), 409);
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

    // A NEW secret narrowed to an audience: write the audience first, under the
    // id the row will get, so the value is never open to everyone in between.
    const pendingSecretId =
      !existing && value !== null && sharedWith.value && sharedWith.value.length > 0 ? randomUUID() : null;
    if (pendingSecretId) {
      await setSecretAudience({
        accountId: loaded.row.accountId,
        projectId,
        secretId: pendingSecretId,
        principals: sharedWith.value!,
        grantedBy: loaded.userId,
        pending: true,
      });
    }

    const now = new Date();
    const actorType =
      c.get('authType') === 'service_account'
        ? 'service_account'
        : isProjectSessionPrincipal(c)
          ? 'agent'
          : 'human';
    let writtenSecretId: string;
    try {
      writtenSecretId = await runAuditedTransaction(
        async (tx) => {
          if (value !== null) {
            const [row] = await tx
              .insert(projectSecrets)
              .values({
                ...(pendingSecretId ? { secretId: pendingSecretId } : {}),
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
    } catch (error) {
      if (pendingSecretId) {
        await clearSecretAudience({ accountId: loaded.row.accountId, projectId, secretId: pendingSecretId });
      }
      throw error;
    }
    if (pendingSecretId && writtenSecretId !== pendingSecretId) {
      // A concurrent create won the identifier: its row keeps its own id.
      await clearSecretAudience({ accountId: loaded.row.accountId, projectId, secretId: pendingSecretId });
    }
    if (sharedWith.value && writtenSecretId !== pendingSecretId) {
      await setSecretAudience({
        accountId: loaded.row.accountId,
        projectId,
        secretId: writtenSecretId,
        principals: sharedWith.value,
        grantedBy: loaded.userId,
      });
    }

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
      summary: 'Delete a project secret',
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
    if (isTeamsInstallSecretName(identifier)) {
      return c.json({ error: `${identifier} is managed by the Microsoft Teams connection. Disconnect Teams instead.` }, 403);
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
      if (isBorrowedSessionPrincipal(c) && existing.strategy && existing.strategy !== 'runtime') {
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
      // No dead audience grant outlives its value.
      await clearSecretAudience({ accountId: loaded.row.accountId, projectId, secretId: existing.secretId });
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
}

