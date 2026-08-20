import { createHash } from 'node:crypto';
import {
  SecretBrokerRequestSchema,
  SecretBrokerResponseSchema,
} from '@kortix/api-contract';
import {
  projectSecrets,
  projectSessionSecretHandles,
  projectSessions,
  type SecretEgressPolicy,
} from '@kortix/db';
import { createRoute, z } from '@hono/zod-openapi';
import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import { getAgentGrant } from '../../iam/agent-scope';
import { auth, errors, json } from '../../openapi';
import {
  executeSecretBrokerRequest,
  SecretBrokerError,
  type SecretSubstitution,
} from '../../secrets/http-broker';
import {
  classifyPresentedHandles,
  requestSurfaceText,
  summarizeHandleRefusals,
  type SessionHandleFacts,
} from '../../secrets/handle-substitution';
import { networkBoundaryPolicyError } from '../../secrets/network-boundary';
import {
  matchRule,
  mintHandle,
  parseHandle,
  resolveSecretDelivery,
  type OutboundRequestShape,
} from '../../secrets/strategy';
import { recordAuditEvent } from '../../shared/audit';
import { db } from '../../shared/db';
import { decryptProjectSecret, intersectSecretGrants } from '../secrets';
import { config } from '../../config';
import { loadProjectForUser } from '../lib/access';
import {
  requestEgressIp,
  verifySandboxEgressIp,
} from '../../platform/services/sandbox-egress-pin';
import { projectsApp } from '../lib/app';
import { ACTIVE_SESSION_STATUSES } from '../lib/session-status';
import { readBody } from '../lib/serializers';

/** One active handle row, as this route reads it. */
interface LiveSessionHandle {
  secretId: string;
  identifier: string;
  lookupId: string;
  handleHash: string;
  policySnapshot: SecretEgressPolicy;
  expiresAt: Date | null;
}

/**
 * Turn this session's active handles into the substitution set for ONE request.
 *
 * Two outputs, deliberately separate:
 *
 *  - `substitutions` — the handles that may be spent on this destination, with
 *    their real values. Only these secrets are decrypted; a handle the grant
 *    excludes or the policy does not admit never reaches the decrypt path.
 *  - `facts` — what is known about EVERY active handle, keyed by lookup id, so
 *    a handle that turns up in the request but is not substituted can still be
 *    classified (stolen vs merely out-of-policy) instead of vanishing.
 *
 * The handle string is rebuilt from the stored lookup id and the secret's
 * prefix, then checked against the stored hash: the hash is what the row
 * committed to at mint time, so a prefix edited afterwards produces a handle
 * that no longer matches and is skipped rather than substituted for the wrong
 * bytes. The tag is verified on top of that — this is the ONE place a handle
 * becomes spendable, so it is the place both checks belong.
 */
async function resolveSpendableHandles(input: {
  projectId: string;
  userId: string;
  sessionId: string;
  handles: readonly LiveSessionHandle[];
  effectiveGrantEnv: string[] | 'all' | undefined;
  shape: OutboundRequestShape;
}): Promise<{
  substitutions: SecretSubstitution[];
  facts: Map<string, SessionHandleFacts>;
}> {
  const facts = new Map<string, SessionHandleFacts>();
  const substitutions: SecretSubstitution[] = [];
  const identifiers = [...new Set(input.handles.map((row) => row.identifier))];
  if (identifiers.length === 0) return { substitutions, facts };

  const secretRows = await db
    .select({
      secretId: projectSecrets.secretId,
      identifier: projectSecrets.identifier,
      ownerUserId: projectSecrets.ownerUserId,
      valueEnc: projectSecrets.valueEnc,
      active: projectSecrets.active,
      strategy: projectSecrets.strategy,
      handlePrefix: projectSecrets.handlePrefix,
    })
    .from(projectSecrets)
    .where(
      and(
        eq(projectSecrets.projectId, input.projectId),
        eq(projectSecrets.scope, 'runtime'),
        inArray(projectSecrets.identifier, identifiers),
        or(isNull(projectSecrets.ownerUserId), eq(projectSecrets.ownerUserId, input.userId)),
      ),
    );

  // Same resolution as `listResolvedProjectSecrets`: the SHARED row carries the
  // policy the handle was minted from, the member's own active row carries the
  // value that was actually delivered to the sandbox. Substituting the shared
  // value for a member who overrides it would send the wrong credential.
  type SecretRow = (typeof secretRows)[number];
  const byIdentifier = new Map<string, { shared?: SecretRow; personal?: SecretRow }>();
  for (const row of secretRows) {
    const slot = byIdentifier.get(row.identifier) ?? {};
    if (row.ownerUserId === null) slot.shared = row;
    else if (row.active) slot.personal = row;
    byIdentifier.set(row.identifier, slot);
  }

  for (const row of input.handles) {
    const slot = byIdentifier.get(row.identifier);
    const shared = slot?.shared;
    const delivery = shared
      ? resolveSecretDelivery({
          identifier: row.identifier,
          strategy: shared.strategy,
          agentGrantEnv: input.effectiveGrantEnv ?? null,
          sessionAllowlist: null,
          sessionId: input.sessionId,
        })
      : null;
    const spendable =
      !!shared && shared.secretId === row.secretId && delivery?.emit === 'handle';
    const hostAdmitted = matchRule(row.policySnapshot, input.shape) !== null;
    facts.set(row.lookupId, { identifier: row.identifier, spendable, hostAdmitted });
    if (!spendable || !hostAdmitted || !shared) continue;

    const handle = mintHandle({
      lookupId: row.lookupId,
      prefix: shared.handlePrefix,
      rootSecret: config.API_KEY_SECRET,
    });
    if (createHash('sha256').update(handle).digest('hex') !== row.handleHash) {
      console.warn('[secret-broker] skipped a handle whose stored hash no longer matches', {
        projectId: input.projectId,
        sessionId: input.sessionId,
        identifier: row.identifier,
      });
      continue;
    }
    if (!parseHandle(handle, config.API_KEY_SECRET).ok) continue;
    substitutions.push({
      identifier: row.identifier,
      handle,
      value: decryptProjectSecret(input.projectId, (slot?.personal ?? shared).valueEnc),
      policy: row.policySnapshot,
    });
  }
  return { substitutions, facts };
}

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

    // Is this request coming from the sandbox the session token was issued to?
    //
    // The token lives in the agent's own shell env (it needs it for the CLI and
    // git), so the agent can copy it out. Everything else on this route checks
    // what the token IS; this checks where it is being used FROM. Unpinned
    // sessions pass — see sandbox-egress-pin.ts on why that direction is the
    // safe one.
    const pin = await verifySandboxEgressIp(sessionId, requestEgressIp(c));
    if (!pin.ok) {
      // Logged whether or not it blocks, so log-only mode still surfaces the
      // event — a kill switch that also silences the evidence is useless.
      console.warn('[secret-broker] refused an off-sandbox token use', {
        sessionId,
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

      // Every active handle this SESSION holds, not just the route's own.
      //
      // Substitution has to answer two questions the single-secret lookup
      // cannot: which other handles in this request may be spent here, and —
      // for the ones that may not — whether they were forged or merely
      // carried in from somewhere else. Both need the whole set, and one query
      // is cheaper than one per handle found.
      const handleRows = await db
        .select({
          secretId: projectSessionSecretHandles.secretId,
          identifier: projectSessionSecretHandles.identifier,
          lookupId: projectSessionSecretHandles.lookupId,
          handleHash: projectSessionSecretHandles.handleHash,
          policySnapshot: projectSessionSecretHandles.policySnapshot,
          expiresAt: projectSessionSecretHandles.expiresAt,
        })
        .from(projectSessionSecretHandles)
        .where(
          and(
            eq(projectSessionSecretHandles.projectId, projectId),
            eq(projectSessionSecretHandles.sessionId, sessionId),
            eq(projectSessionSecretHandles.status, 'active'),
          ),
        )
        .orderBy(desc(projectSessionSecretHandles.revision));

      // Highest revision wins per secret: rotation leaves the previous
      // revision active for an overlap window rather than killing it mid-turn,
      // and both are spendable — but only the newest is THE handle for the
      // route's own secret.
      const liveHandles = handleRows.filter(
        (row) => row.expiresAt === null || row.expiresAt.getTime() > Date.now(),
      );
      const handle = liveHandles.find((row) => row.secretId === shared.secretId);
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
      // Expiry is already applied — `liveHandles` is the filter — so this is
      // the presence and policy check only.
      if (!handle || !handlePolicyValid) {
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

      // Which of this session's handles may be spent on THIS destination.
      //
      // The resolution is the same one the route already applied to its own
      // secret — the agent grant intersected with the session allowlist, then
      // the handle's FROZEN policy snapshot matched against the request.
      // Substitution must never widen who may spend: a handle the sandbox
      // holds but this agent may not use is left in the request as the
      // worthless self-describing string it is.
      const requestBody = parsed.data.body_base64
        ? Buffer.from(parsed.data.body_base64, 'base64')
        : null;
      const shape = {
        host: destination.hostname,
        method: parsed.data.method,
        path: destination.pathname,
      };
      const spendable = await resolveSpendableHandles({
        projectId,
        userId: loaded.userId,
        sessionId,
        handles: liveHandles,
        effectiveGrantEnv,
        shape,
      });

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

      // The route's own secret is part of the spendable set — it is one of this
      // session's handles like any other — so reuse the value that resolution
      // already produced instead of decrypting the same row twice.
      const primary = spendable.substitutions.find((entry) => entry.identifier === identifier);
      const encryptedValue = personal?.valueEnc ?? shared.valueEnc;
      const secret = primary?.value ?? decryptProjectSecret(projectId, encryptedValue);
      const applied = new Set<string>();
      const result = await executeSecretBrokerRequest(handle.policySnapshot, secret, parsed.data, {
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
