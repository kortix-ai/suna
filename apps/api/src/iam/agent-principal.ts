/**
 * Agents as principals — spec docs/specs/2026-09-22-agents-as-principals.md.
 *
 * With the project feature flag `agent_principal` ON, a GOVERNED agent session
 * (non-null kortix.yaml grant, not the platform `meta` coordinator) authorizes
 * AS its agent's service account, never as the human who launched it:
 *
 *   effective(agent, action) = action ∈ kortix_permissions(agent)   (manifest)
 *                            ∧ action ∈ ceiling(agent)              (IAM)
 *                            ∧ action ∉ HUMAN_ONLY
 *   project.read is always granted inside the agent's own project.
 *
 * `ceiling(agent)` = the roles bound to the agent's service account (system
 * AND custom), or `AGENT_DEFAULT_CEILING` when nobody bound one. The launcher's
 * role and super-admin bit are not inputs.
 *
 * Flag OFF, or an ungoverned (null-grant) token: nothing here runs, and the
 * legacy launcher ∩ grant model applies byte for byte.
 *
 * This module holds the PURE decision plus the flag lookup. The engine wiring
 * lives in `authorize.ts` (step 5a); the credential classification in
 * `actor.ts` (`tokenCredential`).
 */
import { eq } from 'drizzle-orm';
import { GRANTABLE_KORTIX_PERMISSIONS } from '@kortix/manifest-schema';
import { isMetaAgentName } from '@kortix/shared';
import { projects, type AgentGrant } from '@kortix/db';
import { resolveFeatureFlag } from '../feature-flags/registry';
import { db } from '../shared/db';
import { ttlMemo } from '../shared/ttl-memo';
import { agentMayPerform } from './agent-scope';
import { registerProjectScopedMemo } from './cache-invalidation';
import type { ScopeType } from './catalog';

/**
 * Actions no agent ever holds, whatever its grant or bound role says. A human
 * does these. Spec §2.1.
 */
export const HUMAN_ONLY_ACTIONS: ReadonlySet<string> = new Set([
  'project.members.manage',
  'project.delete',
  'project.credentials.issue',
]);

/**
 * The ceiling of an agent whose service account has no role bound: every
 * grantable project permission except HUMAN_ONLY. The manifest grant still
 * narrows it.
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
  return grant != null && !isMetaAgentName(grant.agent);
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
  if (input.scope === 'account') return { allowed: false, reason: 'token_out_of_scope' };
  if (!input.targetProjectId) return { allowed: false, reason: 'project_target_required' };
  if (!input.tokenProjectId || input.targetProjectId !== input.tokenProjectId) {
    return { allowed: false, reason: 'token_out_of_scope' };
  }
  if (HUMAN_ONLY_ACTIONS.has(action)) return { allowed: false, reason: 'agent_human_only_action' };
  if (action === 'project.read') return { allowed: true, reason: 'role' };
  if (!GRANT_EXEMPT_ACTIONS.has(action) && !agentMayPerform(input.grant, action)) {
    return { allowed: false, reason: 'agent_scope_insufficient' };
  }
  if (!input.ceilingAllows(action)) return { allowed: false, reason: 'agent_ceiling_insufficient' };
  return { allowed: true, reason: 'role' };
}

// ─── Flag lookup ────────────────────────────────────────────────────────────

const TTL_MS = (() => {
  const raw = Number(process.env.IAM_CACHE_TTL_MS);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 15_000;
})();

/**
 * Effective `agent_principal` for one project. Same 15 s window as every other
 * IAM memo. Keyed `${projectId}|` so `invalidateIamCacheForProjectResources`
 * busts it; the features PATCH route calls that after a toggle, so the writing
 * replica switches on the next request and the others within one TTL.
 */
const loadAgentPrincipalFlag = ttlMemo({
  ttlMs: TTL_MS,
  keyFn: (projectId: string) => `${projectId}|agent_principal`,
  loader: async (projectId: string): Promise<boolean> => {
    const [row] = await db
      .select({ metadata: projects.metadata })
      .from(projects)
      .where(eq(projects.projectId, projectId))
      .limit(1);
    return row ? resolveFeatureFlag(row.metadata, 'agent_principal') : false;
  },
});
registerProjectScopedMemo(loadAgentPrincipalFlag);

/**
 * Is this token governed by the agent-principal model? True only for a
 * governed grant, bound to a project whose flag is on.
 */
export async function agentPrincipalModeFor(
  projectId: string | null | undefined,
  grant: AgentGrant | null | undefined,
): Promise<boolean> {
  if (!projectId || !isGovernedAgentGrant(grant)) return false;
  return loadAgentPrincipalFlag(projectId);
}

export { loadAgentPrincipalFlag };

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
