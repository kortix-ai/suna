import {
  SecretBrokerRequestSchema,
  SecretBrokerResponseSchema,
} from '@kortix/api-contract';
import { projectSecrets, projectSessionSecretHandles, projectSessions } from '@kortix/db';
import { createRoute, z } from '@hono/zod-openapi';
import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import { getAgentGrant } from '../../iam/agent-scope';
import { auth, errors, json } from '../../openapi';
import {
  executeSecretBrokerRequest,
  SecretBrokerError,
} from '../../secrets/http-broker';
import { networkBoundaryPolicyError } from '../../secrets/network-boundary';
import { resolveSecretDelivery } from '../../secrets/strategy';
import { recordAuditEvent } from '../../shared/audit';
import { db } from '../../shared/db';
import { decryptProjectSecret, intersectSecretGrants } from '../secrets';
import { loadProjectForUser } from '../lib/access';
import { projectsApp } from '../lib/app';
import { ACTIVE_SESSION_STATUSES } from '../lib/session-status';
import { readBody } from '../lib/serializers';

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/secrets/{identifier}/broker',
    tags: ['secrets'],
    summary: 'Send one policy-bound HTTPS request without exposing the secret',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), identifier: z.string() }),
      body: { content: { 'application/json': { schema: SecretBrokerRequestSchema } } },
    },
    responses: {
      200: json(SecretBrokerResponseSchema, 'Upstream response'),
      ...errors(400, 403, 404, 409, 413, 502, 504),
    },
  }),
  async (c) => {
    const projectId = c.req.param('projectId');
    const identifier = c.req.param('identifier')?.trim();
    const parsed = SecretBrokerRequestSchema.safeParse(await readBody(c));
    if (!identifier || !parsed.success) {
      return c.json({ error: 'Invalid broker request', code: 'invalid_request' }, 400);
    }

    const agentGrant = getAgentGrant(c);
    const sessionId = c.get('sessionId');
    if (
      c.get('authType') !== 'pat' ||
      c.get('tokenProjectId') !== projectId ||
      !sessionId ||
      !agentGrant
    ) {
      return c.json(
        {
          error: 'Secret broker requests require a session-scoped agent token',
          code: 'session_agent_token_required',
        },
        403,
      );
    }

    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);

    const [session] = await db
      .select({
        sessionId: projectSessions.sessionId,
        secretsAllowlist: projectSessions.secretsAllowlist,
      })
      .from(projectSessions)
      .where(
        and(
          eq(projectSessions.sessionId, sessionId),
          eq(projectSessions.projectId, projectId),
          eq(projectSessions.accountId, loaded.row.accountId),
          inArray(projectSessions.status, [...ACTIVE_SESSION_STATUSES]),
        ),
      )
      .limit(1);
    if (!session) {
      return c.json({ error: 'Active project session not found', code: 'session_not_active' }, 403);
    }

    const rows = await db
      .select({
        secretId: projectSecrets.secretId,
        ownerUserId: projectSecrets.ownerUserId,
        valueEnc: projectSecrets.valueEnc,
        active: projectSecrets.active,
        strategy: projectSecrets.strategy,
        egressPolicy: projectSecrets.egressPolicy,
      })
      .from(projectSecrets)
      .where(
        and(
          eq(projectSecrets.projectId, projectId),
          eq(projectSecrets.identifier, identifier),
          eq(projectSecrets.scope, 'runtime'),
          or(isNull(projectSecrets.ownerUserId), eq(projectSecrets.ownerUserId, loaded.userId)),
        ),
      );
    const shared = rows.find((row) => row.ownerUserId === null);
    const personal = rows.find((row) => row.ownerUserId === loaded.userId && row.active);
    if (!shared) return c.json({ error: 'Not found' }, 404);

    let destination: URL;
    try {
      destination = new URL(parsed.data.url);
    } catch {
      return c.json({ error: 'Invalid broker URL', code: 'invalid_request' }, 400);
    }
    const auditBase = {
      accountId: loaded.row.accountId,
      projectId,
      sessionId,
      actorUserId: loaded.userId,
      actorType: 'agent' as const,
      source: 'agent',
      resourceType: 'project_secret',
      resourceId: shared.secretId,
      metadata: {
        identifier,
        // Derived, not hardcoded: this route now serves the network boundary as
        // well as the HTTP broker, and an audit row that calls every boundary
        // relay `http_broker` would misattribute the delivery mode in the one
        // record anybody reviews after an incident.
        consumer: shared.strategy === 'egress' ? 'network' : 'http_broker',
        strategy: shared.strategy,
        host: destination.hostname,
        method: parsed.data.method,
        path: destination.pathname,
      },
    };

    try {
      const effectiveGrantEnv = intersectSecretGrants(
        agentGrant.env ?? 'all',
        session.secretsAllowlist,
      );
      const delivery = resolveSecretDelivery({
        identifier,
        strategy: shared.strategy,
        agentGrantEnv: effectiveGrantEnv,
        sessionAllowlist: null,
        sessionId,
      });
      if (delivery.emit !== 'handle') {
        const reason = delivery.emit === 'nothing' ? delivery.reason : 'strategy_not_brokered';
        throw new SecretBrokerError(
          'policy_denied',
          `secret delivery denied: ${reason}`,
          403,
        );
      }
      // Two delivery modes reach this engine, and they are the same engine on
      // purpose:
      //
      //  - `broker`/`kortix_fetch` — the agent calls the route itself
      //    (`kortix secrets call`, the `secret_call` MCP tool).
      //  - `egress`/`network` — a network-boundary secret on a provider with no
      //    credential edge of its own. The in-guest shim terminates the guest's
      //    TLS and relays here, so the credential stays server-side exactly as
      //    it does for the broker.
      //
      // A boundary policy is already a `SecretEgressPolicy` and
      // `prepareSecretBrokerRequest` reads only `rules` and `inject` — never
      // `backend` — so it executes unchanged. `networkBoundaryPolicyError` is
      // re-checked here rather than trusted from save time: the row could have
      // been written by an older build, and a policy that is not a valid
      // boundary must not be executed as one.
      const isBrokerSecret =
        shared.strategy === 'broker' && shared.egressPolicy?.backend === 'kortix_fetch';
      const isBoundarySecret =
        shared.strategy === 'egress' &&
        !!shared.egressPolicy &&
        networkBoundaryPolicyError(shared.egressPolicy) === null;
      if (!isBrokerSecret && !isBoundarySecret) {
        await recordAuditEvent({
          ...auditBase,
          action: 'secret.broker.failed',
          outcome: 'denied',
          httpStatus: 409,
          after: { reason: 'secret_delivery_unavailable' },
        });
        return c.json(
          {
            error: 'Secret is not configured for the HTTPS broker',
            code: 'secret_delivery_unavailable',
          },
          409,
        );
      }

      const [handle] = await db
        .select({
          policySnapshot: projectSessionSecretHandles.policySnapshot,
          expiresAt: projectSessionSecretHandles.expiresAt,
        })
        .from(projectSessionSecretHandles)
        .where(
          and(
            eq(projectSessionSecretHandles.projectId, projectId),
            eq(projectSessionSecretHandles.sessionId, sessionId),
            eq(projectSessionSecretHandles.secretId, shared.secretId),
            eq(projectSessionSecretHandles.status, 'active'),
          ),
        )
        .orderBy(desc(projectSessionSecretHandles.revision))
        .limit(1);
      // The snapshot must match the delivery mode this request is being served
      // under. A broker secret's snapshot carries `kortix_fetch`; a boundary
      // policy carries no backend at all — `networkBoundaryPolicyError` rejects
      // one that does — so demanding `kortix_fetch` of both would make a
      // boundary handle permanently invalid.
      //
      // Still checked, not skipped: the snapshot is what the request is
      // executed against, so a row whose policy is neither shape must not be
      // spent.
      const handlePolicyValid = handle
        ? isBoundarySecret
          ? networkBoundaryPolicyError(handle.policySnapshot) === null
          : handle.policySnapshot.backend === 'kortix_fetch'
        : false;
      if (
        !handle ||
        (handle.expiresAt !== null && handle.expiresAt.getTime() <= Date.now()) ||
        !handlePolicyValid
      ) {
        await recordAuditEvent({
          ...auditBase,
          action: 'secret.broker.failed',
          outcome: 'denied',
          httpStatus: 409,
          after: { reason: 'session_secret_handle_required' },
        });
        return c.json(
          {
            error: 'The active session does not have this brokered secret',
            code: 'session_secret_handle_required',
          },
          409,
        );
      }

      await recordAuditEvent({
        ...auditBase,
        action: 'secret.broker.requested',
        outcome: 'pending',
      });
      const encryptedValue = personal?.valueEnc ?? shared.valueEnc;
      const secret = decryptProjectSecret(projectId, encryptedValue);
      const result = await executeSecretBrokerRequest(
        handle.policySnapshot,
        secret,
        parsed.data,
      );
      await recordAuditEvent({
        ...auditBase,
        action: 'secret.broker.completed',
        outcome: result.status >= 400 ? 'failure' : 'success',
        after: { upstream_status: result.status },
      });
      return c.json(result, 200);
    } catch (error) {
      const brokerError =
        error instanceof SecretBrokerError
          ? error
          : new SecretBrokerError('upstream_failed', 'Secret broker request failed', 502);
      await recordAuditEvent({
        ...auditBase,
        action: 'secret.broker.failed',
        outcome: brokerError.status === 403 ? 'denied' : 'failure',
        httpStatus: brokerError.status,
        after: { reason: brokerError.code },
      });
      return c.json(
        { error: brokerError.message, code: brokerError.code },
        brokerError.status as 400 | 403 | 413 | 502 | 504,
      );
    }
  },
);
