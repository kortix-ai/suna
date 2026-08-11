/**
 * Platform-admin act-as impersonation — "open this customer's account".
 *
 * The capability is a ROW (`kortix.impersonation_grants`), never a token. The
 * request header carries only the grant id; ownership, expiry, revocation and
 * the caller's CURRENT platform role are all re-read on every single request.
 * That is the whole design decision, and everything else follows from it:
 *
 *   - Revocation is instant. There is no signed artifact still in flight.
 *   - A leaked grant id is useless. It only works for the admin it names, and
 *     only while that admin still holds `platform_user_roles.admin`. Demote the
 *     operator and every grant they hold dies with the role, mid-session.
 *   - There is no clock skew to exploit and no TTL to forge: `expires_at` is
 *     written by the API, capped at {@link IMPERSONATION_MAX_TTL_MS}, and
 *     compared against the DB's own `now()`.
 *
 * Once a grant validates, the impersonated account flows through the SAME
 * membership resolution every ordinary request uses — `resolveAccountId`,
 * `getAccountMembership`, and the IAM engine each ask this module whether the
 * current request is acting as an account, rather than each access check
 * growing its own admin branch. The real operator stays available as
 * `impersonatorUserId` so every audit row carries BOTH identities.
 *
 * Fail-closed everywhere: any failure is a 403 `impersonation_invalid`. A bad
 * header NEVER silently degrades into "act as your own account" — that would
 * turn a mistyped grant id into a write against the wrong account.
 */

import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import { getRequestContext } from '../lib/request-context';
import { db } from './db';

// The table is imported LAZILY inside each query below, never at module scope.
// This module is reached from `resolve-account`, `projects/lib/git`,
// `iam/engine-v2` and `accounts/core/app` — i.e. from most of the app graph —
// and a dozen unit suites mock `@kortix/db` with a partial shape. A static
// import of one more table name turns every one of those into a module-load
// SyntaxError far from anything they are testing. The same reasoning as the
// leaf-module import note in projects/lib/git.ts.
async function grantsTable() {
  const { impersonationGrants } = await import('@kortix/db');
  return impersonationGrants;
}

// Same reasoning for `hasDatabase`: two suites mock `../shared/db` down to a
// bare `{ db }`, and a static import of a second name breaks their module load.
// A mock without the flag reads as "a database is present", which is what those
// suites are simulating.
async function hasDatabase(): Promise<boolean> {
  const dbModule = (await import('./db')) as { hasDatabase?: boolean };
  return dbModule.hasDatabase !== false;
}

/** Request header carrying the grant id. Lowercase — Hono matches case-insensitively. */
export const IMPERSONATION_HEADER = 'x-kortix-impersonate';

/** Hard ceiling on a grant's lifetime. An operator re-mints rather than lingering. */
export const IMPERSONATION_MAX_TTL_MS = 60 * 60 * 1000;

/** Stable error code every impersonation denial carries, for the client to branch on. */
export const IMPERSONATION_INVALID_CODE = 'impersonation_invalid';

/** Audit actions. `action` is per MUTATING request; start/stop bracket the session. */
export const IMPERSONATION_START_ACTION = 'admin.impersonate.start';
export const IMPERSONATION_STOP_ACTION = 'admin.impersonate.stop';
export const IMPERSONATION_ACTION_ACTION = 'admin.impersonate.action';

/** The grant row, reduced to the fields the decision actually reads. */
export interface ImpersonationGrantRecord {
  id: string;
  adminUserId: string;
  targetAccountId: string;
  expiresAt: Date;
  revokedAt: Date | null;
}

export type ImpersonationDenialReason =
  | 'grant_not_found'
  | 'grant_not_owned'
  | 'grant_revoked'
  | 'grant_expired'
  | 'not_platform_admin'
  | 'auth_type_not_supported'
  | 'route_forbidden'
  | 'request_context_unavailable';

export type ImpersonationDecision =
  | { ok: true; grantId: string; targetAccountId: string }
  | { ok: false; reason: ImpersonationDenialReason };

/**
 * Routes an impersonated request may NEVER reach, checked before the grant is
 * even loaded. Two families, for two different reasons:
 *
 *  1. `/v1/admin/*` — the platform console itself. Blocks nesting (minting a
 *     second grant from inside a session), blocks changing platform roles, and
 *     blocks an impersonated request reading the whole customer base. Support
 *     staff already reach the console with their own identity; there is no
 *     legitimate reason to reach it through a customer's context.
 *
 *  2. DURABLE ACCESS — anything the operator could create inside the hour that
 *     still works after it. A PAT, SCIM token, service account, CLI token, git
 *     token or gateway key; an `account_members` row for an address they
 *     control; a never-expiring public share of a session; an SSO provider
 *     they own; a tunnel credential. Each of those outlives the grant and
 *     carries no banner, no expiry and no impersonation marker — the operator
 *     stops being distinguishable from an ordinary member of the account.
 *     That is persistence, not debugging. An operator who genuinely needs one
 *     issues it through an admin route under their own identity, where it is
 *     attributable.
 *
 *     Note what this is NOT: it is not privilege escalation containment. A
 *     platform admin can re-mint a grant whenever they like. It is time-box
 *     and attribution containment — the two properties the banner and the
 *     one-hour cap actually promise.
 *
 * Pure and exported so every entry in the list is unit-tested by path, not by
 * booting a router.
 */
interface ForbiddenRoute {
  re: RegExp;
  /** `true` = every method. Otherwise only STATE-CHANGING methods are refused. */
  allMethods?: boolean;
}

const IMPERSONATION_FORBIDDEN_ROUTES: ForbiddenRoute[] = [
  // The console itself: refused outright, reads included. An impersonated
  // request has no business reading the whole customer base.
  { re: /^\/v1\/admin(\/|$)/, allMethods: true },
  // Credentials. GET on these is a LISTING (which PATs exist, which service
  // accounts exist) and is useful for support; only minting and revoking are
  // refused, which is what the non-GET rule below expresses.
  { re: /^\/v1\/accounts\/tokens(\/|$)/ },
  { re: /^\/v1\/accounts\/[^/]+\/iam\/scim\/tokens(\/|$)/ },
  { re: /^\/v1\/accounts\/[^/]+\/iam\/service-accounts(\/|$)/ },
  { re: /^\/v1\/projects\/[^/]+\/cli-token(\/|$)/ },
  { re: /^\/v1\/projects\/[^/]+\/git-token(\/|$)/ },
  { re: /^\/v1\/projects\/[^/]+\/gateway\/keys(\/|$)/ },
  // Membership. `POST /v1/accounts/:id/members` adds an EXISTING Kortix user
  // straight into the account (optionally as `admin`) with no invite to
  // accept — the single cheapest way to convert one hour of act-as into
  // permanent, unmarked access. Reading the member list stays allowed; it is
  // the first thing a support question needs.
  { re: /^\/v1\/accounts\/[^/]+\/members(\/|$)/ },
  { re: /^\/v1\/accounts\/[^/]+\/invites(\/|$)/ },
  // The account-scoped IAM surface adds durable principals too — the
  // account-members POST above is only one door. `iam/members` carries the
  // super-admin PATCH, `iam/groups` adds a principal to a policy-bearing
  // group, and both outlive the grant. Refuse the whole IAM subtree's
  // state changes (reads stay open for support).
  { re: /^\/v1\/accounts\/[^/]+\/iam\/members(\/|$)/ },
  { re: /^\/v1\/accounts\/[^/]+\/iam\/groups(\/|$)/ },
  { re: /^\/v1\/accounts\/[^/]+\/iam\/roles(\/|$)/ },
  { re: /^\/v1\/accounts\/[^/]+\/iam\/policies(\/|$)/ },
  // Project-scoped invite is a full member-add primitive: an existing user is
  // INSERTed into account_members directly (role from the body, `manager`
  // accepted), and an unknown email returns the invite_url in the response.
  // Same permanent-access outcome as the account-scoped member route above.
  { re: /^\/v1\/projects\/[^/]+\/access(\/|$)/ },
  { re: /^\/v1\/account-invites(\/|$)/ },
  // Agent governance. PUT /agents/:name/scope and POST /secrets/:id/grant
  // commit durable state into `kortix.yaml`: widening what an agent may read
  // changes every future session of the project and survives the grant with
  // no banner and no marker — the same persistence-not-debugging outcome as a
  // membership row. An operator who needs a scope change lands it through the
  // customer or an attributable admin route, not from inside the hour.
  { re: /^\/v1\/projects\/[^/]+\/agents\/[^/]+\/scope(\/|$)/ },
  { re: /^\/v1\/projects\/[^/]+\/secrets\/[^/]+\/grant(\/|$)/ },
  // Audit webhooks. Pointing the customer's audit stream at an operator URL
  // exfiltrates their events and survives the grant.
  { re: /^\/v1\/accounts\/[^/]+\/audit\/webhooks(\/|$)/ },
  { re: /^\/v1\/projects\/[^/]+\/audit\/webhooks(\/|$)/ },
  // Identity. An SSO provider the operator controls would let them
  // authenticate INTO the customer's account directly afterwards. Covers
  // sso, scim (directory sync), and the token routes above.
  { re: /^\/v1\/accounts\/[^/]+\/iam\/sso(\/|$)/ },
  { re: /^\/v1\/accounts\/[^/]+\/iam\/scim(\/|$)/ },
  // Connectors. A connection row carries a stored credential or OAuth state
  // for an external service; connecting a workspace or app the OPERATOR
  // controls is a durable exfiltration channel that outlives the grant, the
  // same shape as an audit webhook. Both mounts of the management surface are
  // blocked for writes: the project-scoped one and the /v1/connectors one.
  // Reads (inventory, status, catalog) stay open — they are what support
  // needs. Live invocation (`/call`) stays open too: it acts now, inside the
  // audited hour, and creates nothing durable.
  { re: /^\/v1\/projects\/[^/]+\/connections(\/|$)/ },
  { re: /^\/v1\/projects\/[^/]+\/connectors\/[^/]+\/oauth2\/connection(\/|$)/ },
  { re: /^\/v1\/connectors\/projects\/[^/]+\/connectors(\/|$)/ },
  { re: /^\/v1\/connectors\/projects\/[^/]+\/policies(\/|$)/ },
  // Channels are connections too: email/slack/teams connect binds an external
  // workspace or address that keeps reaching the account after the hour.
  { re: /^\/v1\/projects\/[^/]+\/channels\/[^/]+\/connect(\/|$)/ },
  // Setup links. connect-requests and secret-requests mint 7-day tokens whose
  // consuming routes are public (`/v1/setup-links/*`) — a link minted inside
  // the hour is a credential-intake door that works for days after it.
  { re: /^\/v1\/projects\/[^/]+\/connect-requests(\/|$)/ },
  { re: /^\/v1\/projects\/[^/]+\/secret-requests(\/|$)/ },
  // Public shares. `expires_at` is optional, and the consuming route
  // (`/v1/public/session-shares/:shareId`) is mounted before auth — an
  // omitted expiry is a permanent unauthenticated link to a customer session.
  { re: /^\/v1\/projects\/[^/]+\/sessions\/[^/]+\/public-shares(\/|$)/ },
  // Tunnels: the whole management surface. Creating a connection, rotating a
  // token, or APPROVING a device-auth code (`device-auth/:code/approve`, the
  // CLI's real tunnel-creation path) all mint a long-lived credential to a
  // real machine with shell/filesystem grants. The single `connections` entry
  // covered one of four mutating families; block the subtree. Listing is a
  // read and stays open.
  { re: /^\/v1\/tunnel(\/|$)/ },
];

/** HTTP methods that cannot change state, so cannot create durable access. */
const READ_ONLY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Method-aware on purpose. The list exists to stop an operator CREATING
 * something that outlives the grant — a token, a membership, a never-expiring
 * share. A GET creates nothing, and blocking reads would take the member list,
 * the token inventory and the tunnel fleet away from the exact person opening
 * the account to answer a question about them. `/v1/admin/*` is the one
 * all-methods entry, because there the read itself is the problem.
 */
export function isImpersonationForbiddenPath(path: string, method = 'GET'): boolean {
  const normalizedMethod = method.toUpperCase();
  return IMPERSONATION_FORBIDDEN_ROUTES.some((route) => {
    if (!route.re.test(path)) return false;
    return route.allMethods || !READ_ONLY_METHODS.has(normalizedMethod);
  });
}

/**
 * The complete decision, pure. Every input is already resolved by the caller
 * (the grant row read, the platform role looked up), so the security gate
 * itself is exhaustively testable without a DB — the same shape as
 * `shouldApplyAdminBypass` in projects/lib/access.ts.
 *
 * Order matters and is deliberate: cheap local refusals first, so a non-admin
 * probing grant ids learns nothing from response timing beyond "denied", and
 * the platform-role check is last because it is the one DB read.
 */
export function decideImpersonation(input: {
  grant: ImpersonationGrantRecord | null;
  realUserId: string;
  authType: string | undefined;
  isPlatformAdmin: boolean;
  path: string;
  method?: string;
  now: Date;
}): ImpersonationDecision {
  // Only a logged-in human session may act as an account. A PAT, sandbox
  // token, API key or service account carrying this header is a category
  // error (and, for a sandbox token, an attempted escape) — refuse it.
  if (input.authType !== 'supabase') return { ok: false, reason: 'auth_type_not_supported' };
  if (isImpersonationForbiddenPath(input.path, input.method)) {
    return { ok: false, reason: 'route_forbidden' };
  }
  if (!input.grant) return { ok: false, reason: 'grant_not_found' };
  if (input.grant.adminUserId !== input.realUserId) return { ok: false, reason: 'grant_not_owned' };
  if (input.grant.revokedAt) return { ok: false, reason: 'grant_revoked' };
  if (input.grant.expiresAt.getTime() <= input.now.getTime()) {
    return { ok: false, reason: 'grant_expired' };
  }
  // Re-checked per request on purpose: a grant minted by an admin who has
  // since been demoted must stop working immediately, not at expiry.
  if (!input.isPlatformAdmin) return { ok: false, reason: 'not_platform_admin' };
  return { ok: true, grantId: input.grant.id, targetAccountId: input.grant.targetAccountId };
}

/** Clamp a requested TTL into (0, {@link IMPERSONATION_MAX_TTL_MS}]. */
export function impersonationExpiryFrom(now: Date, requestedTtlMs?: number): Date {
  const ttl =
    typeof requestedTtlMs === 'number' && Number.isFinite(requestedTtlMs) && requestedTtlMs > 0
      ? Math.min(Math.floor(requestedTtlMs), IMPERSONATION_MAX_TTL_MS)
      : IMPERSONATION_MAX_TTL_MS;
  return new Date(now.getTime() + ttl);
}

// ─── Request-scoped context ──────────────────────────────────────────────────
//
// Carried on the AsyncLocalStorage request context (lib/request-context.ts),
// which `runWithContext` opens per request as the FIRST global middleware. Two
// properties make that the right home rather than a module-level variable or a
// Hono context value:
//
//   - It cannot leak across requests: each request gets its own store.
//   - It reaches code that never sees the Hono `Context` — `resolveAccountId`,
//     `getAccountMembership`, `authorizeV2` — which is exactly the deep
//     plumbing the impersonated account has to flow through.
//
// It is deliberately NOT threaded through the memoized IAM/membership caches:
// those are keyed on `${userId}|${accountId}` and shared across requests, so
// writing an impersonation-derived answer into one would serve "owner" to the
// admin's OWN later requests. Every consumer checks this context BEFORE its
// cache, never inside it.

const GRANT_ID_FIELD = 'impersonationGrantId';
const TARGET_FIELD = 'impersonationTargetAccountId';
const IMPERSONATOR_FIELD = 'impersonatorUserId';

export interface ImpersonationContext {
  grantId: string;
  targetAccountId: string;
  /** The REAL platform admin behind the request. Never the target's user. */
  impersonatorUserId: string;
}

/** Returns false when there is no request context to write into (fail-closed). */
export function setImpersonationContext(context: ImpersonationContext): boolean {
  const store = getRequestContext();
  if (!store) return false;
  store[GRANT_ID_FIELD] = context.grantId;
  store[TARGET_FIELD] = context.targetAccountId;
  store[IMPERSONATOR_FIELD] = context.impersonatorUserId;
  return true;
}

export function getImpersonationContext(): ImpersonationContext | null {
  const store = getRequestContext();
  if (!store) return null;
  const grantId = store[GRANT_ID_FIELD];
  const targetAccountId = store[TARGET_FIELD];
  const impersonatorUserId = store[IMPERSONATOR_FIELD];
  if (!grantId || !targetAccountId || !impersonatorUserId) return null;
  return { grantId, targetAccountId, impersonatorUserId };
}

/**
 * The account this request acts as, for THIS user id — or null.
 *
 * The user-id match is the load-bearing part. Access checks resolve several
 * principals in one request (the caller, a session's creator, a service
 * account), and only the operator who owns the grant may be widened. Passing
 * any other id gets the ordinary answer.
 */
export function impersonatedAccountFor(userId: string | null | undefined): string | null {
  if (!userId) return null;
  const context = getImpersonationContext();
  if (!context || context.impersonatorUserId !== userId) return null;
  return context.targetAccountId;
}

/** True when `userId` is acting as `accountId` right now. */
export function isImpersonatingAccount(
  userId: string | null | undefined,
  accountId: string | null | undefined,
): boolean {
  if (!accountId) return false;
  return impersonatedAccountFor(userId) === accountId;
}

/**
 * True when this request is acting as an account and `accountId` is NOT it.
 *
 * Impersonation CONFINES, it does not merely add. Without this the operator
 * keeps their own memberships for the whole session: opening the app lands on
 * their last project (a cookie), which belongs to their own account, and the
 * banner then says "Acting as Customer" over the operator's own data. Worse,
 * a write they make there is a real write, made while every visible signal
 * claims they are somewhere else.
 *
 * So while a grant is live the answer is exactly one account: the target. Every
 * other account — including the operator's own — is inaccessible until they
 * exit. Anyone who is not the grant's operator is unaffected.
 */
export function isImpersonationBlockedAccount(
  userId: string | null | undefined,
  accountId: string | null | undefined,
): boolean {
  const target = impersonatedAccountFor(userId);
  if (!target) return false;
  return accountId !== target;
}

// ─── Grant store ─────────────────────────────────────────────────────────────

export async function loadImpersonationGrant(
  grantId: string,
): Promise<ImpersonationGrantRecord | null> {
  if (!(await hasDatabase())) return null;
  // A malformed id is a `uuid` cast error (SQLSTATE 22P02) before any guard
  // runs, which would surface as a 500 on a header the caller controls.
  if (!UUID_RE.test(grantId)) return null;
  const impersonationGrants = await grantsTable();
  const [row] = await db
    .select({
      id: impersonationGrants.id,
      adminUserId: impersonationGrants.adminUserId,
      targetAccountId: impersonationGrants.targetAccountId,
      expiresAt: impersonationGrants.expiresAt,
      revokedAt: impersonationGrants.revokedAt,
    })
    .from(impersonationGrants)
    .where(eq(impersonationGrants.id, grantId))
    .limit(1);
  return row ?? null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export async function createImpersonationGrant(input: {
  adminUserId: string;
  targetAccountId: string;
  reason?: string | null;
  expiresAt: Date;
}): Promise<ImpersonationGrantRecord> {
  const impersonationGrants = await grantsTable();
  const [row] = await db
    .insert(impersonationGrants)
    .values({
      adminUserId: input.adminUserId,
      targetAccountId: input.targetAccountId,
      reason: input.reason ?? null,
      expiresAt: input.expiresAt,
    })
    .returning({
      id: impersonationGrants.id,
      adminUserId: impersonationGrants.adminUserId,
      targetAccountId: impersonationGrants.targetAccountId,
      expiresAt: impersonationGrants.expiresAt,
      revokedAt: impersonationGrants.revokedAt,
    });
  return row;
}

/**
 * Revoke a grant. Scoped to the caller's OWN grants — one admin cannot revoke
 * another's session, and a non-owner gets the same "not found" answer as a
 * nonexistent id. Idempotent: re-revoking returns the row unchanged.
 */
export async function revokeImpersonationGrant(input: {
  grantId: string;
  adminUserId: string;
}): Promise<ImpersonationGrantRecord | null> {
  if (!isUuid(input.grantId)) return null;
  const impersonationGrants = await grantsTable();
  const [row] = await db
    .update(impersonationGrants)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(impersonationGrants.id, input.grantId),
        eq(impersonationGrants.adminUserId, input.adminUserId),
        isNull(impersonationGrants.revokedAt),
      ),
    )
    .returning({
      id: impersonationGrants.id,
      adminUserId: impersonationGrants.adminUserId,
      targetAccountId: impersonationGrants.targetAccountId,
      expiresAt: impersonationGrants.expiresAt,
      revokedAt: impersonationGrants.revokedAt,
    });
  if (row) return row;
  // Already revoked (or not ours) — read it back so the caller can tell the
  // two apart without a second round-trip.
  const existing = await loadImpersonationGrant(input.grantId);
  if (!existing || existing.adminUserId !== input.adminUserId) return null;
  return existing;
}

/** The caller's live grants: not revoked, not expired, newest first. */
export async function listActiveImpersonationGrants(
  adminUserId: string,
): Promise<ImpersonationGrantRecord[]> {
  if (!(await hasDatabase())) return [];
  const impersonationGrants = await grantsTable();
  return db
    .select({
      id: impersonationGrants.id,
      adminUserId: impersonationGrants.adminUserId,
      targetAccountId: impersonationGrants.targetAccountId,
      expiresAt: impersonationGrants.expiresAt,
      revokedAt: impersonationGrants.revokedAt,
    })
    .from(impersonationGrants)
    .where(
      and(
        eq(impersonationGrants.adminUserId, adminUserId),
        isNull(impersonationGrants.revokedAt),
        gt(impersonationGrants.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(impersonationGrants.createdAt))
    .limit(50);
}
