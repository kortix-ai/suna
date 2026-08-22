/**
 * The CONTEXT-FREE authorization core for spending a secret on an outbound
 * request — the one decision, shared by every transport.
 *
 * Four callers need exactly this verdict and must never disagree about it:
 *
 *   1. the legacy JSON-RPC route  `POST …/secrets/{id}/broker`
 *   2. the streaming relay route  `POST …/secrets/{id}/relay`
 *   3. the websocket ticket mint  `POST …/secrets/{id}/relay/ws-ticket`
 *   4. the websocket UPGRADE, which runs in `Bun.serve`'s `fetch` BEFORE
 *      `app.fetch` and therefore has no Hono `Context` at all
 *
 * (4) is why this file exists in this shape. `loadProjectForUser(c, …)` needs a
 * `Context` and is unreachable from the upgrade handler, so anything that lives
 * only inside a route handler would have to be RE-IMPLEMENTED there — which is
 * the exact mechanism by which a security invariant silently drifts (see the
 * accept-encoding two-list divergence). Everything here takes plain values and
 * returns a plain verdict: one function, four call sites, zero drift.
 *
 * What stays OUTSIDE, deliberately: the PAT/session/agent-grant checks, the
 * sandbox egress pin, and `loadProjectForUser`. Those are transport-level
 * authentication and IAM; they run on the ordinary Hono path, and the websocket
 * upgrade receives their verdict through a signed ticket rather than redoing
 * them.
 *
 * Note: the `KORTIX_RELAY_WS_ENABLED` kill switch was removed from config.ts
 * (never read). Whoever lands the websocket leg (3)+(4) re-adds a kill switch.
 */
import { createHash } from 'node:crypto';
import {
  projectSecrets,
  projectSessionSecretHandles,
  projectSessions,
  type SecretEgressPolicy,
} from '@kortix/db';
import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import { config } from '../config';
import { decryptProjectSecret, intersectSecretGrants } from '../projects/secrets';
import { ACTIVE_SESSION_STATUSES } from '../projects/lib/session-status';
import { db } from '../shared/db';
import type { SessionHandleFacts } from './handle-substitution';
import { SecretBrokerError, type SecretSubstitution } from './http-broker';
import { networkBoundaryPolicyError } from './network-boundary';
import {
  matchRule,
  mintHandle,
  parseHandle,
  resolveSecretDelivery,
  type OutboundRequestShape,
} from './strategy';

/** One active handle row, as this module reads it. */
export interface LiveSessionHandle {
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
export async function resolveSpendableHandles(input: {
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

/** Route-level refusal codes. NOT `SecretBrokerErrorCode` — these predate the
 *  broker engine and are part of the deployed wire contract unchanged. */
export type SecretRelayAuthzCode =
  | 'session_not_active'
  | 'secret_not_found'
  | 'secret_delivery_unavailable'
  | 'session_secret_handle_required'
  | SecretBrokerError['code'];

/** Enough of the secret row to build an audit record, known before the verdict. */
export interface SecretRelayAuditContext {
  secretId: string;
  strategy: string;
}

export interface SecretRelayAuthzOk {
  ok: true;
  audit: SecretRelayAuditContext;
  /** The handle's FROZEN policy snapshot — the policy the request executes
   *  against, never the secret row's current one. */
  policy: SecretEgressPolicy;
  /** The decrypted value for the route's OWN secret. */
  secret: string;
  substitutions: SecretSubstitution[];
  facts: Map<string, SessionHandleFacts>;
  isBoundarySecret: boolean;
}

export interface SecretRelayAuthzDenied {
  ok: false;
  code: SecretRelayAuthzCode;
  message: string;
  status: number;
  /**
   * Null when the refusal happened before the secret row was known (no
   * project secret, or no active session). Those two cases record NO audit row
   * today, and this being null is what preserves that.
   */
  audit: SecretRelayAuditContext | null;
}

export type SecretRelayAuthz = SecretRelayAuthzOk | SecretRelayAuthzDenied;

export interface SecretRelayAuthzInput {
  projectId: string;
  identifier: string;
  /** The resolved caller, from `loadProjectForUser`. */
  userId: string;
  accountId: string;
  sessionId: string;
  /**
   * The agent token's `secrets` grant, RAW.
   *
   * Intersecting it with the session allowlist happens here rather than in the
   * caller: the intersection IS part of the decision, and the session row it
   * needs is already read below. A caller that had to fetch the session itself
   * to compute the input would be a second place the query — and the grant
   * semantics — could drift.
   */
  agentGrantEnv: string[] | 'all';
  /** This hop's destination, for the per-handle policy match. */
  shape: OutboundRequestShape;
}

/**
 * May this session spend this secret on this destination, and with what?
 *
 * Order is load-bearing and matches the legacy route exactly: active session →
 * secret rows → delivery mode → broker-or-boundary shape → live handle rows →
 * handle policy shape → spendable set. Each step's refusal keeps the status
 * code and the wire `code` the deployed daemon already branches on.
 */
export async function authorizeSecretRelay(
  input: SecretRelayAuthzInput,
): Promise<SecretRelayAuthz> {
  const [session] = await db
    .select({
      sessionId: projectSessions.sessionId,
      secretsAllowlist: projectSessions.secretsAllowlist,
    })
    .from(projectSessions)
    .where(
      and(
        eq(projectSessions.sessionId, input.sessionId),
        eq(projectSessions.projectId, input.projectId),
        eq(projectSessions.accountId, input.accountId),
        inArray(projectSessions.status, [...ACTIVE_SESSION_STATUSES]),
      ),
    )
    .limit(1);
  if (!session) {
    return {
      ok: false,
      code: 'session_not_active',
      message: 'Active project session not found',
      status: 403,
      audit: null,
    };
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
        eq(projectSecrets.projectId, input.projectId),
        eq(projectSecrets.identifier, input.identifier),
        eq(projectSecrets.scope, 'runtime'),
        or(isNull(projectSecrets.ownerUserId), eq(projectSecrets.ownerUserId, input.userId)),
      ),
    );
  const shared = rows.find((row) => row.ownerUserId === null);
  const personal = rows.find((row) => row.ownerUserId === input.userId && row.active);
  if (!shared) {
    return { ok: false, code: 'secret_not_found', message: 'Not found', status: 404, audit: null };
  }
  const audit: SecretRelayAuditContext = {
    secretId: shared.secretId,
    strategy: shared.strategy,
  };

  const effectiveGrantEnv = intersectSecretGrants(input.agentGrantEnv, session.secretsAllowlist);
  const delivery = resolveSecretDelivery({
    identifier: input.identifier,
    strategy: shared.strategy,
    agentGrantEnv: effectiveGrantEnv,
    sessionAllowlist: null,
    sessionId: input.sessionId,
  });
  if (delivery.emit !== 'handle') {
    const reason = delivery.emit === 'nothing' ? delivery.reason : 'strategy_not_brokered';
    return {
      ok: false,
      code: 'policy_denied',
      message: `secret delivery denied: ${reason}`,
      status: 403,
      audit,
    };
  }

  // Two delivery modes reach this engine, and they are the same engine on
  // purpose:
  //
  //  - `broker`/`kortix_fetch` — the agent calls the route itself
  //    (`kortix secrets call`, the `secret_call` MCP tool).
  //  - `egress`/`network` — a network-boundary secret on a provider with no
  //    credential edge of its own. The in-guest shim terminates the guest's
  //    TLS and relays here, so the credential stays server-side exactly as it
  //    does for the broker.
  //
  // `networkBoundaryPolicyError` is re-checked here rather than trusted from
  // save time: the row could have been written by an older build, and a policy
  // that is not a valid boundary must not be executed as one.
  const isBrokerSecret =
    shared.strategy === 'broker' && shared.egressPolicy?.backend === 'kortix_fetch';
  const isBoundarySecret =
    shared.strategy === 'egress' &&
    !!shared.egressPolicy &&
    networkBoundaryPolicyError(shared.egressPolicy) === null;
  if (!isBrokerSecret && !isBoundarySecret) {
    return {
      ok: false,
      code: 'secret_delivery_unavailable',
      message: 'Secret is not configured for the HTTPS broker',
      status: 409,
      audit,
    };
  }

  // Every active handle this SESSION holds, not just the route's own.
  //
  // Substitution has to answer two questions the single-secret lookup cannot:
  // which other handles in this request may be spent here, and — for the ones
  // that may not — whether they were forged or merely carried in from
  // somewhere else. Both need the whole set, and one query is cheaper than one
  // per handle found.
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
        eq(projectSessionSecretHandles.projectId, input.projectId),
        eq(projectSessionSecretHandles.sessionId, input.sessionId),
        eq(projectSessionSecretHandles.status, 'active'),
      ),
    )
    .orderBy(desc(projectSessionSecretHandles.revision));

  // Highest revision wins per secret: rotation leaves the previous revision
  // active for an overlap window rather than killing it mid-turn, and both are
  // spendable — but only the newest is THE handle for the route's own secret.
  const liveHandles = handleRows.filter(
    (row) => row.expiresAt === null || row.expiresAt.getTime() > Date.now(),
  );
  const handle = liveHandles.find((row) => row.secretId === shared.secretId);
  // The snapshot must match the delivery mode this request is being served
  // under. A broker secret's snapshot carries `kortix_fetch`; a boundary policy
  // carries no backend at all — `networkBoundaryPolicyError` rejects one that
  // does — so demanding `kortix_fetch` of both would make a boundary handle
  // permanently invalid. Still checked, not skipped: the snapshot is what the
  // request is executed against, so a row whose policy is neither shape must
  // not be spent.
  const handlePolicyValid = handle
    ? isBoundarySecret
      ? networkBoundaryPolicyError(handle.policySnapshot) === null
      : handle.policySnapshot.backend === 'kortix_fetch'
    : false;
  // Expiry is already applied — `liveHandles` is the filter — so this is the
  // presence and policy check only.
  if (!handle || !handlePolicyValid) {
    return {
      ok: false,
      code: 'session_secret_handle_required',
      message: 'The active session does not have this brokered secret',
      status: 409,
      audit,
    };
  }

  // Which of this session's handles may be spent on THIS destination.
  //
  // The resolution is the same one applied to the route's own secret — the
  // agent grant intersected with the session allowlist, then the handle's
  // FROZEN policy snapshot matched against the request. Substitution must never
  // widen who may spend: a handle the sandbox holds but this agent may not use
  // is left in the request as the worthless self-describing string it is.
  const spendable = await resolveSpendableHandles({
    projectId: input.projectId,
    userId: input.userId,
    sessionId: input.sessionId,
    handles: liveHandles,
    effectiveGrantEnv,
    shape: input.shape,
  });

  // The route's own secret is part of the spendable set — it is one of this
  // session's handles like any other — so reuse the value that resolution
  // already produced instead of decrypting the same row twice.
  const primary = spendable.substitutions.find((entry) => entry.identifier === input.identifier);
  const secret =
    primary?.value ??
    decryptProjectSecret(input.projectId, personal?.valueEnc ?? shared.valueEnc);

  return {
    ok: true,
    audit,
    policy: handle.policySnapshot,
    secret,
    substitutions: spendable.substitutions,
    facts: spendable.facts,
    isBoundarySecret,
  };
}

/** The single refusal that is NOT expressible as a `SecretBrokerError`, mapped
 *  for callers that want one anyway (the websocket upgrade, which has no JSON
 *  envelope of its own). */
export function relayAuthzToBrokerError(denied: SecretRelayAuthzDenied): SecretBrokerError {
  return new SecretBrokerError(
    denied.code === 'policy_denied' ? 'policy_denied' : 'invalid_request',
    denied.message,
    denied.status,
  );
}
