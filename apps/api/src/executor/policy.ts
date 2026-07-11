/**
 * Tool-call policy engine — globbed pattern match, first-match-wins, layered
 * resolution. Mirrors executor.sh's model.
 *
 * Two scopes, both declared in kortix.yaml (docs/specs/executor.md §8):
 *   • project-level `policies:` — patterns are fully-qualified (`<slug>.<path>`),
 *     apply across ALL connectors, evaluated FIRST.
 *   • connector-level `connectors[].policies` — patterns are relative
 *     (the connector slug is implicit), evaluated AFTER the project scope.
 *
 * If neither scope matches, the action falls back to a risk-derived default
 * controlled by the project's `policy.default_mode`:
 *   • `allow_all` (legacy default — every tool runs)
 *   • `risk` (recommended — read = always_run, write/destructive = require_approval)
 *
 * Pure + unit-tested. Glob grammar (case-insensitive): `*` everywhere, anchored.
 * The UI exposes only three shapes (`*`, `prefix.*`, exact); the engine supports
 * arbitrary `*` positions for power users authoring kortix.yaml by hand.
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

/**
 * A `match` is EITHER a glob (default) OR an explicit regex when wrapped in
 * slashes: `/^charges\.(create|update)$/i`. Regex is NOT auto-anchored — the
 * author controls `^`/`$` — and case-insensitive by default. An invalid regex
 * compiles to a never-match so a typo can't silently allow-all. (Storing the
 * matcher as a plain string keeps the schema unchanged — no migration.)
 */
function isRegexMatcher(pattern: string): boolean {
  return /^\/.*\/[a-z]*$/.test(pattern) && pattern.length > 2;
}

function compileMatcher(pattern: string): RegExp {
  if (isRegexMatcher(pattern)) {
    const lastSlash = pattern.lastIndexOf('/');
    const body = pattern.slice(1, lastSlash);
    const flags = pattern.slice(lastSlash + 1) || 'i';
    try {
      return new RegExp(body, flags.includes('i') ? flags : `${flags}i`);
    } catch {
      return /(?!)/; // invalid regex → never matches (fail safe, never allow-all)
    }
  }
  return globToRegex(pattern);
}

/**
 * Heuristic catastrophic-backtracking detector: true if a quantified group
 * (`(...)+`, `(...)*`, `(...){n,}`) itself contains a quantified sub-pattern
 * (`a+`, `a*`, `a{n,}`). That nesting is the classic ReDoS shape — e.g.
 * `(a+)+` — where the engine can match the same input exponentially many
 * ways. Not a full regex-safety proof, just enough to reject the obvious,
 * common unsafe shapes at write time.
 */
function hasNestedQuantifier(body: string): boolean {
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '(') continue;
    let depth = 1;
    let j = i + 1;
    while (j < body.length && depth > 0) {
      if (body[j] === '\\') { j += 2; continue; }
      if (body[j] === '(') depth++;
      else if (body[j] === ')') depth--;
      j++;
    }
    if (depth !== 0) continue; // unbalanced — let RegExp() surface the syntax error
    const inner = body.slice(i + 1, j - 1);
    const after = body[j];
    const groupIsQuantified = after === '*' || after === '+' || after === '{';
    if (!groupIsQuantified) continue;
    const innerStripped = inner.replace(/\\./g, '');
    if (/[*+]|\{\d*,\d*\}/.test(innerStripped)) return true;
  }
  return false;
}

/** True if `pattern` is a syntactically valid matcher (glob always is; regex may not be). */
export function isValidMatcher(pattern: string): boolean {
  if (!isRegexMatcher(pattern)) return pattern.length > 0;
  const lastSlash = pattern.lastIndexOf('/');
  const body = pattern.slice(1, lastSlash);
  try {
    new RegExp(body, pattern.slice(lastSlash + 1) || 'i');
  } catch {
    return false;
  }
  if (hasNestedQuantifier(body)) return false; // catastrophic-backtracking shape, reject at write time
  return true;
}

function matchesPolicy(pattern: string, path: string): boolean {
  if (pattern === '*') return true;
  return compileMatcher(pattern).test(path);
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

export interface EffectiveResolveInput {
  /** Fully-qualified path, e.g. `stripe.charges.create` — matched against project policies. */
  fullPath: string;
  /** Connector-relative path, e.g. `charges.create` — matched against connector policies. */
  relPath: string;
  projectPolicies: Policy[];
  connectorPolicies: Policy[];
  risk: Risk;
  /** Project setting from `policy.default_mode` in kortix.yaml. */
  defaultMode: DefaultMode;
  /** Connector marked `sensitive` — its reads default to require_approval too. */
  sensitive?: boolean;
}

export interface EffectiveResolveResult {
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

  // A `sensitive` connector gates EVERYTHING by default — reads included —
  // regardless of default_mode. A per-connector "sensitive" is a deliberate,
  // targeted admin choice that should beat the coarse project default; an
  // explicit policy rule above can still open a specific action. This is the
  // "reading a private inbox / files / secrets store is not free" tier.
  if (input.sensitive) return { action: 'require_approval', source: 'risk_default' };
  if (input.defaultMode === 'allow_all') return { action: 'always_run', source: 'allow_all' };
  return { action: riskDefaultAction(input.risk), source: 'risk_default' };
}
