/**
 * Tool-call policy engine — globbed pattern match, first-match-wins, layered
 * resolution. Mirrors executor.sh's model.
 *
 * Two scopes, both declared in kortix.toml:
 *   • project-level `[[policies]]` — patterns are fully-qualified (`<slug>.<path>`),
 *     apply across ALL connectors, evaluated FIRST.
 *   • connector-level `[[connectors.policies]]` — patterns are relative
 *     (the connector slug is implicit), evaluated AFTER the project scope.
 *
 * If neither scope matches, the action falls back to a risk-derived default
 * controlled by the project's `policy.default_mode`:
 *   • `allow_all` (legacy default — every tool runs)
 *   • `risk` (recommended — read = always_run, write/destructive = require_approval)
 *
 * Pure + unit-tested. Glob grammar (case-insensitive): `*` everywhere, anchored.
 * The UI exposes only three shapes (`*`, `prefix.*`, exact); the engine supports
 * arbitrary `*` positions for power users authoring kortix.toml by hand.
 */
type PolicyAction = 'always_run' | 'require_approval' | 'block';
type Risk = 'read' | 'write' | 'destructive';
export type DefaultMode = 'risk' | 'allow_all';

export interface Policy {
  match: string;
  action: PolicyAction;
  /** Authoring order; lower = evaluated first. */
  position?: number;
}

/** Convert a glob (`*`, `vercel.*`, `*.delete*`, exact) into an anchored regex. */
function globToRegex(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

function matchesPolicy(pattern: string, path: string): boolean {
  if (pattern === '*') return true;
  return globToRegex(pattern).test(path);
}

/**
 * Resolve the effective action for a single policy list against a path. Policies
 * are evaluated in `position` order (stable, authoring order); first match wins.
 * Returns `null` when nothing matches (so the caller can fall through to the
 * next scope).
 */
function firstMatchOrNull(path: string, policies: Policy[]): PolicyAction | null {
  if (policies.length === 0) return null;
  const ordered = [...policies].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  for (const p of ordered) {
    if (matchesPolicy(p.match, path)) return p.action;
  }
  return null;
}

/** Map risk → action under `default_mode = risk`. */
function riskDefaultAction(risk: Risk): PolicyAction {
  return risk === 'read' ? 'always_run' : 'require_approval';
}

interface EffectiveResolveInput {
  /** Fully-qualified path, e.g. `stripe.charges.create` — matched against project policies. */
  fullPath: string;
  /** Connector-relative path, e.g. `charges.create` — matched against connector policies. */
  relPath: string;
  projectPolicies: Policy[];
  connectorPolicies: Policy[];
  risk: Risk;
  /** Project setting from `[policy].default_mode` in kortix.toml. */
  defaultMode: DefaultMode;
}

interface EffectiveResolveResult {
  action: PolicyAction;
  /** Why this action — which scope decided. Useful for explainability + audit. */
  source: 'project' | 'connector' | 'risk_default' | 'allow_all';
}

/**
 * Resolve the effective action across both scopes + the risk-derived default.
 *   1. project `[[policies]]` (first match wins) → if hit, return.
 *   2. connector `[[connectors.policies]]` (first match wins) → if hit, return.
 *   3. `defaultMode = risk` → action from risk class.
 *   4. `defaultMode = allow_all` → always_run.
 *
 * Project rules are evaluated BEFORE connector rules and CANNOT be overridden
 * by them — admin trust property.
 */
export function resolveEffectiveAction(input: EffectiveResolveInput): EffectiveResolveResult {
  const projectHit = firstMatchOrNull(input.fullPath, input.projectPolicies);
  if (projectHit) return { action: projectHit, source: 'project' };

  const connectorHit = firstMatchOrNull(input.relPath, input.connectorPolicies);
  if (connectorHit) return { action: connectorHit, source: 'connector' };

  if (input.defaultMode === 'allow_all') return { action: 'always_run', source: 'allow_all' };
  return { action: riskDefaultAction(input.risk), source: 'risk_default' };
}
