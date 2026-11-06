/**
 * Agents as principals.
 *
 * A GOVERNED agent session (non-null kortix.yaml grant, not the platform
 * `meta` coordinator) authorizes AS its agent's service account, never as the
 * human who launched it:
 *
 *   effective(agent, action) = action ∈ kortix_permissions(agent)   (manifest)
 *                            ∧ action ∈ ceiling(agent)              (IAM)
 *                            ∧ action ∉ HUMAN_ONLY
 *   project.read is always granted inside the agent's own workspace.
 *   An account-scope action is about the agent's own workspace (1:1).
 *
 * `ceiling(agent)` = the roles bound to the agent's service account (system
 * AND custom), or `AGENT_DEFAULT_CEILING` when nobody bound one. The launcher's
 * role and super-admin bit are not inputs.
 *
 * An ungoverned (null-grant) token — the `meta` coordinator, or a project
 * that declares no agents — authorizes as its launcher, minus HUMAN_ONLY.
 *
 * This module holds the PURE decision. The engine wiring
 * lives in `authorize.ts` (step 5a); the credential classification in
 * `actor.ts` (`tokenCredential`).
 */
import { GRANTABLE_KORTIX_PERMISSIONS } from '@kortix/manifest-schema';
import { isMyKortixAgentName } from '@kortix/shared';
import { HUMAN_ONLY } from '@kortix/shared/workspace-actions';
import type { AgentGrant } from '@kortix/db';
import { agentMayPerform } from './agent-scope';
import type { ScopeType } from './catalog';

/**
 * Actions no agent ever holds, whatever its grant or bound role says: the
 * HUMAN_ONLY set of `@kortix/shared/workspace-actions` (minting credentials,
 * moving money). One set for every agent session, inherited or governed;
 * `authorize` checks it above everything else (step 1b). Every other action,
 * workspace administration included, is an ordinary grantable permission.
 */
export const HUMAN_ONLY_ACTIONS: ReadonlySet<string> = HUMAN_ONLY;

/**
 * The ceiling of an agent whose service account has no role bound: every
 * grantable action (`GRANTABLE_KORTIX_PERMISSIONS` = every action except
 * HUMAN_ONLY). The manifest grant still narrows it. ONE constant on purpose:
 * the alternative ceiling (no administration writes) is a one-line change
 * here (design.md §3.6 risk 1).
 */
export const AGENT_DEFAULT_CEILING: ReadonlySet<string> = new Set(
  GRANTABLE_KORTIX_PERMISSIONS.filter((action) => !HUMAN_ONLY_ACTIONS.has(action)),
);

/**
 * The coarse membership-tier actions `loadProjectForUser` maps onto. The grant
 * never gates them (same exemption as the legacy fold in authorize.ts); the
 * ceiling still does, except that `project.read` of the own project is free.
 */
const GRANT_EXEMPT_ACTIONS: ReadonlySet<string> = new Set(['project.read', 'project.write']);

/** A grant the agent-principal model governs: non-null, and not `meta`. */
export function isGovernedAgentGrant(grant: AgentGrant | null | undefined): grant is AgentGrant {
  return grant != null && !isMyKortixAgentName(grant.agent);
}

export type AgentPrincipalReason =
  | 'role'
  | 'token_out_of_scope'
  | 'project_target_required'
  | 'agent_human_only_action'
  | 'agent_scope_insufficient'
  | 'agent_ceiling_insufficient';

export interface AgentPrincipalInput {
  action: string;
  scope: ScopeType;
  /** The project the verdict is about; null for an account-level question. */
  targetProjectId: string | null;
  /** The project the session token is bound to. */
  tokenProjectId: string | null;
  /** An account-scope action names the token's own workspace: the actor's
   *  account is the account of the token's workspace, and that workspace is
   *  not split_pending (design.md §3.2 C4). */
  accountInScope?: boolean;
  grant: AgentGrant;
  /** Does the agent's ceiling (bound roles, else the default) hold `action`? */
  ceilingAllows: (action: string) => boolean;
}

/**
 * THE agent decision. Order: scope → HUMAN_ONLY → own-project read → grant →
 * ceiling. The grant is checked before the ceiling so the reason names the
 * first thing to change: a missing manifest entry is fixed by a change request,
 * a low ceiling by an admin.
 */
export function agentPrincipalDecision(input: AgentPrincipalInput): {
  allowed: boolean;
  reason: AgentPrincipalReason;
} {
  const { action } = input;
  if (input.scope === 'account') {
    // The workspace's own account surface (members, roles, billing reads, …):
    // in scope for the token's own workspace, decided by grant ∩ ceiling.
    if (!input.accountInScope || !input.tokenProjectId) return { allowed: false, reason: 'token_out_of_scope' };
  } else {
    if (!input.targetProjectId) return { allowed: false, reason: 'project_target_required' };
    if (!input.tokenProjectId || input.targetProjectId !== input.tokenProjectId) {
      return { allowed: false, reason: 'token_out_of_scope' };
    }
  }
  if (HUMAN_ONLY_ACTIONS.has(action)) return { allowed: false, reason: 'agent_human_only_action' };
  if (action === 'project.read') return { allowed: true, reason: 'role' };
  if (!GRANT_EXEMPT_ACTIONS.has(action) && !agentMayPerform(input.grant, action)) {
    return { allowed: false, reason: 'agent_scope_insufficient' };
  }
  if (!input.ceilingAllows(action)) return { allowed: false, reason: 'agent_ceiling_insufficient' };
  return { allowed: true, reason: 'role' };
}

/**
 * Does this token authorize as its agent? Yes for every governed grant bound
 * to a project. There is one path: the per-project `agent_principal` switch
 * back to the launcher model is gone.
 */
export async function agentPrincipalModeFor(
  projectId: string | null | undefined,
  grant: AgentGrant | null | undefined,
): Promise<boolean> {
  return Boolean(projectId) && isGovernedAgentGrant(grant);
}

/**
 * May an agent session start (or prompt) a session of agent `target`? Spec
 * §2.2: running an agent lends its power, so an agent never lends power its
 * human could not lend. With a human on behalf of, that human must hold
 * run(target); with none (unattended), only the same agent.
 */
export function agentDelegationAllowed(input: {
  parentAgent: string;
  target: string;
  onBehalfOfUserId: string | null;
  humanMayRunTarget: boolean;
}): boolean {
  if (input.onBehalfOfUserId) return input.humanMayRunTarget;
  return input.target === input.parentAgent;
}
