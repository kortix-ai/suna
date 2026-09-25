/** Secret delivery strategy: `PUT /:projectId/secrets/:identifier/strategy`. */
import { PROJECT_ACTIONS } from '../../iam';
import { isProjectSessionPrincipal } from '../../iam/agent-scope';
import { auth, errors, json } from '../../openapi';
import { inferAuditSource, runAuditedTransaction } from '../../shared/audit';
import { db } from '../../shared/db';
import { isValidIdentifier } from '../secrets';
import { propagateProjectSecretsToActiveSandboxes } from '../lib/sandbox-env-sync';
import { isGatewayManagedEnv } from '../../llm-gateway/sandbox-credentials';
import { createRoute, z } from '@hono/zod-openapi';
import { UpdateSecretStrategyInputSchema } from '@kortix/api-contract';
import { parseEgressPolicy } from '../../secrets/strategy';
import { featureDisabledBody } from '../../feature-flags/gate';
import { resolveFeatureFlag } from '../../feature-flags/registry';
import { networkBoundaryPolicyError } from '../../secrets/network-boundary';
import { projectSecrets, projectSessionSecretHandles } from '@kortix/db';
import { and, eq, isNull } from 'drizzle-orm';
import {
  loadProjectForUser,
  assertProjectCapability,
} from '../lib/access';
import { projectsApp } from '../lib/app';
import { isSystemProjectSecretName, loadSecretViewsForUser } from '../lib/serializers';
import { readJsonObject } from '../../shared/http-body';
import {
  SecretWriteResultSchema,
  type SecretDeliverySync,
  boundaryConflictBody,
  boundaryDestinationConflict,
  connectorSecretBindings,
  summarizeDeliverySync,
} from '../lib/secret-writes';

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
    const parsed = UpdateSecretStrategyInputSchema.safeParse(await readJsonObject(c));
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
    if (isProjectSessionPrincipal(c)) {
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
    // Network-Enforced Secrets (`secrets_egress`) is experimental and off by
    // default. Moving a secret INTO egress delivery needs the flag; a secret
    // already on egress can still be edited or moved OFF it, so turning the
    // flag off never strands one.
    if (
      parsed.data.strategy === 'egress' &&
      existing.strategy !== 'egress' &&
      !resolveFeatureFlag(loaded.row.metadata, 'secrets_egress')
    ) {
      return c.json(featureDisabledBody('secrets_egress'), 403);
    }
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

    const views = await loadSecretViewsForUser({
    projectId,
    userId: loaded.userId,
    canManageShared: true,
  });
    const view = views.find((item) => item.identifier === identifier);
    if (!view) return c.json({ error: 'Not found' }, 404);

    return c.json({ ...view, delivery_sync: deliverySync }, 200);
  },
);
