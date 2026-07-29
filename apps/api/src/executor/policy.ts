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
export type PolicyAction = 'always_run' | 'require_approval' | 'block';
export type Risk = 'read' | 'write' | 'destructive';
export type DefaultMode = 'risk' | 'allow_all';

/**
 * One condition on the ARGUMENTS of a call, not just its tool name.
 *
 * A tool-name pattern can only ever say "may the agent call `gmail.send_email`".
 * It cannot say "…but only to these two addresses" — the question every real
 * guardrail actually asks. A rule carrying `conditions` applies only when the
 * tool path matches AND every condition holds.
 *
 * `arg` is a dot path into the call args (`to`, `message.channel`). `match` uses
 * the SAME grammar as a tool-path matcher: a glob by default, or an explicit
 * `/regex/flags` when slash-wrapped.
 */
export interface PolicyArgCondition {
  arg: string;
  match: string;
  /** Invert: the condition holds when the value does NOT match. */
  negate?: boolean;
}

export interface Policy {
  match: string;
  action: PolicyAction;
  /** Authoring order; lower = evaluated first. */
  position?: number;
  /**
   * Argument conditions — ALL must hold for the rule to apply. Absent/empty =
   * a plain tool-name rule (unchanged behaviour).
   */
  conditions?: PolicyArgCondition[] | null;
  /**
   * Set by the loader when stored conditions exist but are MALFORMED (written
   * before validation, or by a direct SQL edit).
   *
   * This must never collapse to "no conditions": silently dropping a broken
   * condition from an `always_run` rule would convert a narrow permit into
   * allow-everything — a fail-OPEN escalation. Instead it is treated exactly
   * like an unevaluable condition (see `ruleApplies`), which resolves toward
   * less privilege.
   */
  conditionsInvalid?: boolean;
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

/** Arg paths are dotted identifiers — no globs, no indexes, no traversal. */
const ARG_PATH_REGEX = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;
/**
 * Segments that would walk off the payload and into the prototype chain.
 * `__proto__` is a valid identifier, so the regex above admits it — a rule like
 * `{arg: '__proto__.constructor'}` would then read engine internals rather than
 * the call's data. Rejected at write time AND skipped at read time
 * (`valueAtPath`), because rows predating this check already exist.
 */
const FORBIDDEN_ARG_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);
/** Bound the condition list so one rule can't turn into a regex workload. */
const MAX_CONDITIONS_PER_POLICY = 10;

/**
 * Validate the arg conditions on a rule at WRITE time, so a malformed guardrail
 * is rejected on save rather than silently never matching (a never-matching
 * `block` rule is an outage-shaped security hole).
 */
export function areValidConditions(conditions: unknown): conditions is PolicyArgCondition[] {
  if (conditions === null || conditions === undefined) return true;
  if (!Array.isArray(conditions)) return false;
  if (conditions.length > MAX_CONDITIONS_PER_POLICY) return false;
  return conditions.every((raw) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return false;
    const candidate = raw as Record<string, unknown>;
    if (typeof candidate.arg !== 'string' || !ARG_PATH_REGEX.test(candidate.arg)) return false;
    if (candidate.arg.split('.').some((s) => FORBIDDEN_ARG_SEGMENTS.has(s))) return false;
    if (typeof candidate.match !== 'string' || !isValidMatcher(candidate.match)) return false;
    if (candidate.negate !== undefined && typeof candidate.negate !== 'boolean') return false;
    return true;
  });
}

/** Normalize a persisted/parsed condition list into the engine's shape. */
export function normalizeConditions(conditions: unknown): PolicyArgCondition[] | null {
  if (!areValidConditions(conditions) || !conditions || conditions.length === 0) return null;
  return conditions.map((c) => ({
    arg: c.arg,
    match: c.match,
    ...(c.negate ? { negate: true as const } : {}),
  }));
}

/**
 * Read a stored `conditions` jsonb value into the engine's fields.
 *
 * Distinguishes the three cases a loader must not conflate:
 *   • absent (NULL / `[]`)      → unconditional rule
 *   • present and well-formed    → the conditions
 *   • present but MALFORMED      → `conditionsInvalid`, so the rule fails closed
 *                                  instead of quietly losing its restriction
 */
export function parseStoredConditions(
  raw: unknown,
): Pick<Policy, 'conditions' | 'conditionsInvalid'> {
  if (raw === null || raw === undefined) return { conditions: null };
  if (Array.isArray(raw) && raw.length === 0) return { conditions: null };
  if (!areValidConditions(raw)) return { conditions: null, conditionsInvalid: true };
  return { conditions: normalizeConditions(raw) };
}

/** Read a dot path (`to`, `message.channel`) out of a call's args. */
function valueAtPath(args: Record<string, unknown> | null | undefined, path: string): unknown {
  if (!args) return undefined;
  let cursor: unknown = args;
  for (const segment of path.split('.')) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    // Own properties only: never follow a path into the prototype chain, even if
    // a rule stored before `FORBIDDEN_ARG_SEGMENTS` existed names one.
    if (!Object.hasOwn(cursor as object, segment)) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

/**
 * Does a single arg value satisfy `pattern`?
 *
 * A MISSING value never matches — so an allow-list condition fails closed when
 * the arg it guards isn't present at all, rather than vacuously passing.
 * An ARRAY (a `to:` with several recipients) matches only when EVERY element
 * matches; one off-list recipient is enough to fail the condition, which is the
 * only sound reading for an allow-list.
 */
function argValueMatches(value: unknown, pattern: string): boolean {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) {
    if (value.length === 0) return false;
    return value.every((item) => argValueMatches(item, pattern));
  }
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    // Not a scalar we can responsibly compare — treat as "no match" (fail closed).
    return false;
  }
  return matchesPolicy(pattern, String(value));
}

function conditionHolds(
  condition: PolicyArgCondition,
  args: Record<string, unknown> | null | undefined,
): boolean {
  const matched = argValueMatches(valueAtPath(args, condition.arg), condition.match);
  return condition.negate ? !matched : matched;
}

/**
 * Does a conditional rule apply, given what we know about the args?
 *
 * When args were NOT supplied (a call site that doesn't have them), a condition
 * is UNDECIDABLE. Resolving that ambiguity is the whole safety story:
 *   • a restrictive rule (`block` / `require_approval`) is treated as MATCHING —
 *     we refuse to skip a guardrail we merely failed to evaluate;
 *   • a permissive rule (`always_run`) is treated as NOT matching — an unproven
 *     condition must never open a tool.
 * In both directions the undecidable case resolves toward less privilege.
 */
function ruleApplies(
  policy: Policy,
  args: Record<string, unknown> | null | undefined,
  argsAvailable: boolean,
): boolean {
  // Malformed stored conditions are undecidable, NOT absent — see
  // `Policy.conditionsInvalid`.
  if (policy.conditionsInvalid) return policy.action !== 'always_run';
  const conditions = policy.conditions;
  if (!conditions || conditions.length === 0) return true;
  if (!argsAvailable) return policy.action !== 'always_run';
  return conditions.every((condition) => conditionHolds(condition, args));
}

/**
 * Resolve the effective action for a single policy list against a path. Policies
 * are evaluated in `position` order (stable, authoring order); first match wins.
 * Returns `null` when nothing matches (so the caller can fall through to the
 * next scope).
 */
function firstMatchOrNull(
  path: string,
  policies: Policy[],
  args?: Record<string, unknown> | null,
  argsAvailable = false,
): PolicyAction | null {
  if (policies.length === 0) return null;
  const ordered = [...policies].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  for (const p of ordered) {
    if (!matchesPolicy(p.match, path)) continue;
    if (!ruleApplies(p, args, argsAvailable)) continue;
    return p.action;
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
  /**
   * Rules for the specific CONNECTION in play (executor_connection_policies,
   * keyed by profile_id). One connector can hold several connections that
   * warrant different permissions — support@ read-only while sales@ may send —
   * which a connector-keyed rule cannot express. Omit for call sites with no
   * connection in hand; behaviour is then exactly as before.
   */
  connectionPolicies?: Policy[];
  connectorPolicies: Policy[];
  risk: Risk;
  /** Project setting from `policy.default_mode` in kortix.yaml. */
  defaultMode: DefaultMode;
  /** Connector marked `sensitive` — its reads default to require_approval too. */
  sensitive?: boolean;
  /**
   * The call's actual arguments, for rules carrying `conditions`. Pass
   * `argsAvailable: true` alongside — an absent `args` and an empty-args call
   * are different facts, and conditional rules resolve them differently (see
   * `ruleApplies`).
   */
  args?: Record<string, unknown> | null;
  /** True when `args` reflects the real call payload. Defaults to false. */
  argsAvailable?: boolean;
}

export interface EffectiveResolveResult {
  action: PolicyAction;
  /** Why this action — which scope decided. Useful for explainability + audit. */
  source: 'project' | 'connection' | 'connector' | 'risk_default' | 'allow_all';
}

/**
 * Resolve the effective action across both scopes + the risk-derived default.
 *   1. project `[[policies]]` (first match wins) → if hit, return.
 *   2. the CONNECTION's own rules (first match wins) → if hit, return.
 *   3. connector `[[connectors.policies]]` (first match wins) → if hit, return.
 *   3. `defaultMode = risk` → action from risk class.
 *   4. `defaultMode = allow_all` → always_run.
 *
 * Project rules are evaluated BEFORE connector rules and CANNOT be overridden
 * by them — admin trust property.
 */
export function resolveEffectiveAction(input: EffectiveResolveInput): EffectiveResolveResult {
  const args = input.args ?? null;
  const argsAvailable = input.argsAvailable ?? false;

  const projectHit = firstMatchOrNull(input.fullPath, input.projectPolicies, args, argsAvailable);
  if (projectHit) return { action: projectHit, source: 'project' };

  // The connection is MORE specific than the connector, so it wins over the
  // connector default — but still loses to a project rule above, which keeps the
  // admin guardrail un-overridable.
  const connectionHit = firstMatchOrNull(
    input.relPath,
    input.connectionPolicies ?? [],
    args,
    argsAvailable,
  );
  if (connectionHit) return { action: connectionHit, source: 'connection' };

  const connectorHit = firstMatchOrNull(
    input.relPath,
    input.connectorPolicies,
    args,
    argsAvailable,
  );
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
