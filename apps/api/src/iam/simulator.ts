// Policy simulator: "if I attach policy X to principal Y, what changes?".
// v1 runs the BEFORE state via the real engine and computes the AFTER
// state via a lightweight overlay — predicting the diff without
// mutating any DB state. The overlay is conservative for cases the
// engine can model exactly (account/project scopes against the same
// principal) and best-effort approximate for cases that require
// group-membership / condition resolution.
//
// This trades engine-exact precision for ZERO risk of a half-applied
// or accidentally-committed simulation. Production-grade "would-be"
// modeling can come later as a deeper engine refactor.

import { iamRoles } from '@kortix/db';
import { and, eq, isNull, or } from 'drizzle-orm';
import { db } from '../shared/db';
import { authorize, type AuthorizeTarget, type PolicyScopeType } from './engine';

export interface SimulatedPolicy {
  principalType: 'member' | 'group' | 'token';
  principalId: string;
  scopeType: PolicyScopeType;
  scopeId: string | null;
  /** Reference by role key (not id) so the UI doesn't need a role list. */
  roleKey: string;
  effect: 'allow' | 'deny';
}

export interface SimulationProbe {
  /** The user the simulator runs authorize() as. Usually the same as
   *  the proposed policy's principal_id when principal_type='member'. */
  userId: string;
  action: string;
  target?: AuthorizeTarget;
}

export interface SimulationProbeResult {
  action: string;
  target_type: string;
  target_id: string | null;
  allowed_before: boolean;
  reason_before: string | null;
  allowed_after: boolean;
  reason_after: string | null;
  changed: boolean;
}

export interface SimulationResult {
  probes: SimulationProbeResult[];
  newly_allowed_count: number;
  newly_denied_count: number;
  /** True when the simulator returned approximate results (e.g. for
   *  group principals we can't easily expand membership without
   *  mutating state). The UI should surface this. */
  approximate: boolean;
}

/**
 * Simulate the impact of attaching `proposed` against the given probes.
 * Always read-only.
 */
export async function simulatePolicy(args: {
  accountId: string;
  proposed: SimulatedPolicy;
  probes: SimulationProbe[];
}): Promise<SimulationResult> {
  const { accountId, proposed, probes } = args;

  // Resolve the role key → id so we can confirm it exists; the role
  // itself isn't needed for the overlay but a missing key should fail
  // loudly rather than silently mis-predict.
  const [role] = await db
    .select({ roleId: iamRoles.roleId })
    .from(iamRoles)
    .where(
      and(
        or(isNull(iamRoles.accountId), eq(iamRoles.accountId, accountId)),
        eq(iamRoles.key, proposed.roleKey),
      ),
    )
    .limit(1);
  if (!role) throw new Error(`role key '${proposed.roleKey}' not found`);

  // Group / token principals require resolving membership inside the
  // engine to know which user a probe should run as. v1 only supports
  // member-principal probes — for groups/tokens we mark approximate
  // and still report before/after based on the overlay heuristic.
  const approximate = proposed.principalType !== 'member';

  const results: SimulationProbeResult[] = [];
  for (const p of probes) {
    const before = await authorize(p.userId, accountId, p.action, p.target);
    const wouldApply = policyWouldApplyToProbe(proposed, p);
    let allowed_after = before.allowed;
    let reason_after: string | null = (before.reason ?? null) as string | null;
    if (wouldApply) {
      if (proposed.effect === 'allow' && !before.allowed) {
        allowed_after = true;
        reason_after = 'simulated_policy_allow';
      } else if (proposed.effect === 'deny' && before.allowed) {
        allowed_after = false;
        reason_after = 'simulated_policy_deny';
      }
    }
    results.push({
      action: p.action,
      target_type: p.target?.type ?? 'account',
      target_id:
        p.target && 'id' in p.target && typeof p.target.id === 'string'
          ? p.target.id
          : null,
      allowed_before: before.allowed,
      reason_before: before.reason ?? null,
      allowed_after,
      reason_after,
      changed: allowed_after !== before.allowed,
    });
  }

  let newlyAllowed = 0;
  let newlyDenied = 0;
  for (const r of results) {
    if (r.changed && r.allowed_after) newlyAllowed++;
    if (r.changed && !r.allowed_after) newlyDenied++;
  }
  return {
    probes: results,
    newly_allowed_count: newlyAllowed,
    newly_denied_count: newlyDenied,
    approximate,
  };
}

/**
 * Approximate "would this proposed policy match this probe's target?".
 * Conditions and expiry are NOT evaluated here — the engine applies
 * those at request time. Group/token principals always return false
 * here (the simulator marks the result approximate).
 */
function policyWouldApplyToProbe(p: SimulatedPolicy, probe: SimulationProbe): boolean {
  if (p.principalType !== 'member') return false;
  if (p.principalId !== probe.userId) return false;
  if (p.scopeType === 'account') return true;
  if (!probe.target) return false;
  if (p.scopeType === 'project_group' && probe.target.type === 'project') {
    // We don't expand group membership here — assume "could apply" so
    // the preview leans toward over-reporting changes rather than
    // missing them.
    return true;
  }
  if (p.scopeType === probe.target.type) {
    if (!p.scopeId) return true; // scope-wide
    return 'id' in probe.target && p.scopeId === probe.target.id;
  }
  return false;
}
