import { createRoute, z } from '@hono/zod-openapi';
import { SecretBrokerRequestSchema, SecretBrokerResponseSchema } from '@kortix/api-contract';
import { config } from '../../config';
import { getAgentGrant } from '../../iam/agent-scope';
import { getSessionRuntimeCredential } from '../../middleware/session-sandbox-credential';
import { auth, errors, json } from '../../openapi';
import { requestEgressIp, verifyRuntimeEgressIp } from '../../platform/services/sandbox-egress-pin';
import {
  classifyPresentedHandles,
  requestSurfaceText,
  summarizeHandleRefusals,
} from '../../secrets/handle-substitution';
import { SecretBrokerError, executeSecretBrokerRequest } from '../../secrets/http-broker';
import { authorizeSecretRelay } from '../../secrets/relay-authorize';
import { recordAuditEvent } from '../../shared/audit';
import { loadProjectForUser } from '../lib/access';
import { projectsApp } from '../lib/app';
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
    const runtimeCredential = getSessionRuntimeCredential(c);
    if (
      c.get('authType') !== 'pat' ||
      c.get('tokenProjectId') !== projectId ||
      !sessionId ||
      !runtimeCredential ||
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

    // Is this request coming from the sandbox the session token was issued to?
    //
    // The token lives in the agent's own shell env (it needs it for the CLI and
    // git), so the agent can copy it out. Everything else on this route checks
    // what the token IS; this checks where it is being used FROM. Unpinned
    // sessions pass — see sandbox-egress-pin.ts on why that direction is the
    // safe one.
    const pin = await verifyRuntimeEgressIp(runtimeCredential, requestEgressIp(c));
    if (!pin.ok) {
      // Logged whether or not it blocks, so log-only mode still surfaces the
      // event — a kill switch that also silences the evidence is useless.
      console.warn('[secret-broker] refused an off-sandbox token use', {
        sessionId,
        runtimeKind: runtimeCredential.kind,
        runtimeId: runtimeCredential.runtimeId,
        projectId,
        pinned: pin.pinned,
        seen: pin.seen,
        enforced: config.KORTIX_SANDBOX_EGRESS_PIN_ENFORCED,
      });
    }
    if (!pin.ok && config.KORTIX_SANDBOX_EGRESS_PIN_ENFORCED) {
      return c.json(
        {
          error: 'This session credential may only be used from its own sandbox',
          code: 'sandbox_egress_mismatch',
        },
        403,
      );
    }

    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);

    let destination: URL;
    try {
      destination = new URL(parsed.data.url);
    } catch {
      return c.json({ error: 'Invalid broker URL', code: 'invalid_request' }, 400);
    }
    const shape = {
      host: destination.hostname,
      method: parsed.data.method,
      path: destination.pathname,
    };

    // ONE authorization decision, shared with the streaming relay and the
    // websocket transports (`secrets/relay-authorize.ts`). Everything this
    // route used to inline — the active-session query, the shared/personal
    // secret resolution, the delivery mode, the broker-or-boundary shape, the
    // live handle rows, the handle policy check, and the spendable set — lives
    // there now. Nothing about the wire changed: the same codes, the same
    // statuses, the same audit actions.
    const authz = await authorizeSecretRelay({
      projectId,
      identifier,
      userId: loaded.userId,
      accountId: loaded.row.accountId,
      sessionId,
      agentGrantEnv: agentGrant.env ?? 'all',
      shape,
    });

    // `audit === null` marks the two refusals that happen before the secret row
    // is known, which record no audit row — preserved exactly.
    const auditContext = authz.audit;
    if (!auditContext) {
      if (authz.ok) throw new Error('unreachable: an authorized relay always has an audit context');
      return authz.code === 'secret_not_found'
        ? c.json({ error: authz.message }, 404)
        : c.json({ error: authz.message, code: authz.code }, 403);
    }

    const auditBase = {
      accountId: loaded.row.accountId,
      projectId,
      sessionId,
      actorUserId: loaded.userId,
      actorType: 'agent' as const,
      source: 'agent',
      resourceType: 'project_secret',
      resourceId: auditContext.secretId,
      metadata: {
        identifier,
        // Derived, not hardcoded: this route now serves the network boundary as
        // well as the HTTP broker, and an audit row that calls every boundary
        // relay `http_broker` would misattribute the delivery mode in the one
        // record anybody reviews after an incident.
        consumer: auditContext.strategy === 'egress' ? 'network' : 'http_broker',
        strategy: auditContext.strategy,
        host: destination.hostname,
        method: parsed.data.method,
        path: destination.pathname,
      },
    };

    if (!authz.ok) {
      await recordAuditEvent({
        ...auditBase,
        action: 'secret.broker.failed',
        outcome: authz.status === 403 || authz.status === 409 ? 'denied' : 'failure',
        httpStatus: authz.status,
        after: { reason: authz.code },
      });
      return c.json(
        { error: authz.message, code: authz.code },
        authz.status as 400 | 403 | 409 | 413 | 502 | 504,
      );
    }

    try {
      await recordAuditEvent({
        ...auditBase,
        action: 'secret.broker.requested',
        outcome: 'pending',
      });

      const requestBody = parsed.data.body_base64
        ? Buffer.from(parsed.data.body_base64, 'base64')
        : null;
      const spendable = { substitutions: authz.substitutions, facts: authz.facts };

      // Evidence first, on the request as the guest sent it: once substitution
      // has run, an honored handle is gone from the bytes and a refused one is
      // indistinguishable from text that was never a handle.
      const refusals = classifyPresentedHandles(
        requestSurfaceText({
          url: parsed.data.url,
          headers: parsed.data.headers,
          body: requestBody,
        }),
        spendable.facts,
        config.API_KEY_SECRET,
      );
      if (refusals.length > 0) {
        await recordAuditEvent({
          ...auditBase,
          action: 'secret.handle.refused',
          outcome: 'denied',
          after: {
            refusals: summarizeHandleRefusals(refusals),
            detail: refusals,
          },
        });
      }

      const applied = new Set<string>();
      const result = await executeSecretBrokerRequest(authz.policy, authz.secret, parsed.data, {
        substitutions: spendable.substitutions,
        applied,
      });
      await recordAuditEvent({
        ...auditBase,
        action: 'secret.broker.completed',
        outcome: result.status >= 400 ? 'failure' : 'success',
        after: {
          upstream_status: result.status,
          ...(applied.size > 0 ? { substituted: [...applied].sort() } : {}),
          ...(refusals.length > 0 ? { handle_refusals: summarizeHandleRefusals(refusals) } : {}),
        },
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
