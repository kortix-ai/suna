/**
 * Generic "who can use it" member/group sharing — the mechanism session
 * visibility (project_session_grants) uses. Three dashboard options map onto
 * one mechanism:
 *
 *   Project wide   → visibility='project'                 (everyone)
 *   Select members → visibility='restricted' + grants     (members and/or groups)
 *   Just me        → visibility='private'                 (owner only)
 *
 * Rule (Marko): empty allow-list = whole project; ≥1 grant = restricted.
 * Pure logic here is unit-tested; DB helpers feed the session CRUD.
 *
 * Project SECRETS no longer use this — secret sharing was retired (a secret is
 * always project-wide; see migration 20260706_secrets_v2_identifier_model.sql
 * and projects/secrets.ts). CONNECTORS no longer use this either — a connector
 * is always project-wide visible; the only access gate is the agent-side
 * `[[agents]].connectors` grant (iam/agent-scope.ts). This file keeps the
 * generic pure helpers + session DB helpers only.
 *
 * See docs/specs/connector.md §6.
 */
import { eq, inArray } from 'drizzle-orm';
import {
  accountGroupMembers,
  projectSessionGrants,
  projectSessions,
} from '@kortix/db';
import { db } from '../shared/db';

export type ShareScope = 'project' | 'restricted';

export interface SecretGrant {
  principalType: 'member' | 'group';
  principalId: string;
}

/** The acting identity, resolved to the groups it belongs to. */
export interface ShareSubject {
  userId: string;
  groupIds: string[];
}

/** Pure: may this subject use a `restricted`-allow-list resource with the given
 *  scope + grants? (Despite the name, this is now generic — session visibility
 *  is the remaining caller; project secrets and connectors both dropped
 *  restricted sharing entirely — see the file doc comment.) */
export function isSecretUsableBy(
  shareScope: ShareScope,
  grants: SecretGrant[],
  subject: ShareSubject,
): boolean {
  if (shareScope === 'project') return true;
  for (const g of grants) {
    if (g.principalType === 'member' && g.principalId === subject.userId) return true;
    if (g.principalType === 'group' && subject.groupIds.includes(g.principalId)) return true;
  }
  return false;
}

/** The dashboard's three sharing options, before persistence. */
export type SharingIntent =
  | { mode: 'project' }
  | { mode: 'private'; ownerId: string }
  | { mode: 'members'; memberIds?: readonly string[]; groupIds?: readonly string[] };

/** Normalize a sharing intent into a persisted (scope, grants) pair. */
export function intentToScope(intent: SharingIntent): {
  shareScope: ShareScope;
  grants: SecretGrant[];
} {
  if (intent.mode === 'project') return { shareScope: 'project', grants: [] };
  if (intent.mode === 'private') {
    return { shareScope: 'restricted', grants: [{ principalType: 'member', principalId: intent.ownerId }] };
  }
  const grants: SecretGrant[] = [
    ...(intent.memberIds ?? []).map((id) => ({ principalType: 'member' as const, principalId: id })),
    ...(intent.groupIds ?? []).map((id) => ({ principalType: 'group' as const, principalId: id })),
  ];
  // Empty allow-list collapses to project-wide (Marko's rule).
  if (grants.length === 0) return { shareScope: 'project', grants: [] };
  return { shareScope: 'restricted', grants };
}

/** Inverse of intentToScope — for rendering the dashboard's current selection. */
export function scopeToIntent(shareScope: ShareScope, grants: SecretGrant[]): SharingIntent {
  if (shareScope === 'project') return { mode: 'project' };
  const memberIds = grants.filter((g) => g.principalType === 'member').map((g) => g.principalId);
  const groupIds = grants.filter((g) => g.principalType === 'group').map((g) => g.principalId);
  if (memberIds.length === 1 && groupIds.length === 0) return { mode: 'private', ownerId: memberIds[0]! };
  return { mode: 'members', memberIds, groupIds };
}

/**
 * Validate/normalize an untrusted sharing body into a SharingIntent. Returns
 * null when `mode` is missing/unknown so callers can 400. A `private` body with
 * no explicit `ownerId` falls back to the acting user.
 */
export function parseSharingIntent(body: any, fallbackOwner: string): SharingIntent | null {
  const mode = typeof body?.mode === 'string' ? body.mode : '';
  if (mode === 'project') return { mode: 'project' };
  if (mode === 'private') {
    const ownerId = typeof body?.ownerId === 'string' && body.ownerId ? body.ownerId : fallbackOwner;
    return { mode: 'private', ownerId };
  }
  if (mode === 'members') {
    const memberIds = Array.isArray(body?.memberIds) ? body.memberIds.filter((x: unknown) => typeof x === 'string') : [];
    const groupIds = Array.isArray(body?.groupIds) ? body.groupIds.filter((x: unknown) => typeof x === 'string') : [];
    return { mode: 'members', memberIds, groupIds };
  }
  return null;
}

/* ─── DB helpers (used by the gateway + CRUD) ─────────────────────────────── */

/** Resolve a user's group memberships → the subject the gateway authorizes with. */
export async function resolveShareSubject(userId: string): Promise<ShareSubject> {
  const rows = await db
    .select({ groupId: accountGroupMembers.groupId })
    .from(accountGroupMembers)
    .where(eq(accountGroupMembers.userId, userId));
  return { userId, groupIds: rows.map((r) => r.groupId) };
}

/* ─── Session sharing — default private; team-wide or select-members ───────────
 *
 * Same allow-list mechanism as secrets, but sessions have a first-class
 * `private` visibility (owner only) instead of modelling it as restricted+owner.
 * The dashboard's SharingIntent maps: project→project, private→private,
 * members→restricted+grants (empty members collapses back to private).
 * See docs/specs/iam.md.
 */

export type SessionVisibility = 'private' | 'project' | 'restricted';

/**
 * Context needed to decide whether `created_by` may confer ownership.
 *
 * For an INTERACTIVE session created_by is one human, so ownership is real. For
 * a Kortix-as-a-Backend session it is the WRAPPER's credential — identical for
 * every one of that wrapper's end-users — so it identifies nobody, and letting
 * it short-circuit would make every end-user's session visible to every other.
 */
export interface SessionOwnershipContext {
  /** The target session's `origin` (`'backend'` for a wrapper-created session). */
  origin: string | null;
  /** The target session's id. */
  sessionId: string;
  /** The CALLER's own session, when the credential is bound to one (a sandbox
   *  token). Null for the wrapper's own backend credential, which acts for
   *  nobody in particular and legitimately sees everything it created.
   *  REQUIRED — never optional. An omitted binding would default to the
   *  permissive value and silently reopen the hole on any edge that forgets it. */
  callerSessionId: string | null;
  /**
   * The caller's AGENT/SANDBOX token binding — `callerKortixSessionId(c)`, i.e.
   * `sessionId` for every credential kind EXCEPT a Supabase browser JWT, which
   * is always null.
   *
   * Deliberately separate from `callerSessionId`. That field is fed the RAW
   * `c.get('sessionId')` at 14 of its call sites, and `resolveSupabaseAuth`
   * (middleware/auth.ts:285, :341) sets that to the SUPABASE LOGIN SESSION id
   * for every signed-in human. So `callerSessionId != null` does NOT mean "an
   * agent token" — it is true for ordinary dashboard users too, and using it to
   * gate manager standing 403s them (see the trigger-override gate below).
   *
   * Only the trigger-session manager override reads this field. The
   * sibling-session narrowing in `isSessionTargetVisibleToCaller` keeps using
   * `callerSessionId`, unchanged.
   *
   * REQUIRED — never optional, for the same reason as `callerSessionId`.
   */
  boundCredentialSessionId: string | null;
}

/**
 * What the sibling-session narrowing needs. `boundCredentialSessionId` is
 * OPTIONAL here — only the trigger-session manager override reads it, so a
 * caller doing narrowing alone is not forced to source it, while a full
 * `SessionOwnershipContext` still passes unchanged.
 */
export interface SessionNarrowingContext {
  origin: string | null;
  sessionId: string;
  callerSessionId: string | null;
  boundCredentialSessionId?: string | null;
}

/**
 * A session-bound sandbox credential may access only its own backend session.
 *
 * Human credentials and wrapper backend credentials have no session binding.
 * Interactive sessions keep their human ownership semantics.
 */
export function isSessionTargetVisibleToCaller(
  /** Narrowing needs only the binding — not the override field, so callers that
   *  do sibling-isolation alone stay unchanged. */
  ownership: SessionNarrowingContext,
): boolean {
  // The AGENT binding, never the raw `callerSessionId`.
  //
  // `resolveSupabaseAuth` sets `c.get('sessionId')` to the SUPABASE LOGIN
  // session id for every signed-in human (middleware/auth.ts), so
  // `callerSessionId` is non-null for ordinary dashboard users and can never
  // equal a Kortix session id. Reading it here made all three conditions below
  // true for ANY human opening ANY backend-origin session, so the narrowing
  // returned false and `/start` answered 404 — a session listed in the sidebar
  // that could never be opened. Measured on a live self-host (essentia,
  // 2026-08-24): 43 backend-origin sessions in one project, all unopenable,
  // while `user`- and `schedule`-origin sessions in the same project opened
  // fine.
  //
  // `callerKortixSessionId()` is the value this guard always wanted — it
  // returns null for a Supabase browser JWT and the real session id for
  // anything session-bound, and its own doc says the isolation guards "read
  // this as 'narrow me'". `access.ts` already threads it in as
  // `boundCredentialSessionId`.
  //
  // This does NOT widen sandbox access. A session-bound credential still
  // carries its real id, so it still reaches only its own backend session; a
  // human simply stops being mistaken for one and falls through to the
  // ordinary ownership/visibility/grant checks below.
  //
  // The field stays optional, so a caller that does narrowing alone and never
  // sourced the binding keeps its previous behaviour rather than silently
  // widening.
  const binding =
    ownership.boundCredentialSessionId !== undefined
      ? ownership.boundCredentialSessionId
      : ownership.callerSessionId;
  return !(
    ownership.origin === 'backend' &&
    binding != null &&
    binding !== ownership.sessionId
  );
}

/** Pure: can this subject see/open the session? The owner always can. */
export function isSessionVisibleTo(
  visibility: SessionVisibility,
  ownerId: string | null,
  grants: SecretGrant[],
  subject: ShareSubject,
  ownership: SessionNarrowingContext,
): boolean {
  // A sandbox token acts for ONE end-user. It must not reach a sibling backend
  // session just because the wrapper credential created them both. Interactive
  // sessions are deliberately excluded: there created_by really is one person,
  // and narrowing would break `kortix sessions ls` from inside a normal sandbox.
  if (!isSessionTargetVisibleToCaller(ownership)) return false;

  if (ownerId && ownerId === subject.userId) return true;
  if (visibility === 'project') return true;
  if (visibility === 'restricted') {
    for (const g of grants) {
      if (g.principalType === 'member' && g.principalId === subject.userId) return true;
      if (g.principalType === 'group' && subject.groupIds.includes(g.principalId)) return true;
    }
  }
  return false;
}

/**
 * True only for sessions stamped by the durable trigger create path.
 * Both fields are required so a partial marker cannot widen access.
 */
export function isTriggerCreatedSessionMetadata(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return false;
  const record = metadata as Record<string, unknown>;
  return (
    typeof record.source === 'string' &&
    record.source.startsWith('trigger:') &&
    record.trigger_kind === 'git' &&
    typeof record.trigger_slug === 'string' &&
    record.trigger_slug.length > 0
  );
}

/**
 * Project-session content visibility. Project managers can open sessions that
 * triggers created. Ordinary private human sessions remain owner-only. The
 * backend sibling-session gate runs first and cannot be bypassed.
 */
export function isProjectSessionVisibleTo(
  visibility: SessionVisibility,
  ownerId: string | null,
  grants: SecretGrant[],
  subject: ShareSubject,
  ownership: SessionOwnershipContext,
  context: { metadata: unknown; canManageProject: boolean },
): boolean {
  if (!isSessionTargetVisibleToCaller(ownership)) return false;
  // The manager override is for callers that are NOT a session-bound agent
  // credential. A sandbox/agent token whose launching user happens to hold
  // `manage` would otherwise read every OTHER trigger-created private session
  // in the project — the sibling reach the ownership gate exists to deny.
  //
  // Gated on `boundCredentialSessionId`, NOT `callerSessionId`: the latter is
  // the Supabase login session id for ordinary humans, so gating on it would
  // strip managers of the override in the dashboard. See the field docs above.
  if (
    ownership.boundCredentialSessionId === null &&
    context.canManageProject &&
    isTriggerCreatedSessionMetadata(context.metadata)
  ) {
    return true;
  }
  return isSessionVisibleTo(visibility, ownerId, grants, subject, ownership);
}

/** Map a sharing intent → persisted (visibility, grants). */
export function sessionIntentToVisibility(intent: SharingIntent): {
  visibility: SessionVisibility;
  grants: SecretGrant[];
} {
  if (intent.mode === 'project') return { visibility: 'project', grants: [] };
  if (intent.mode === 'private') return { visibility: 'private', grants: [] };
  const grants: SecretGrant[] = [
    ...(intent.memberIds ?? []).map((id) => ({ principalType: 'member' as const, principalId: id })),
    ...(intent.groupIds ?? []).map((id) => ({ principalType: 'group' as const, principalId: id })),
  ];
  // Empty allow-list collapses to private (owner only).
  if (grants.length === 0) return { visibility: 'private', grants: [] };
  return { visibility: 'restricted', grants };
}

/** Inverse of sessionIntentToVisibility — for rendering the current selection. */
export function visibilityToIntent(visibility: SessionVisibility, grants: SecretGrant[]): SharingIntent {
  if (visibility === 'project') return { mode: 'project' };
  if (visibility === 'private') return { mode: 'private', ownerId: '' };
  const memberIds = grants.filter((g) => g.principalType === 'member').map((g) => g.principalId);
  const groupIds = grants.filter((g) => g.principalType === 'group').map((g) => g.principalId);
  return { mode: 'members', memberIds, groupIds };
}

/**
 * A session created while another running session's own token is the caller
 * (a sub-agent/coordinator spawning a worker) inherits THAT session's sharing
 * instead of defaulting to private. Without this, a worker a coordinator
 * spawns is invisible to anyone the coordinator was shared with — only the
 * human who happens to match `created_by` could ever open it, which defeats
 * the point of sharing the parent in the first place.
 *
 * `requestedVisibility` explicit (automation callers — triggers, channels —
 * always pass one) wins outright and carries no inherited grants: those
 * callers manage their own sharing story and were never eligible to inherit.
 * `parent` is null when there is no spawning session, or it could not be
 * resolved (defense in depth) — falls back to the private default.
 */
export function resolveInheritedSessionSharing(
  requestedVisibility: SessionVisibility | undefined,
  parent: { visibility: SessionVisibility; grants: SecretGrant[] } | null,
): { visibility: SessionVisibility; grants: SecretGrant[] } {
  if (requestedVisibility !== undefined) return { visibility: requestedVisibility, grants: [] };
  if (parent) return { visibility: parent.visibility, grants: parent.grants };
  return { visibility: 'private', grants: [] };
}

/** Bulk-load session grants → map sessionId → grants. */
export async function loadSessionGrants(sessionIds: string[]): Promise<Map<string, SecretGrant[]>> {
  const out = new Map<string, SecretGrant[]>();
  if (sessionIds.length === 0) return out;
  const rows = await db
    .select({
      sessionId: projectSessionGrants.sessionId,
      principalType: projectSessionGrants.principalType,
      principalId: projectSessionGrants.principalId,
    })
    .from(projectSessionGrants)
    .where(inArray(projectSessionGrants.sessionId, sessionIds));
  for (const r of rows) {
    const list = out.get(r.sessionId) ?? [];
    list.push({ principalType: r.principalType as 'member' | 'group', principalId: r.principalId });
    out.set(r.sessionId, list);
  }
  return out;
}

/** Persist a session's sharing: set visibility + replace its grants. */
export async function setSessionSharing(sessionId: string, intent: SharingIntent): Promise<void> {
  const { visibility, grants } = sessionIntentToVisibility(intent);
  await db.update(projectSessions).set({ visibility, updatedAt: new Date() }).where(eq(projectSessions.sessionId, sessionId));
  await db.delete(projectSessionGrants).where(eq(projectSessionGrants.sessionId, sessionId));
  if (grants.length > 0) {
    await db.insert(projectSessionGrants).values(
      grants.map((g) => ({ sessionId, principalType: g.principalType, principalId: g.principalId })),
    );
  }
}

/**
 * Who may CHANGE a session's sharing policy — a strictly narrower question than
 * `canManageLifecycle` (stop / restart / delete / model), which stays
 * manager-tier.
 *
 * Sharing is the owner's decision. Two distinct writes ask this, and each had
 * its own defect:
 *
 *  1. `PUT .../sharing`. It runs behind the content-visibility gate, so a
 *     manager never reaches another human's PRIVATE session (that 404s). What
 *     they did reach is a session shared WITH them — project-wide or on the
 *     allow-list — where they could rewrite the owner's policy wholesale and
 *     revoke everyone, the owner included. Sharing something with a manager is
 *     not handing them its access list.
 *  2. `POST .../public-shares`. It deliberately runs in FRONT of the
 *     visibility gate (see loadSessionForSharing), and a public link is
 *     unauthenticated. A manager could therefore mint a link against a private
 *     session they cannot read and open it anonymously — the read the
 *     visibility gate had just refused. That one is a real escalation.
 *
 * `private` also means "the OWNER only", never "only the person editing", so a
 * non-owner who saves it revokes their own access with no undo. That specific
 * trap is `sharingChangeKeepsEditorAccess` below.
 *
 * The one exception is a session NOBODY owns: a trigger/agent run is stamped
 * with the agent's service-account id, so there is no human owner to defend and
 * an owner-only rule would make the policy permanently unchangeable. A project
 * manager governs those. A `created_by` that is neither (a removed user) stays
 * owner-only — fail closed; the manager's remedy is deleting the session.
 */
export function mayManageSessionSharing(input: {
  isOwner: boolean;
  canManageProject: boolean;
  /** True when `created_by` names a service account, or names nobody at all. */
  ownerIsMachine: boolean;
}): boolean {
  if (input.isOwner) return true;
  return input.canManageProject && input.ownerIsMachine;
}

/**
 * The denial wording for the two owner-governed sharing writes. Exported so the
 * routes, the flow contracts and the spec quote ONE string each.
 *
 * Phrased "only the session owner" with no manager escape hatch, because that
 * is true for every caller who can actually reach it: a manager is refused only
 * on a session a human owns, and a machine-owned session admits the manager
 * instead of producing this message.
 */
export const SESSION_SHARING_OWNER_ONLY_ERROR =
  'Only the session owner can change who opens this session';
export const PUBLIC_SHARE_OWNER_ONLY_ERROR =
  'Only the session owner can create a public link to this session';

/**
 * A sharing change must never remove the editor's own access.
 *
 * The concrete bug: a manager opens someone else's session, picks "Only you",
 * and is locked out on save — because `private` means "the OWNER only", and the
 * owner is somebody else. The undo needs the read the save just revoked, so the
 * session is gone for good. Owners are structurally safe (every mode keeps the
 * owner), so after `mayManageSessionSharing` this only ever fires for a
 * machine-owned session being edited by a project manager.
 */
export function sharingChangeKeepsEditorAccess(input: {
  isOwner: boolean;
  visibility: SessionVisibility;
  grants: SecretGrant[];
  subject: ShareSubject;
}): boolean {
  if (input.isOwner) return true;
  if (input.visibility === 'project') return true;
  if (input.visibility === 'restricted') {
    return input.grants.some(
      (grant) =>
        (grant.principalType === 'member' && grant.principalId === input.subject.userId) ||
        (grant.principalType === 'group' && input.subject.groupIds.includes(grant.principalId)),
    );
  }
  return false;
}

export const SHARING_SELF_LOCKOUT_ERROR =
  'That would remove your own access to this session. Add yourself, or share it with the whole project.';
