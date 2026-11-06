/**
 * THE canonical authorization engine. One function, one fixed precedence, ten
 * steps, reading only the canonical stores.
 *
 * REPLACES `iam/engine-v2.ts` (authorizeV2, resolveActorV2, loadProjectRoleRows,
 * deriveEffectiveProjectRole, customPolicyAllows, computeTokenScope,
 * agentGrantGates, listAccessibleProjectsV2, filterAccessibleProjectResources),
 * `projects/access.ts` (effectiveProjectRole, the retired roleAllows,
 * foldEffectiveProjectAccess) and `iam/resource-grants.ts`'s fold
 * (isProjectResourceUsableByMember, isResourceAccessible, …) — four independent
 * copies of the max-role fold and three parallel permission vocabularies.
 *
 * WHAT IT READS
 *   kortix.role_assignments  every grant: membership, project roles, group
 *                            grants, custom-role bindings, object grants
 *   kortix.iam_roles         (canonical name: kortix.roles) system + custom roles
 *   kortix.iam_role_actions  (canonical name: kortix.role_permissions)
 *   kortix.permissions       the action catalog + its scope classifier
 *   kortix.object_policies   the unscoped-object default, per object type
 *
 * WHAT IT ALSO READS, AND WHY THAT IS NOT A LEGACY DEPENDENCY
 *   account_members.is_super_admin  a hard, audited bypass, deliberately NOT a
 *     role (spec §1). 22,408 of 33,363 local membership rows carry it, so
 *     turning it into an assignment would start evaluating folds that have been
 *     dead for two thirds of principals.
 *   accounts.mfa_required           an account setting, not a permission.
 *   account_group_members           (canonical name: kortix.group_members) —
 *     group MEMBERSHIP, which is an identity fact, not a grant.
 *   service_accounts                the principal must exist and be active.
 * It reads NONE of project_members, project_group_grants, iam_policies,
 * iam_resource_grants or account_members.account_role.
 */
import { timeStage } from '../lib/server-timing';
import { and, eq, gt, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { accountGroupMembers, accountMembers, iamRoleActions, iamRoles, roleAssignments, serviceAccounts } from '@kortix/db';
import { ssoProviderIdOf } from '../shared/auth-identity';
import { db } from '../shared/db';
import { qualifiedColumn } from '../shared/sql-qualified-column';
import { retryTransientDatabaseRead } from '../shared/database-errors';
import { isImpersonatingAccount, isImpersonationBlockedAccount } from '../shared/impersonation';
import { isUuid } from '../shared/validate';
import { isMyKortixAgentName } from '@kortix/shared';
import { isHumanOnlyAction, toLegacyAction } from '@kortix/shared/workspace-actions';
import { ttlMemo } from '../shared/ttl-memo';
import { agentMayPerform } from './agent-scope';
import { keyScopeAllows } from './key-scope';
import { AGENT_DEFAULT_CEILING, agentPrincipalDecision } from './agent-principal';
import {
  loadPermissionCatalog,
  loadSystemRoles,
  scopeForUncatalogedAction,
  unscopedDefaultFor,
  type ObjectType,
  type ScopeType,
} from './catalog';
import { registerPrincipalScopedMemo, registerProjectScopedMemo } from './cache-invalidation';
import { clearWorkspaceFacts, workspaceFactsOf } from './workspace-facts';
import { buildDenialError } from './denial-message';
import type { WorkspaceRole } from './roles';
import {
  actingPrincipal,
  actingTokenBinding,
  isAgentSessionToken,
  type Actor,
  type PrincipalRef,
} from './actor';
import { accountsView, projectsView } from '../workspaces/rows';

// ─── Public surface ─────────────────────────────────────────────────────────

/**
 * The object a verdict is about.
 *
 * `workspace` is the one scope (Workspaces, design.md §5): its id is the
 * workspace id (= `project_id`). `account` and `project` are the legacy shapes
 * and stay accepted permanently; `normalizeObj` folds all three into one
 * evaluation, so an old call site and a new one get the same verdict.
 *
 * Assignment reach is unchanged storage, read through one rule. An assignment
 * reaches workspace W when it is
 *   - `scope_type='project' AND scope_id=W`, or
 *   - `scope_type='account' AND account_id=W.account`.
 * For a 1:1 workspace that is today's semantics exactly. For a `split_pending`
 * legacy account (2+ active projects) an account-scope grant reaches every
 * project of the account, which is the permanently supported legacy state:
 * actions on the shared account rows (billing, members, SSO) need an
 * account-scope grant, i.e. a grant on every project of the account.
 */
export type Obj =
  | { type: 'account' }
  | { type: 'project'; id: string; resource?: { type: ObjectType; id: string } }
  | { type: 'workspace'; id: string; resource?: { type: ObjectType; id: string } };

/** The evaluation shape of an `Obj`: workspace and project are one thing. */
type EvalObj =
  | { type: 'account' }
  | { type: 'project'; id: string; resource?: { type: ObjectType; id: string } };

/** Fold the workspace shape onto the project shape the engine evaluates. */
export function normalizeObj(obj: Obj): EvalObj {
  if (obj.type === 'workspace') {
    return obj.resource ? { type: 'project', id: obj.id, resource: obj.resource } : { type: 'project', id: obj.id };
  }
  return obj;
}

/**
 * Why. Denial reasons are byte-identical to the strings `denial-message.ts` is
 * keyed on, because the 403 wording depends on them. The three ALLOW reasons
 * collapse to one (`role`) per spec §2.2: `account_role`, `project_role` and
 * `custom_policy` all mean "a role the principal holds grants this action", and
 * nothing renders them — the distinction only ever leaked the storage shape.
 */
export type Reason =
  | 'impersonation'
  | 'impersonation_scope'
  | 'token_out_of_scope'
  | 'not_a_member'
  | 'super_admin'
  | 'account_mfa_required'
  /** The account requires single sign-on for this person's email domain, and
   *  the credential is not an identity of the account's own IdP. */
  | 'sso_required'
  | 'role'
  | 'account_role_insufficient'
  | 'project_target_required'
  | 'no_project_membership'
  | 'project_role_insufficient'
  | 'service_account_scope_insufficient'
  | 'resource_scope_insufficient'
  | 'agent_scope_insufficient'
  /** Agent-principal model: the action is in the agent's kortix_permissions
   *  but outside the role(s) an admin bound to the agent's service account. */
  | 'agent_ceiling_insufficient'
  /** A HUMAN_ONLY action (minting credentials, moving money; C8). No agent
   *  session, inherited or governed, ever passes it. */
  | 'agent_human_only_action'
  /** A workspace key's scope (`read` or a custom list) does not hold the
   *  action. The creator's role may; a key with that scope never does. */
  | 'key_scope_insufficient'
  /** The workspace is closing (a deletion request is open). Only its owners
   *  keep reading it and restoring it (design.md §3.2 C3). */
  | 'workspace_closed';

export interface Verdict {
  allowed: boolean;
  reason: Reason;
}

/**
 * Which objects of a type the actor may act on.
 *
 * `none` carries the REASON, because a list path owes its caller exactly what
 * the single-resource path owes them. `account_mfa_required` is the denial a
 * person can act on, and a listing that drops it renders as an empty account
 * with no way to discover the remedy — see `list-denial-parity.test.ts`.
 */
export type Accessible =
  | { mode: 'all' }
  | { mode: 'none'; reason?: Reason }
  | { mode: 'allow_only'; allowed: Set<string> };

/**
 * The account-wide MFA gate, written once and consulted by both `authorize`
 * and `listAccessibleProjects`. Browser sessions only: a token's scope was
 * already verified, and a PAT has no second factor to step up with.
 */
export function mfaGateBlocks(
  rec: { accountMfaRequired: boolean },
  tokenId: string | null | undefined,
  mfaAal: string | undefined,
): boolean {
  return rec.accountMfaRequired && !tokenId && mfaAal !== 'aal2';
}

const allow = (reason: Reason): Verdict => ({ allowed: true, reason });
const deny = (reason: Reason): Verdict => ({ allowed: false, reason });

/**
 * The coarse project actions `loadProjectForUser` maps onto. An agent session's
 * kortix.yaml grant must NOT gate them: a route doing
 * `loadProjectForUser('write')` is asking a membership-tier question, and a
 * leaf-scoped agent (e.g. permissions=['project.gitops.push']) still has to pass
 * it — the route's own leaf assertion is what the grant gates. Every OTHER
 * project action is a specific capability the agent must hold.
 */
const AGENT_GRANT_EXEMPT_ACTIONS: ReadonlySet<string> = new Set([
  'project.read',
  'project.write',
]);

/**
 * Authorize `actor` to perform `action` on `obj`.
 *
 * Precedence is fixed and total — every branch below returns, so there is no
 * order in which two rules can both apply:
 *
 *   1  impersonation act-as, then impersonation confinement
 *   1b HUMAN_ONLY for every agent session
 *   1c the workspace key's scope (read, custom), inside the creator's role
 *   2  the acting token's binding
 *   3  the acting principal (activated agent SA, else the launcher)
 *   3b the closing workspace (owners keep read, billing read, restore)
 *   4  token workspace scope
 *   5  super-admin bypass
 *   6  account-MFA gate (browser sessions only)
 *   7  scope containment + role expansion
 *   8  the verdict, and which constraint denied it
 *   9  object grants
 *  10  the agent-session grant intersection
 */
export function authorize(actor: Actor, action: string, obj: Obj = { type: 'account' }): Promise<Verdict> {
  // `Server-Timing: iam` — every capability decision on the request path.
  // Both action names are accepted forever: a workspace name is evaluated as
  // the legacy name it aliases (`@kortix/shared/workspace-actions`), because the
  // catalog and every role row store the legacy name.
  return timeStage('iam', () => authorizeObj(actor, toLegacyAction(action), obj));
}

async function authorizeObj(actor: Actor, action: string, obj: Obj): Promise<Verdict> {
  if (obj.type === 'workspace' && !isImpersonatingAccount(actor.userId, actor.accountId)) {
    // The reach rule's account half: the actor was resolved for one account, and
    // a workspace of another account is never reached by its assignments. Every
    // legacy `project` call site already resolves the actor for the project's own
    // account (`loadProjectForUser` → `actorOf(c, row.accountId)`); a workspace
    // call site gets that guarantee checked instead of assumed.
    const owner = await workspaceAccountOf(obj.id);
    if (owner === null || owner !== actor.accountId) return deny('no_project_membership');
  }
  return authorizeDecision(actor, action, normalizeObj(obj));
}

/**
 * The SSO-only gate alone (step 4a below), for account routes that decide on
 * membership without `authorize` (`GET /v1/accounts/:id`, members, invites,
 * branding, secret resources). `middleware/sso-gate.ts` applies it to every
 * `/v1/accounts/:accountId` request.
 */
export async function ssoRequiredFor(actor: Actor): Promise<boolean> {
  if (isImpersonatingAccount(actor.userId, actor.accountId)) return false;
  const rec = await resolvePrincipal(actingPrincipal(actor), actor.accountId);
  return rec?.accountSsoRequired === true;
}

async function authorizeDecision(actor: Actor, action: string, obj: EvalObj): Promise<Verdict> {
  // 1. ACT-AS. Above everything, and above the principal memo in particular:
  // `resolvePrincipal` is a TTL memo shared across requests, so widening the
  // actor inside it would cache "owner" and serve it to this operator's own
  // NON-impersonated requests for the rest of the window. Short-circuiting here
  // touches no cache at all. The grant was already validated this request by
  // middleware/impersonation.ts.
  if (isImpersonatingAccount(actor.userId, actor.accountId)) return allow('impersonation');
  // Confinement, not just widening: while a grant is live the operator is
  // denied every OTHER account, their own included.
  if (isImpersonationBlockedAccount(actor.userId, actor.accountId)) return deny('impersonation_scope');

  // 1b. HUMAN_ONLY (C8): minting credentials and moving money stay with
  // people. Every agent session, inherited (it acts as its launcher) or
  // governed (it acts as its service account), and above the super-admin
  // bypass: the launcher's bypass is exactly the power that must not pass to
  // the agent. This is the ONE agent wall; everything else is a grant.
  // A session token that names no service account (My Kortix) reads as a PAT;
  // its binding says it is a session, so the binding is read first.
  // 2. The acting token's binding: project confinement, agent grant, standing
  // identity — one memoized read, skipped entirely for browser requests.
  const { tokenId, binding } = await actingTokenBinding(actor);
  if (isHumanOnlyAction(action) && isAgentSessionToken(actor, binding)) {
    return deny('agent_human_only_action');
  }

  // 1c. KEY SCOPE (design.md §3.2 C4a): a workspace key does what its scope
  // allows, and the rest of this function still decides the creator's CURRENT
  // role, so a key never exceeds it. Above the super-admin bypass: a read key
  // the workspace creator minted stays read-only.
  if (binding?.scopes && !keyScopeAllows(binding.scopes, action)) return deny('key_scope_insufficient');

  const catalog = await loadPermissionCatalog();
  const entry = catalog.byAction.get(action);
  const scope: ScopeType = entry?.scopeType ?? scopeForUncatalogedAction(action);

  // 3. The acting principal.
  const principal = actingPrincipal(actor);
  const [rec, facts] = await Promise.all([
    resolvePrincipal(principal, actor.accountId),
    workspaceFactsOf(actor.accountId),
  ]);
  if (!rec) return deny('not_a_member');

  // 3b. A CLOSING workspace (its deletion request is open): everyone loses it
  // at once except its owners, who keep reading it, reading its billing and
  // restoring it until the grace ends. Above the super-admin bypass: the bypass
  // must not keep a deleted workspace usable.
  if (facts.closing && !(rec.accountRoleKey === 'owner' && CLOSING_OWNER_ACTIONS.has(action))) {
    return deny('workspace_closed');
  }

  // 4. A token bound to one workspace is refused on every other workspace. An
  // account-scope action is in scope when it names the token's own workspace:
  // the account is the workspace's, and the workspace is not split_pending.
  if (!tokenScopeAllows(binding, tokenId, rec.kind, scope, obj, facts.soleProjectId)) return deny('token_out_of_scope');

  // 4a. SSO only. Above the super-admin bypass: the account creator holds
  // `is_super_admin`, and enforcement exists to close exactly that person's
  // password door. Every credential of a non-SSO identity in the enforced
  // domain is refused, a PAT included; an identity of the account's own IdP
  // passes. Break-glass for a broken IdP: a platform admin marks the domain
  // unverified (`PUT /v1/admin/api/accounts/:id/sso-domain-verification`),
  // which lifts enforcement.
  if (rec.accountSsoRequired) return deny('sso_required');

  // 5. Super-admin. Above the MFA gate on purpose: flipping account MFA must
  // never be able to lock an account out permanently.
  if (rec.isSuperAdmin) return allow('super_admin');

  // 5a. AGENT PRINCIPAL (every governed grant). The
  // session IS the agent: grant ∩ ceiling − HUMAN_ONLY. The launcher's role and
  // super-admin bit never reach this point — the principal is the agent's
  // service account (actingPrincipal), so step 5 above cannot fire for it.
  if (actor.credential.kind === 'agent_session' && actor.credential.agentPrincipal && binding?.agentGrant) {
    const grant = binding.agentGrant;
    const target = obj.type === 'project' ? obj.id : null;
    // Bound roles are the ceiling as soon as ANY live role is bound (activated),
    // including a zero-action custom role that pins the agent to deny. With
    // none bound, the built-in default ceiling applies.
    const bound = actor.credential.activated;
    const roles = bound && (target || scope === 'account') ? await loadSystemRoles() : null;
    const systemRole = roles && target ? effectiveProjectRole(roles, rec, target, facts.soleProjectId) : null;
    const verdict = agentPrincipalDecision({
      action,
      scope,
      targetProjectId: target,
      tokenProjectId: binding.projectId,
      accountInScope: binding.projectId !== null && binding.projectId === facts.soleProjectId,
      grant,
      ceilingAllows: (a) =>
        bound
          ? scope === 'account'
            ? rec.accountRoleActions.has(a) || customRoleAllows(rec, scope, a, obj)
            : (systemRole !== null && systemRole.actions.has(a)) || customRoleAllows(rec, scope, a, obj)
          : AGENT_DEFAULT_CEILING.has(a),
    });
    return verdict.allowed ? allow('role') : deny(verdict.reason);
  }

  // 6. Account-wide MFA. Browser sessions only — a token's scope was just
  // verified in step 4, and a PAT has no second factor to step up with.
  if (mfaGateBlocks(rec, tokenId, actor.ctx.mfaAal)) {
    return deny('account_mfa_required');
  }

  // 7/8. Account scope.
  if (scope === 'account') {
    if (rec.kind === 'member' && rec.accountRoleActions.has(action)) return allow('role');
    if (customRoleAllows(rec, scope, action, obj)) return allow('role');
    return deny('account_role_insufficient');
  }

  if (obj.type !== 'project') return deny('project_target_required');

  // A custom role can grant project access with NO system project role at all
  // (the department case), so the system role is one source in the union, not a
  // gate. A service account has no membership, so no IMPLICIT project role, but
  // a system project role (`manager`/`member`) an admin binds to it counts
  // exactly like a custom one. Before 2026-09-22 only members read system
  // roles here: binding `member` to an agent's service account activated it and
  // granted nothing, bricking the agent (spec §1.5).
  const roles = await loadSystemRoles();
  const systemRole = effectiveProjectRole(roles, rec, obj.id, facts.soleProjectId);
  const granted =
    (systemRole !== null && systemRole.actions.has(action)) || customRoleAllows(rec, scope, action, obj);

  if (!granted) {
    if (rec.kind === 'service_account') return deny('service_account_scope_insufficient');
    if (systemRole === null) return deny('no_project_membership');
    return deny('project_role_insufficient');
  }

  // 9. OBJECT GRANTS. Only for a human member below the implicit-manager tier:
  // account owners/admins and service accounts bypass, exactly as today.
  //
  // A project `manager` does NOT bypass — an explicit grant restricts them as
  // much as it restricts a member, which is what makes "scope this agent to the
  // finance group" mean anything. What the manager tier buys is the UNSCOPED
  // default, and that default is now a property of the OBJECT TYPE
  // (object_policies) rather than an argument threaded through the caller.
  if (obj.resource && rec.kind === 'member' && !isImplicitManager(rec.accountRoleKey)) {
    const managerTier = systemRole !== null && systemRole.actions.has('project.write');
    const grants = await loadObjectGrants(obj.id, obj.resource.type);
    const usable = await objectUsable(
      obj.resource.type,
      grants.get(obj.resource.id),
      principal.id,
      rec.groupIds,
      managerTier,
      obj.resource.id,
    );
    if (!usable) return deny('resource_scope_insufficient');
  }

  // 10. role ∩ agent grant, for a token that carries a grant but did not take
  // step 5a (a session token with no service account). Kept as the backstop so
  // a grant is never ignored; a no-op for a null grant and for `all`.
  if (tokenId && !AGENT_GRANT_EXEMPT_ACTIONS.has(action)) {
    if (!agentMayPerform(binding?.agentGrant ?? null, action)) {
      return deny('agent_scope_insufficient');
    }
  }

  return allow('role');
}

/**
 * effective(agent, action) for a surface that does not go through a route gate
 * — the App gate (apps/access.ts), the connector gateway. Spec 2026-09-22 §2.1:
 * `action ∈ kortix_permissions ∧ action ∈ ceiling ∧ action ∉ HUMAN_ONLY`, asked
 * of the session's own project (or `projectId`).
 *
 * Returns false for any actor that is NOT an agent session under the
 * agent-principal model (ungoverned grant, human, PAT): those callers
 * keep their existing decision path. Check `isAgentPrincipalActor(actor)`
 * (iam/actor.ts) first to choose the path.
 */
export async function agentEffectiveAllows(actor: Actor, action: string, projectId?: string): Promise<boolean> {
  return (await agentEffectiveVerdict(actor, action, projectId)).allowed;
}

/** `agentEffectiveAllows` with the verdict reason, for a coded denial. */
export async function agentEffectiveVerdict(actor: Actor, action: string, projectId?: string): Promise<Verdict> {
  const c = actor.credential;
  if (c.kind !== 'agent_session' || !c.agentPrincipal) return deny('agent_scope_insufficient');
  const target = projectId ?? c.projectId;
  if (!target) return deny('project_target_required');
  return authorize(actor, action, { type: 'project', id: target });
}

/** `authorize`, but a denial throws the 403 the route layer surfaces. */
export async function assertAuthorized(actor: Actor, action: string, obj: Obj = { type: 'account' }): Promise<void> {
  const verdict = await authorize(actor, action, obj);
  if (!verdict.allowed) throw buildDenialError(action, verdict.reason);
}

/**
 * Batch sibling: which resources of `resourceType` may the actor perform
 * `action` on. Kept because a per-item loop would be an N+1 on the hottest
 * pages — `GET /v1/projects` and the agent/skill lists.
 *
 * Returns the accessible PROJECT ids. Every other resource type is reached
 * through its project and answered by `filterAccessibleObjects`, which takes
 * the ids the manifest declares — see the note in the body.
 */
export async function listAccessible(
  actor: Actor,
  rawAction: string,
  resourceType: 'project' | 'workspace' | ObjectType,
): Promise<Accessible> {
  const action = toLegacyAction(rawAction);
  // A workspace IS a project row: listing workspaces lists projects.
  if (resourceType === 'workspace') return listAccessibleProjects(actor, action);
  // Only projects are listable standalone. An object (an agent, a skill) is
  // always reached THROUGH its project, and the caller already holds the ids
  // the manifest declares — `filterAccessibleObjects` is that surface, and it
  // can answer the unscoped-default question the id-less `Accessible` shape
  // cannot express.
  if (resourceType !== 'project') return { mode: 'none' };
  return listAccessibleProjects(actor, action);
}

function listAccessibleProjects(actor: Actor, action: string): Promise<Accessible> {
  return timeStage('iam', () => listAccessibleProjectsUntimed(actor, action));
}

async function listAccessibleProjectsUntimed(actor: Actor, action: string): Promise<Accessible> {
  // Same short-circuit as authorize, for the same cache reason. Without it the
  // operator sees an empty project list inside an account whose every project
  // they can already open by id — a confusing half-state, not a narrower one.
  if (isImpersonatingAccount(actor.userId, actor.accountId)) return { mode: 'all' };
  if (isImpersonationBlockedAccount(actor.userId, actor.accountId)) {
    return { mode: 'none', reason: 'impersonation' };
  }

  const { tokenId, binding } = await actingTokenBinding(actor);
  const principal = actingPrincipal(actor);
  const [rec, facts] = await Promise.all([
    resolvePrincipal(principal, actor.accountId),
    workspaceFactsOf(actor.accountId),
  ]);
  if (!rec) return { mode: 'none', reason: 'not_a_member' };

  // A closing workspace lists for its owners only (the canonical list serves
  // it to them as `deleting`); `authorize` below decides each action.
  if (facts.closing && rec.accountRoleKey !== 'owner') return { mode: 'none', reason: 'workspace_closed' };

  // A token bound to one project narrows the listing to that project, for a
  // human PAT and an agent session alike. A direct service-account bearer has
  // no account_tokens row, so its own assignments drive the listing below; a
  // null binding for anything else is a revoked token.
  if (tokenId) {
    if (!binding) {
      if (rec.kind !== 'service_account') return { mode: 'none', reason: 'token_out_of_scope' };
    } else if (binding.projectId) {
      const v = await authorize(actor, action, { type: 'project', id: binding.projectId });
      return v.allowed
        ? { mode: 'allow_only', allowed: new Set([binding.projectId]) }
        : { mode: 'none', reason: v.reason };
    }
  }

  // SSO only IS applied to the listing, unlike MFA below: the remedy is a new
  // sign-in through the IdP, not a step-up on this page, and a password
  // identity of the enforced domain must not enumerate the account's projects.
  if (rec.accountSsoRequired) return { mode: 'none', reason: 'sso_required' };

  if (rec.isSuperAdmin) return { mode: 'all' };

  // The account-wide MFA gate is DELIBERATELY not applied here. Enumerating a
  // project is not using it: every per-project action goes through
  // `authorize`, which still denies `account_mfa_required` and returns the
  // coded 403 that opens the step-up dialog. Gating the LIST instead turned
  // opening the project switcher into a modal auth challenge, and before that
  // (when the listing swallowed the reason) into an account that looked empty.
  // Show the projects; challenge on open. See `list-denial-parity.test.ts`.

  const roles = await loadSystemRoles();

  // Owner/admin hold implicit Manager on every project: allowed unless Manager
  // itself lacks the action.
  if (isImplicitManager(rec.accountRoleKey)) {
    const manager = roles.byKey.get('project:manager');
    return manager?.actions.has(action) ? { mode: 'all' } : { mode: 'none', reason: 'role' };
  }

  const allowed = new Set<string>();
  // Membership is access (C3): an account member reaches the account's one
  // workspace at the member tier while it is not split_pending.
  if (rec.accountRoleKey === 'member' && facts.soleProjectId && roles.byKey.get('project:member')?.actions.has(action)) {
    allowed.add(facts.soleProjectId);
  }
  for (const [projectId, roleIds] of rec.projectSystemRoleIds) {
    for (const roleId of roleIds) {
      if (roles.byId.get(roleId)?.actions.has(action)) {
        allowed.add(projectId);
        break;
      }
    }
  }
  // Custom roles union in: an account-scoped one covers every project, a
  // project-scoped one adds just its project — so a department member sees the
  // company project with no system project role at all.
  for (const ca of rec.customActions) {
    if (ca.action !== action) continue;
    if (ca.scopeType === 'account') return { mode: 'all' };
    if (ca.scopeType === 'project' && ca.scopeId) allowed.add(ca.scopeId);
  }
  return { mode: 'allow_only', allowed };
}

/**
 * Of `objectIds`, the ones the actor may use. The list form of step 9 — used by
 * the agent/skill pickers, which must not render an object the caller cannot
 * launch. Preserves input order, one memo hit for the whole list.
 */
export async function filterAccessibleObjects(
  actor: Actor,
  projectId: string,
  objectType: ObjectType,
  objectIds: readonly string[],
): Promise<string[]> {
  if (objectIds.length === 0) return [];
  // Step 1, as in `authorize`: act-as runs every agent of the target account,
  // and nothing anywhere else. Checked before the principal memo.
  if (isImpersonatingAccount(actor.userId, actor.accountId)) return [...objectIds];
  if (isImpersonationBlockedAccount(actor.userId, actor.accountId)) return [];
  const principal = actingPrincipal(actor);
  const [rec, facts] = await Promise.all([
    resolvePrincipal(principal, actor.accountId),
    workspaceFactsOf(actor.accountId),
  ]);
  if (!rec) return [];
  if (facts.closing && rec.accountRoleKey !== 'owner') return [];
  if (rec.isSuperAdmin) return [...objectIds];
  if (rec.kind !== 'member') return [...objectIds];
  if (isImplicitManager(rec.accountRoleKey)) return [...objectIds];

  const roles = await loadSystemRoles();
  const systemRole = effectiveProjectRole(roles, rec, projectId, facts.soleProjectId);
  // Step 8 before step 9, as in `authorize`: the Slack and Teams pickers reach
  // here with only an account member, and a `project` grant names everyone IN
  // the project, not everyone in the account.
  const inProject =
    (systemRole !== null && systemRole.actions.has('project.read')) ||
    customRoleAllows(rec, 'project', 'project.read', { type: 'project', id: projectId });
  if (!inProject) return [];
  const managerTier = systemRole !== null && systemRole.actions.has('project.write');
  const grants = await loadObjectGrants(projectId, objectType);
  const unscopedOpen = (await unscopedDefaultFor(objectType)) === 'open';

  const groups = new Set(rec.groupIds);
  return objectIds.filter((id) => {
    const principals = grants.get(id);
    if (!principals || principals.length === 0) return unscopedOpen || managerTier || openToEveryMember(objectType, id);
    return principals.some((p) => objectGrantReaches(p, principal.id, groups));
  });
}

/**
 * Does ONE object grant name this principal?
 *
 *   user     -> that user
 *   group    -> any member of that group
 *   project  -> everyone with access to the project. The grant map is loaded
 *               per project, so a `project` row here is always the caller's
 *               own project, and the caller has already passed the
 *               project-role check. The DB shape check keeps `principal_id =
 *               scope_id` for every writer.
 *
 * Any other kind grants nothing.
 */
export function objectGrantReaches(
  grant: { principalType: string; principalId: string },
  principalId: string,
  groupIds: ReadonlySet<string>,
): boolean {
  if (grant.principalType === 'project') return true;
  if (grant.principalType === 'user') return grant.principalId === principalId;
  if (grant.principalType === 'group') return groupIds.has(grant.principalId);
  return false;
}

// ─── Pure decision helpers (exported for unit tests) ────────────────────────

/**
 * Is the acting token in scope for this request? Computed from the binding
 * already loaded — no extra query.
 *
 *   no token                 -> true  (browser)
 *   null binding             -> true only for a direct service-account bearer,
 *                               which has no account_tokens row at all; a null
 *                               binding for anything else is a revoked token
 *   unscoped token           -> true, falls through to permissions
 *   account-scope action     -> true only when the token's workspace IS the
 *                               actor's account's one workspace (1:1, not
 *                               split_pending): the account half of the token's
 *                               own workspace (design.md §3.2 C4)
 *   any other project        -> false
 *
 * `accountWorkspaceId` is the actor's account's one live workspace, or null
 * when it has none or is split_pending.
 */
export function tokenScopeAllows(
  binding: { projectId: string | null } | null,
  tokenId: string | undefined,
  principalKind: 'member' | 'service_account',
  scope: ScopeType,
  rawObj: Obj,
  accountWorkspaceId: string | null = null,
): boolean {
  if (!tokenId) return true;
  if (!binding) return principalKind === 'service_account';
  if (!binding.projectId) return true;
  if (scope === 'account') return accountWorkspaceId !== null && binding.projectId === accountWorkspaceId;
  const obj = normalizeObj(rawObj);
  if (obj.type !== 'project') return false;
  return obj.id === binding.projectId;
}

/** Owner and admin hold implicit Manager on every project in their account. */
export function isImplicitManager(accountRoleKey: string | null): boolean {
  return accountRoleKey === 'owner' || accountRoleKey === 'admin';
}

/**
 * The one object an unscoped `closed` type still opens to every project member:
 * My Kortix, the built-in agent. It holds no connector or secret of its own and
 * acts with exactly the person's role, so an agent grant would add nothing; a
 * hand-off it makes is a new session, authorized against that agent's grants.
 * Grant rows on it still decide, as on any object.
 */
export function openToEveryMember(objectType: string, objectId: string): boolean {
  return objectType === 'agent' && isMyKortixAgentName(objectId);
}

/**
 * Is this object usable? THE object rule, and the only place that decides what
 * "nobody scoped this" means.
 *
 *   no grant rows at all -> the OBJECT TYPE's default (agents closed, the rest
 *                           open), with the manager tier always getting open
 *   >=1 grant row        -> only the named principals, identically for both
 *                           tiers (`objectGrantReaches`; a `project` row names
 *                           everyone in the project)
 */
export async function objectUsable(
  objectType: string,
  grantsForObject: Array<{ principalType: string; principalId: string }> | undefined,
  principalId: string,
  groupIds: readonly string[],
  managerTier: boolean,
  /** The object's id, for the objects open to every member ({@link openToEveryMember}). */
  objectId?: string,
): Promise<boolean> {
  if (!grantsForObject || grantsForObject.length === 0) {
    if (managerTier) return true;
    if (objectId !== undefined && openToEveryMember(objectType, objectId)) return true;
    return (await unscopedDefaultFor(objectType)) === 'open';
  }
  const groups = new Set(groupIds);
  return grantsForObject.some((g) => objectGrantReaches(g, principalId, groups));
}

// ─── Principal resolution ───────────────────────────────────────────────────

const TTL_MS = (() => {
  const raw = Number(process.env.IAM_CACHE_TTL_MS);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 15_000;
})();

/** An action a CUSTOM role grants the principal, and where it applies. */
export interface CustomAction {
  scopeType: string;
  scopeId: string | null;
  action: string;
}

interface PrincipalRecord {
  /** 'member' = an account member (has a system role at account scope).
   *  'service_account' = a machine identity with no membership baseline. */
  kind: 'member' | 'service_account';
  isSuperAdmin: boolean;
  accountMfaRequired: boolean;
  /** The account enforces SSO on a verified domain, this principal's email is
   *  in that domain, and the principal is not an identity of that IdP. */
  accountSsoRequired: boolean;
  /** 'owner' | 'admin' | 'member', from the system role held at account scope. */
  accountRoleKey: string | null;
  accountRoleActions: ReadonlySet<string>;
  groupIds: string[];
  /** projectId -> the SYSTEM project roles held there (direct or via a group). */
  projectSystemRoleIds: ReadonlyMap<string, string[]>;
  /** Actions from NON-system (account-authored) roles. */
  customActions: CustomAction[];
}

/**
 * Everything about the principal that does not depend on the object.
 *
 * FOUR queries, all in ONE `Promise.all` — depth, not count, is what costs time
 * on a page that fires 10+ authorized requests in parallel. That is the same
 * depth `resolveActorV2` had, and it must not grow: `loadProjectForUser` alone
 * runs at 194 call sites.
 *
 * Positive-only caching, deliberately: a freshly granted member sees access on
 * their very next request, while a revoked one keeps it for at most one TTL
 * window. That asymmetry is the existing security posture, and every write path
 * calls `invalidateIamCacheForUser` to close the revoke side on the writing
 * replica.
 */
async function resolvePrincipalUncached(
  principal: PrincipalRef,
  accountId: string,
): Promise<PrincipalRecord | null> {
  if (!accountId) return null;
  // A malformed account id (a slug, a stray literal segment) never matches a
  // membership, and letting it reach the uuid-typed casts below ends the
  // request as SQLSTATE 22P02 → an opaque 500 (Better Stack pattern 97669531,
  // KRTX-211). Answer the same "no membership" the engine answers for a real
  // non-member id — every account-scoped route the engine authorizes gets its
  // own denial shape, never a 500.
  if (!isUuid(accountId)) return null;
  const pid = principal.id;

  // Group membership drives two of the four queries, so it is inlined as a
  // subquery rather than awaited first — otherwise the whole resolve becomes
  // two round trips instead of one.
  const memberGroups = db
    .select({ gid: accountGroupMembers.groupId })
    .from(accountGroupMembers)
    .where(eq(accountGroupMembers.userId, pid));

  const principalMatches = or(
    and(eq(roleAssignments.principalType, 'user'), eq(roleAssignments.principalId, pid)),
    and(eq(roleAssignments.principalType, 'group'), inArray(roleAssignments.principalId, memberGroups)),
    and(eq(roleAssignments.principalType, 'service_account'), eq(roleAssignments.principalId, pid)),
  );
  const live = or(isNull(roleAssignments.expiresAt), gt(roleAssignments.expiresAt, sql`now()`));

  const [identityRows, groupRows, assignmentRows, customRows] = await Promise.all([
    // is_super_admin and mfa_required are NOT permissions — see the module note.
    db
      .select({
        isSuperAdmin: accountMembers.isSuperAdmin,
        mfaRequired: accountsView.mfaRequired,
        // SSO only: the account's IdP enforces sign-in for a domain it proved
        // control of, this person's email is in that domain, and this auth user
        // is not an identity of that IdP (a password, email-code or social
        // identity, or another IdP's). A subquery of the same read, so the
        // resolve stays one round trip deep.
        ssoRequired: sql<boolean>`EXISTS (
          SELECT 1
            FROM kortix.account_sso_providers enforcing
            JOIN auth.users person ON person.id = ${pid}::uuid
           WHERE enforcing.account_id = ${qualifiedColumn(accountsView.accountId)}
             AND enforcing.enforce_sso
             AND enforcing.domain_verified_at IS NOT NULL
             AND enforcing.primary_domain = split_part(lower(trim(person.email)), '@', 2)
             AND ${ssoProviderIdOf(sql`person`)} IS DISTINCT FROM enforcing.supabase_sso_provider_id::text
        )`,
      })
      .from(accountMembers)
      .innerJoin(accountsView, eq(accountsView.accountId, accountMembers.accountId))
      .where(and(eq(accountMembers.userId, pid), eq(accountMembers.accountId, accountId)))
      .limit(1),
    db
      .select({ groupId: accountGroupMembers.groupId })
      .from(accountGroupMembers)
      .where(eq(accountGroupMembers.userId, pid)),
    // Assignments of SYSTEM roles, plus every object assignment. No action join:
    // the six system roles are memoized whole, so expanding them costs nothing.
    retryTransientDatabaseRead(async () =>
      db
        .select({
          roleId: roleAssignments.roleId,
          scopeType: roleAssignments.scopeType,
          scopeId: roleAssignments.scopeId,
          objectType: roleAssignments.objectType,
          roleKey: iamRoles.key,
          roleScopeType: iamRoles.scopeType,
        })
        .from(roleAssignments)
        .innerJoin(iamRoles, eq(iamRoles.roleId, roleAssignments.roleId))
        .where(and(eq(roleAssignments.accountId, accountId), live, isNull(iamRoles.accountId), principalMatches)),
    ),
    // Actions granted by CUSTOM roles. Joined here for the same reason the
    // legacy policy query joined: it keeps the resolve one round trip deep, and
    // it returns [] for the overwhelmingly common account with no custom roles.
    retryTransientDatabaseRead(async () =>
      db
        .select({
          scopeType: roleAssignments.scopeType,
          scopeId: roleAssignments.scopeId,
          action: iamRoleActions.action,
        })
        .from(roleAssignments)
        .innerJoin(iamRoles, eq(iamRoles.roleId, roleAssignments.roleId))
        .innerJoin(iamRoleActions, eq(iamRoleActions.roleId, roleAssignments.roleId))
        .where(
          and(
            eq(roleAssignments.accountId, accountId),
            live,
            isNotNull(iamRoles.accountId),
            isNull(roleAssignments.objectType),
            principalMatches,
          ),
        ),
    ),
  ]);

  const systemRoles = await loadSystemRoles();

  let accountRoleKey: string | null = null;
  let accountRoleActions: ReadonlySet<string> = EMPTY_SET;
  const projectSystemRoleIds = new Map<string, string[]>();

  for (const row of assignmentRows) {
    // An object assignment carries the `agent-user` marker role and grants
    // nothing on its own — it must never be read as a project role, or a member
    // handed one agent would silently acquire the tier the role implies.
    if (row.objectType !== null) continue;
    if (row.roleScopeType === 'account' && row.scopeType === 'account') {
      const role = systemRoles.byId.get(row.roleId);
      if (role && accountRoleRank(role.key) > accountRoleRank(accountRoleKey)) {
        accountRoleKey = role.key;
        accountRoleActions = role.actions;
      }
      continue;
    }
    if (row.roleScopeType === 'project' && row.scopeType === 'project' && row.scopeId) {
      if (row.roleKey === 'agent-user') continue;
      const list = projectSystemRoleIds.get(row.scopeId);
      if (list) list.push(row.roleId);
      else projectSystemRoleIds.set(row.scopeId, [row.roleId]);
    }
  }

  const customActions: CustomAction[] = customRows.map((r) => ({
    scopeType: r.scopeType,
    scopeId: r.scopeId,
    action: r.action,
  }));

  if (accountRoleKey !== null) {
    return {
      kind: 'member',
      isSuperAdmin: identityRows[0]?.isSuperAdmin ?? false,
      accountMfaRequired: identityRows[0]?.mfaRequired ?? false,
      accountSsoRequired: identityRows[0]?.ssoRequired === true,
      accountRoleKey,
      accountRoleActions,
      groupIds: groupRows.map((g) => g.groupId),
      projectSystemRoleIds,
      customActions,
    };
  }

  // Not a member. Is this id a service account in this account? Rare path: only
  // service-account requests and genuinely unknown ids reach here, so the extra
  // query never touches the hot human/PAT path.
  const [sa] = await db
    .select({ id: serviceAccounts.serviceAccountId })
    .from(serviceAccounts)
    .where(
      and(
        eq(serviceAccounts.serviceAccountId, pid),
        eq(serviceAccounts.accountId, accountId),
        eq(serviceAccounts.status, 'active'),
      ),
    )
    .limit(1);
  if (!sa) return null;

  return {
    kind: 'service_account',
    isSuperAdmin: false,
    accountMfaRequired: false,
    accountSsoRequired: false,
    accountRoleKey: null,
    accountRoleActions: EMPTY_SET,
    groupIds: [],
    projectSystemRoleIds,
    customActions,
  };
}

const EMPTY_SET: ReadonlySet<string> = new Set<string>();

const resolvePrincipalMemo = ttlMemo({
  ttlMs: TTL_MS,
  keyFn: (principal: PrincipalRef, accountId: string) => `${principal.id}|${accountId}`,
  loader: resolvePrincipalUncached,
  shouldCache: (rec) => rec !== null,
});
// Key is `${principalId}|…` so invalidateIamCacheForUser busts it, and a service
// account is its own principal id — one contract for both.
registerPrincipalScopedMemo(resolvePrincipalMemo);

export function resolvePrincipal(principal: PrincipalRef, accountId: string): Promise<PrincipalRecord | null> {
  return resolvePrincipalMemo(principal, accountId);
}

function accountRoleRank(key: string | null): number {
  if (key === 'owner') return 3;
  if (key === 'admin') return 2;
  if (key === 'member') return 1;
  return 0;
}

/**
 * The principal's effective SYSTEM role on one project: the strongest of the
 * implicit account role, the direct assignment, and every group assignment.
 * This is the ONE fold — `deriveEffectiveProjectRole`, the inline fold in
 * `listAccessibleProjectsV2`, `foldEffectiveProjectAccess` and the route-local
 * copy in `accounts/iam/members.ts` were four implementations of it.
 */
function effectiveProjectRole(
  roles: SystemRoleIndex,
  rec: PrincipalRecord,
  projectId: string,
  /** The account's one live workspace (not split_pending), or null. */
  soleProjectId: string | null,
): { key: string; actions: ReadonlySet<string> } | null {
  let best: { key: string; actions: ReadonlySet<string> } | null = null;
  if (isImplicitManager(rec.accountRoleKey)) {
    const manager = roles.byKey.get('project:manager');
    if (manager) best = manager;
  } else if (rec.accountRoleKey === 'member' && soleProjectId !== null && projectId === soleProjectId) {
    // MEMBERSHIP IS ACCESS (design.md §3.2 C3): an account member reaches the
    // account's one workspace at the member tier. A split_pending account has
    // no sole workspace, so its members keep per-project grants.
    const member = roles.byKey.get('project:member');
    if (member) best = member;
  }
  for (const roleId of rec.projectSystemRoleIds.get(projectId) ?? []) {
    const role = roles.byId.get(roleId);
    if (!role) continue;
    if (!best || projectRoleRank(role.key) > projectRoleRank(best.key)) best = role;
  }
  return best;
}

type SystemRoleIndex = Awaited<ReturnType<typeof loadSystemRoles>>;

function projectRoleRank(key: string): number {
  return key === 'manager' ? 2 : key === 'member' ? 1 : 0;
}


/**
 * Allow-only union with the system role: an account-scoped custom role grants
 * the action on every project, a project-scoped one only on its own project.
 * There is no deny — a custom role can only ever ADD.
 */
export function customRoleAllows(
  rec: { customActions: CustomAction[] },
  scope: ScopeType,
  rawAction: string,
  rawObj: Obj,
): boolean {
  if (rec.customActions.length === 0) return false;
  const action = toLegacyAction(rawAction);
  const obj = normalizeObj(rawObj);
  for (const ca of rec.customActions) {
    if (ca.action !== action) continue;
    if (ca.scopeType === 'account') return true;
    if (scope === 'project' && obj.type === 'project' && ca.scopeType === 'project' && ca.scopeId === obj.id) {
      return true;
    }
  }
  return false;
}

// ─── Object grants ──────────────────────────────────────────────────────────

/**
 * Object types where an EMPTY grant map must never be cached, because a first
 * grant can still be written later and must take effect on every replica at
 * once. `agent` is CLOSED by unscoped default (mirrors the `object_policies`
 * seed): a stale empty map there reads as "still closed" and denies a member
 * who was just granted an agent for one TTL (measured on dev 2026-08-19:
 * create 403, then 201 ×3 after the TTL). `connection` is OPEN by unscoped
 * default but narrowable (`20260926172248000_share_access_project_principal.sql`):
 * before its first grant, "open" and "empty map" mean the same thing, but the
 * FIRST grant flips that — an empty map read afterwards on a replica that has
 * not seen the write means "still open to everyone", which is a stale
 * over-grant for anyone the new grant was meant to exclude, not a harmless
 * stale negative. `secret` is the same case: a value's audience (keyed by
 * `secret_id`, `projects/lib/secret-audience.ts`) is open until its first
 * grant. `skill`/`app`/`trigger` are OPEN by unscoped default and have no
 * per-object grant writer today, so their empty map can never go stale and
 * stays cache-eligible. Kept as a constant here because the
 * memo's caching rule must not itself depend on a DB read;
 * `unscopedDefaultFor` stays the source of truth for the VERDICT.
 */
const NEVER_CACHE_EMPTY_OBJECT_TYPES: ReadonlySet<string> = new Set(['agent', 'connection', 'secret']);

/**
 * Object types whose grants are never cached, empty or not. A secret value's
 * or connector account's audience narrows and widens per object, so a cached
 * map of any size on a replica that did not see the write is a stale over- or
 * under-grant: on the v0.13.52 gate (SEC-AUD-1/2/4) a value saved for a group
 * read as open to everyone, and a session holding a person-only value could be
 * shared. One indexed query per check is the price of every replica reading
 * the current audience.
 */
const NEVER_CACHE_OBJECT_TYPES: ReadonlySet<string> = new Set(['connection', 'secret']);

interface ObjectGrantPrincipal {
  principalType: string;
  principalId: string;
}

/**
 * (project, objectType) -> objectId -> the principals granted it.
 *
 * The EMPTY map is cached only for object types outside
 * `NEVER_CACHE_EMPTY_OBJECT_TYPES` — invalidation is per-process (each replica
 * busts its own cache on write), so caching an empty map for a type whose
 * first grant can still narrow it leaves every OTHER replica serving the
 * pre-grant state for up to one TTL. One extra indexed query per uncached
 * check is the price of a grant taking effect on every replica at once — the
 * same rule the legacy `loadProjectResourceGrants` memo already applies
 * (#6535).
 */
/**
 * `role_assignments.account_id` equals the account that owns `projectId`. A
 * project-scoped row written in another account grants nothing here; new ones
 * are refused at write time (`assertProjectInAccount`, and the
 * `role_assignments_project_account_guard` trigger).
 */
function projectAccountMatches(projectId: string) {
  return sql`${qualifiedColumn(roleAssignments.accountId)} = (select p.account_id from kortix.projects p where p.project_id = ${projectId}::uuid)`;
}

const loadObjectGrants = ttlMemo({
  ttlMs: TTL_MS,
  keyFn: (projectId: string, objectType: string) => `${projectId}|${objectType}`,
  loader: async (projectId: string, objectType: string) => {
    const rows = await db
      .select({
        objectId: roleAssignments.objectId,
        principalType: roleAssignments.principalType,
        principalId: roleAssignments.principalId,
      })
      .from(roleAssignments)
      .where(
        and(
          eq(roleAssignments.scopeType, 'project'),
          eq(roleAssignments.scopeId, projectId),
          // Only rows written in the project's own account count.
          projectAccountMatches(projectId),
          eq(roleAssignments.objectType, objectType),
          or(isNull(roleAssignments.expiresAt), gt(roleAssignments.expiresAt, sql`now()`)),
        ),
      );
    const map = new Map<string, ObjectGrantPrincipal[]>();
    for (const r of rows) {
      if (!r.objectId) continue;
      const entry = { principalType: r.principalType, principalId: r.principalId };
      const list = map.get(r.objectId);
      if (list) list.push(entry);
      else map.set(r.objectId, [entry]);
    }
    return map;
  },
  shouldCache: (map, _projectId, objectType) =>
    !NEVER_CACHE_OBJECT_TYPES.has(objectType) && (map.size > 0 || !NEVER_CACHE_EMPTY_OBJECT_TYPES.has(objectType)),
});
registerProjectScopedMemo(loadObjectGrants);

export { loadObjectGrants };

/**
 * workspace id -> the account that owns it, or null for an unknown id. The
 * account half of the workspace reach rule. Positive-only: a workspace that
 * does not exist yet must resolve on the next request. A transfer moves a
 * project to another account and busts this through the project-scoped
 * invalidation every project write already calls.
 */
const workspaceAccountMemo = ttlMemo({
  ttlMs: TTL_MS,
  keyFn: (workspaceId: string) => `${workspaceId}|account`,
  loader: async (workspaceId: string): Promise<string | null> => {
    if (!isUuid(workspaceId)) return null;
    const [row] = await db
      .select({ accountId: projectsView.accountId })
      .from(projectsView)
      .where(eq(projectsView.projectId, workspaceId))
      .limit(1);
    return row?.accountId ?? null;
  },
  shouldCache: (accountId) => accountId !== null,
});
registerProjectScopedMemo(workspaceAccountMemo);

function workspaceAccountOf(workspaceId: string): Promise<string | null> {
  return workspaceAccountMemo(workspaceId);
}

/**
 * The actions an OWNER keeps on a closing workspace: read it, read its billing,
 * and restore it (restore and cancel-deletion assert `account.delete`).
 */
export const CLOSING_OWNER_ACTIONS: ReadonlySet<string> = new Set([
  'project.read',
  'account.read',
  'billing.read',
  'account.delete',
]);

/**
 * The principal's role in workspace W, on the one ladder (design.md §3.2 C3):
 *   owner / admin  the account-scope system role;
 *   manager        project `manager` on W, directly or through a group;
 *   member         an account member of a 1:1 (or project-less) workspace, or
 *                  any project grant on W (a split_pending account), or a
 *                  custom role that reads W;
 *   null           no access, and on a closing workspace everyone but owners.
 * The list, the record and the Members table all call this one function.
 */
export async function workspaceRoleFor(actor: Actor, workspaceId: string): Promise<WorkspaceRole | null> {
  const id = workspaceId.toLowerCase();
  // A project-less workspace's id is its account id (C1).
  const accountId = (await workspaceAccountOf(id)) ?? id;
  if (isImpersonatingAccount(actor.userId, accountId)) return 'owner';
  if (isImpersonationBlockedAccount(actor.userId, accountId)) return null;
  const [rec, facts] = await Promise.all([
    resolvePrincipal(actingPrincipal(actor), accountId),
    workspaceFactsOf(accountId),
  ]);
  if (!rec) return null;
  if (rec.accountRoleKey === 'owner') return 'owner';
  if (facts.closing) return null;
  if (rec.accountRoleKey === 'admin') return 'admin';
  const roles = await loadSystemRoles();
  const projectRoleKeys = (rec.projectSystemRoleIds.get(id) ?? []).map((roleId) => roles.byId.get(roleId)?.key);
  if (projectRoleKeys.includes('manager')) return 'manager';
  if (rec.accountRoleKey === 'member' && (facts.soleProjectId === id || id === accountId)) return 'member';
  if (projectRoleKeys.length > 0) return 'member';
  if (customRoleAllows(rec, 'project', 'project.read', { type: 'project', id })) return 'member';
  return null;
}

/** Test hook: drop the principal + object-grant memos. */
export function clearAuthorizeCaches(): void {
  resolvePrincipalMemo.clear();
  loadObjectGrants.clear();
  workspaceAccountMemo.clear();
  clearWorkspaceFacts();
}
