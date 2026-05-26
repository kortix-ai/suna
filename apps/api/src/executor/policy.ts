/**
 * Tool-call policy engine — connector-scoped, mirrors executor's model verbatim
 * (docs/specs/executor.md §8). Rules evaluated top-to-bottom, first match wins;
 * patterns are globs over the connector-RELATIVE tool path. Actions:
 *   always_run · require_approval · block
 * Default (no match) = always_run. THE POLICY LAYER IS WIRED LAST — the gateway
 * runs allow-all until policies are switched on; this module is the engine it'll
 * call. Pure + unit-tested.
 */
export type PolicyAction = 'always_run' | 'require_approval' | 'block';

export interface Policy {
  match: string;
  action: PolicyAction;
  /** Authoring order; lower = evaluated first. */
  position?: number;
}

/** Convert a glob (`*`, `vercel.*`, `*.delete*`, exact) into an anchored regex. */
export function globToRegex(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

export function matchesPolicy(pattern: string, relPath: string): boolean {
  if (pattern === '*') return true;
  return globToRegex(pattern).test(relPath);
}

/**
 * Resolve the effective action for a connector-relative tool path. Policies are
 * evaluated in `position` order (stable, authoring order); first match wins.
 * Returns `always_run` when nothing matches.
 */
export function resolvePolicyAction(relPath: string, policies: Policy[]): PolicyAction {
  const ordered = [...policies].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  for (const p of ordered) {
    if (matchesPolicy(p.match, relPath)) return p.action;
  }
  return 'always_run';
}

/** Is a tool visible to the agent? Blocked tools are hidden from search. */
export function isVisible(relPath: string, policies: Policy[]): boolean {
  return resolvePolicyAction(relPath, policies) !== 'block';
}
