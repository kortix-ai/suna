/**
 * The structured principal the canonical engine authorizes.
 *
 * WHY THIS TYPE EXISTS. `authorizeV2(userId, accountId, action, target?,
 * actingTokenId?, requestCtx?)` takes the acting credential as an OPTIONAL
 * TRAILING ARGUMENT. Forgetting it does not fail to compile, does not throw,
 * and does not deny — it silently disables the token project-scope check and
 * the agent-grant fold, which is the documented root cause of the agent-grant
 * leak (`projects/lib/access.ts:485-488`: "a bare assertAuthorized would
 * silently no-op it, which is exactly how the per-route checks leaked the agent
 * grant") and of `/effective` answering differently from the real gate
 * (`accounts/iam/members.ts:443,548`).
 *
 * Folding the credential INTO the principal makes that omission impossible to
 * express: there is no `Actor` without a credential. It is built ONCE, in
 * `middleware/auth.ts`, from the branch that authenticated the request.
 */
import type { Context } from 'hono';
import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { accountTokens, roleAssignments, serviceAccounts, type AgentGrant } from '@kortix/db';
import { createHash } from 'node:crypto';
import { db } from '../shared/db';
import { ttlMemo } from '../shared/ttl-memo';
import { registerPrincipalScopedMemo } from './cache-invalidation';

/**
 * uuid5 namespace for a `pending` principal — the invitee of an
 * `account_invitations` row who holds project grants but has no auth uid yet.
 * MUST stay byte-identical to PENDING_NS in
 * packages/db/migrations/20260819015725000_rbac_backfill_role_assignments.concurrent.ts,
 * or the accept path will look up a principal the backfill never created.
 */
export const KORTIX_PENDING_PRINCIPAL_NAMESPACE = 'b8d1f9c6-0a7e-4a2f-9d3b-5e6c7a8b9c01';

/** RFC 4122 v5 (SHA-1) UUID, matching Postgres `uuid_generate_v5`. */
export function pendingPrincipalId(email: string): string {
  const ns = Buffer.from(KORTIX_PENDING_PRINCIPAL_NAMESPACE.replace(/-/g, ''), 'hex');
  const hash = createHash('sha1')
    .update(ns)
    .update(Buffer.from(email.trim().toLowerCase(), 'utf8'))
    .digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * How the request authenticated. One variant per branch of
 * `middleware/auth.ts` — there is no sixth way into the API.
 */
export type Credential =
  /** Supabase JWT (browser / dashboard). No token scope, no agent grant; the
   *  only credential the account-MFA gate applies to. */
  | { kind: 'jwt' }
  /** A human's CLI Personal Access Token. `projectId` non-null = bound to one
   *  project and refused everywhere else. */
  | { kind: 'pat'; tokenId: string; projectId: string | null }
  /** An agent session's connector token: a PAT whose account_tokens row names a
   *  service account. `activated` = an admin has assigned that service account
   *  a role, which is the OPT-IN that makes the session authorize AS the agent
   *  instead of as its launcher. `agentGrant` is the kortix.yaml narrowing that
   *  intersects the role verdict. */
  | {
      kind: 'agent_session';
      tokenId: string;
      projectId: string | null;
      sessionId: string | null;
      agentGrant: AgentGrant | null;
      serviceAccountId: string;
      activated: boolean;
    }
  /** A direct `kortix_sa_` bearer. Fail-closed: no membership baseline, no
   *  built-in role, authority is exactly its own assignments. */
  | { kind: 'service_account'; serviceAccountId: string }
  /** A sandbox token (`kortix_sb_`) on one of the path-allowlisted routes.
   *  Carries no IAM identity — `userId` is the ACCOUNT id, so it resolves to no
   *  principal and is denied `not_a_member` by every gate, exactly as today. */
  | { kind: 'sandbox' };

export interface Actor {
  /** The authenticated identity: an auth uid, or a service-account id for the
   *  two service-account credentials. NOT necessarily the acting principal —
   *  see `actingPrincipal`. */
  userId: string;
  accountId: string;
  credential: Credential;
  ctx: { ip?: string; mfaAal?: string };
}

/** A principal reference, in the canonical `role_assignments` vocabulary. */
export interface PrincipalRef {
  type: 'user' | 'group' | 'service_account' | 'pending';
  id: string;
}

/**
 * WHO the request authorizes as. Standing agent identity is opt-in: an
 * agent-session token names its agent's auto-provisioned service account, but
 * we authorize AS that service account only once an admin has actually assigned
 * it a role. Until then — and for every other credential — the acting principal
 * is the authenticated user. This mirrors `resolveActingActor`
 * (engine-v2.ts:493) exactly, including why the fallback exists: a freshly
 * provisioned, role-less agent must keep working, not collapse to deny-all.
 */
export function actingPrincipal(actor: Actor): PrincipalRef {
  const c = actor.credential;
  if (c.kind === 'agent_session' && c.activated) {
    return { type: 'service_account', id: c.serviceAccountId };
  }
  if (c.kind === 'service_account') {
    return { type: 'service_account', id: c.serviceAccountId };
  }
  return { type: 'user', id: actor.userId };
}

/** The acting token id, when a token is acting. Undefined for jwt/sandbox. */
export function actingTokenId(actor: Actor): string | undefined {
  const c = actor.credential;
  if (c.kind === 'pat' || c.kind === 'agent_session') return c.tokenId;
  if (c.kind === 'service_account') return c.serviceAccountId;
  return undefined;
}

/** The project a token is confined to, or null when it is unconfined. */
export function credentialProjectId(actor: Actor): string | null {
  const c = actor.credential;
  if (c.kind === 'pat' || c.kind === 'agent_session') return c.projectId;
  return null;
}

/** The agent-session narrowing, or null when there is none. */
export function credentialAgentGrant(actor: Actor): AgentGrant | null {
  return actor.credential.kind === 'agent_session' ? actor.credential.agentGrant : null;
}

// ─── Token binding ──────────────────────────────────────────────────────────

const TTL_MS = (() => {
  const raw = Number(process.env.IAM_CACHE_TTL_MS);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 15_000;
})();

interface TokenBinding {
  projectId: string | null;
  agentGrant: AgentGrant | null;
  serviceAccountId: string | null;
}

/**
 * `account_tokens` row for the acting token. Positive-only cache: a token row
 * that is missing must never be remembered as missing (a just-minted token has
 * to work on its very next request), and revocation is enforced upstream by
 * `validateAccountToken` at auth time.
 *
 * NOTE the pre-existing hazard this inherits: `project_id` is immutable after
 * mint, but `agent_grant` on the same row IS rewritten by
 * `remintSessionAgentGrant`, so a re-mint can lag one TTL window on a replica
 * that did not perform the write (engines.md §23). Unchanged here on purpose —
 * fixing it is a separate decision with its own latency cost.
 */
const loadTokenBinding = ttlMemo({
  ttlMs: TTL_MS,
  keyFn: (tokenId: string) => tokenId,
  loader: async (tokenId: string): Promise<TokenBinding | null> => {
    const [row] = await db
      .select({
        projectId: accountTokens.projectId,
        agentGrant: accountTokens.agentGrant,
        serviceAccountId: accountTokens.serviceAccountId,
      })
      .from(accountTokens)
      .where(eq(accountTokens.tokenId, tokenId))
      .limit(1);
    return row
      ? {
          projectId: row.projectId,
          agentGrant: row.agentGrant ?? null,
          serviceAccountId: row.serviceAccountId ?? null,
        }
      : null;
  },
  shouldCache: (row) => row !== null,
});

export { loadTokenBinding };

/**
 * Is this service account ACTIVATED — has an admin bound it to any live role?
 *
 * Deliberately an existence probe, not "does it hold any action": binding an
 * agent to a zero-permission role is how an admin pins it to deny-by-default,
 * and that must read differently from "nobody has managed this agent", which
 * falls back to the launching user. Expiry is respected for the same reason
 * engine-v2.ts:266 respects it — an expired-only binding would otherwise read
 * as activated with zero permissions, i.e. a permanently bricked agent.
 */
const loadServiceAccountActivation = ttlMemo({
  ttlMs: TTL_MS,
  keyFn: (serviceAccountId: string, accountId: string) => `${serviceAccountId}|${accountId}`,
  loader: async (serviceAccountId: string, accountId: string): Promise<boolean> => {
    const [sa] = await db
      .select({ id: serviceAccounts.serviceAccountId })
      .from(serviceAccounts)
      .where(
        and(
          eq(serviceAccounts.serviceAccountId, serviceAccountId),
          eq(serviceAccounts.accountId, accountId),
          eq(serviceAccounts.status, 'active'),
        ),
      )
      .limit(1);
    if (!sa) return false;
    const [binding] = await db
      .select({ id: roleAssignments.assignmentId })
      .from(roleAssignments)
      .where(
        and(
          eq(roleAssignments.principalType, 'service_account'),
          eq(roleAssignments.principalId, serviceAccountId),
          eq(roleAssignments.accountId, accountId),
          or(isNull(roleAssignments.expiresAt), gt(roleAssignments.expiresAt, sql`now()`)),
        ),
      )
      .limit(1);
    return binding != null;
  },
  // Never cache "not activated": assigning an agent its first role must take
  // effect on the next request, exactly like granting a member access does.
  shouldCache: (activated) => activated,
});
registerPrincipalScopedMemo(loadServiceAccountActivation);

export { loadServiceAccountActivation };

// ─── Building the actor ─────────────────────────────────────────────────────

/**
 * Build the Actor for this request from the Hono context.
 *
 * `accountId` defaults to whatever the auth branch resolved. Routes that
 * resolve a different account (the common dashboard case, where the account
 * comes from the path) pass it explicitly — the credential is unchanged, only
 * the account the verdict is asked about.
 *
 * Returns null only when the request carries no identity at all.
 */
export async function buildActor(c: Context, accountIdOverride?: string): Promise<Actor | null> {
  const userId = c.get('userId') as string | undefined;
  const accountId = accountIdOverride ?? (c.get('accountId') as string | undefined) ?? '';
  if (!userId) return null;

  const ctx = {
    ip: firstForwardedIp(c.req.header('x-forwarded-for')) ?? c.req.header('x-real-ip') ?? undefined,
    mfaAal: (c.get('mfaAal') as string | undefined) ?? undefined,
  };

  const authType = c.get('authType') as string | undefined;

  if (authType === 'service_account') {
    return { userId, accountId, credential: { kind: 'service_account', serviceAccountId: userId }, ctx };
  }

  if (authType === 'apiKey') {
    // Sandbox / legacy API-key bearer. auth.ts maps `userId` to the ACCOUNT id
    // for these, so there is no IAM principal behind them.
    return { userId, accountId, credential: { kind: 'sandbox' }, ctx };
  }

  const tokenId = c.get('iamTokenId') as string | undefined;
  if (authType === 'pat' && tokenId) {
    return {
      userId,
      accountId,
      credential: await tokenCredential(tokenId, accountId, (c.get('sessionId') as string | undefined) ?? null),
      ctx,
    };
  }

  return { userId, accountId, credential: { kind: 'jwt' }, ctx };
}

/**
 * Classify a token id into its credential variant. Shared by `buildActor` and
 * `actorForToken` so a token authenticates to the SAME authority whether it
 * arrived on a Hono request or was resolved out of band (the git proxy, the
 * connector runtime, the project-resource list filter).
 */
async function tokenCredential(
  tokenId: string,
  accountId: string,
  sessionId: string | null,
): Promise<Credential> {
  const binding = await loadTokenBinding(tokenId);
  const serviceAccountId = binding?.serviceAccountId ?? null;
  if (serviceAccountId) {
    const activated = accountId ? await loadServiceAccountActivation(serviceAccountId, accountId) : false;
    return {
      kind: 'agent_session',
      tokenId,
      projectId: binding?.projectId ?? null,
      sessionId,
      agentGrant: binding?.agentGrant ?? null,
      serviceAccountId,
      activated,
    };
  }
  // A null binding for a PAT means the token row is gone (revoked). Keeping
  // projectId null here would WIDEN it; `authorize` denies a PAT whose binding
  // is missing, which is why the binding itself is re-read there.
  return { kind: 'pat', tokenId, projectId: binding?.projectId ?? null };
}

/**
 * An Actor for a caller that carries NO Kortix credential of its own — a channel
 * webhook acting as the Kortix user a Slack/Teams identity is linked to, a
 * background job acting as a stored owner, an internal composite read.
 *
 * `jwt` is the honest classification: there is no token to scope, no agent grant
 * to intersect, and the account-MFA gate applies exactly as it would in the
 * browser. It is NOT a widening — an out-of-band caller previously reached
 * `authorizeV2` with `actingTokenId` omitted, which is the same authority with
 * none of the type safety.
 */
export function actorForUser(userId: string, accountId: string, ctx: Actor['ctx'] = {}): Actor {
  return { userId, accountId, credential: { kind: 'jwt' }, ctx };
}

/**
 * An Actor for a caller identified by an acting TOKEN id resolved out of band —
 * the git proxy (which authenticates a `kortix_pat_`/session token itself), the
 * connector runtime, and the project-resource list filters that thread
 * `actingTokenId` through their own context object.
 *
 * Passing `tokenId: null | undefined` degrades to `actorForUser`, which is what
 * those call sites already did implicitly by omitting the trailing argument —
 * the difference is that here it is a visible, typed decision.
 */
export async function actorForToken(
  userId: string,
  accountId: string,
  tokenId: string | null | undefined,
  opts: { sessionId?: string | null; ctx?: Actor['ctx'] } = {},
): Promise<Actor> {
  if (!tokenId) return actorForUser(userId, accountId, opts.ctx ?? {});
  return {
    userId,
    accountId,
    credential: await tokenCredential(tokenId, accountId, opts.sessionId ?? null),
    ctx: opts.ctx ?? {},
  };
}

/**
 * An Actor for a direct service-account bearer resolved out of band. Fail-closed
 * by construction: no membership baseline, authority is exactly its own
 * assignments.
 */
export function actorForServiceAccount(serviceAccountId: string, accountId: string): Actor {
  return {
    userId: serviceAccountId,
    accountId,
    credential: { kind: 'service_account', serviceAccountId },
    ctx: {},
  };
}

/**
 * The request's Actor, rebuilt when a route asks about a DIFFERENT account than
 * the one auth resolved. The cached actor on the context is the common case
 * (PAT/service-account requests, where auth already knew the account).
 */
export async function actorFor(c: Context, accountId: string): Promise<Actor | null> {
  const cached = c.get('actor') as Actor | undefined;
  if (cached && cached.accountId === accountId) return cached;
  return buildActor(c, accountId);
}

/**
 * THE gate helper: the actor for this request, asked about this account.
 *
 * Every route-level authorization call takes its actor from here, so "I forgot
 * the credential" is not expressible — there is no overload that omits it and
 * no nullable to fall through.
 *
 * It never returns null. A request that carries no identity at all yields an
 * actor with an EMPTY user id, which resolves to no principal and is denied
 * `not_a_member` by every gate. That is deliberately the same outcome as
 * before: `authorizeV2` was handed an undefined userId, reached the engine, and
 * denied there. Turning it into a 401 here would change a 403 into a 401 on
 * every route at once, which is a contract change, not a refactor.
 */
export async function actorOf(c: Context, accountId: string): Promise<Actor> {
  return (await actorFor(c, accountId)) ?? { userId: '', accountId, credential: { kind: 'jwt' }, ctx: {} };
}

function firstForwardedIp(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const first = header.split(',')[0]?.trim();
  return first || undefined;
}
