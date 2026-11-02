/**
 * Tool-call policy engine — globbed pattern match, first-match-wins, layered
 * resolution. Mirrors connector.sh's model.
 *
 * Two scopes, both declared in kortix.yaml:
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

import { type PolicyArgCondition, areValidConditions, isRegexMatcher } from '@kortix/manifest-schema';

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

/**
 * Select the policy view that matches gateway enforcement.
 *
 * A synchronized runtime catalog is authoritative for active calls. A manifest
 * read can lag the commit that produced those rows. An empty runtime array is a
 * real value and must not fall through to stale manifest rules.
 */
export function selectPoliciesForRead(
  materialized: Policy[] | null,
  manifest: Policy[] | null,
): Policy[] | null {
  return materialized ?? manifest;
}

/** Convert a glob (`*`, `vercel.*`, `*.delete*`, exact) into an anchored regex. */
function globToRegex(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
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

function matchesPolicy(pattern: string, path: string): boolean {
  if (pattern === '*') return true;
  return compileMatcher(pattern).test(path);
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
): Policy | null {
  if (policies.length === 0) return null;
  const ordered = [...policies].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  for (const p of ordered) {
    if (!matchesPolicy(p.match, path)) continue;
    if (!ruleApplies(p, args, argsAvailable)) continue;
    return p;
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
  /**
   * The calling agent's policy set on this connector (`agents.<a>.policy_sets`).
   * Evaluated after the project rules and before the connector's base rules.
   * Absent = the caller has no set (no agent, or no entry).
   */
  setPolicies?: Policy[];
  /**
   * The caller's agent names a set this connector does not define (manifest
   * drift, or the set's rules failed to load). Every call is blocked: a block
   * is never looser than any set, while `require_approval` could be.
   */
  setMissing?: boolean;
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
  source: 'project' | 'policy_set' | 'connector' | 'risk_default' | 'allow_all';
}

/**
 * Resolve the effective action across the scopes + the risk-derived default.
 *   0. the caller's set is missing → block (fail closed, before everything).
 *   1. project `[[policies]]` (first match wins) → if hit, return.
 *   2. the caller's agent policy set on this connector → if hit, return.
 *   3. connector `[[connectors.policies]]` (base rules) → if hit, return.
 *   4. `sensitive` → require_approval; `defaultMode` → risk class / allow_all.
 *
 * Project rules are evaluated BEFORE set and connector rules and CANNOT be
 * overridden by them — admin trust property. A set CAN loosen a base rule
 * for its agent: a guardrail for every caller belongs in project `policies:`.
 */
export function resolveEffectiveAction(input: EffectiveResolveInput): EffectiveResolveResult {
  const { action, source } = resolveEffectiveRule(input);
  return { action, source };
}

/** `resolveEffectiveAction` plus the rule that decided, when a rule did. */
export function resolveEffectiveRule(input: EffectiveResolveInput): EffectiveResolveResult & { rule?: Policy } {
  const args = input.args ?? null;
  const argsAvailable = input.argsAvailable ?? false;

  if (input.setMissing) return { action: 'block', source: 'policy_set' };

  const projectHit = firstMatchOrNull(input.fullPath, input.projectPolicies, args, argsAvailable);
  if (projectHit) return { action: projectHit.action, source: 'project', rule: projectHit };

  const setHit = firstMatchOrNull(input.relPath, input.setPolicies ?? [], args, argsAvailable);
  if (setHit) return { action: setHit.action, source: 'policy_set', rule: setHit };

  const connectorHit = firstMatchOrNull(
    input.relPath,
    input.connectorPolicies,
    args,
    argsAvailable,
  );
  if (connectorHit) return { action: connectorHit.action, source: 'connector', rule: connectorHit };

  // A `sensitive` connector gates EVERYTHING by default — reads included —
  // regardless of default_mode. A per-connector "sensitive" is a deliberate,
  // targeted admin choice that should beat the coarse project default; an
  // explicit policy rule above can still open a specific action. This is the
  // "reading a private inbox / files / secrets store is not free" tier.
  if (input.sensitive) return { action: 'require_approval', source: 'risk_default' };
  if (input.defaultMode === 'allow_all') return { action: 'always_run', source: 'allow_all' };
  return { action: riskDefaultAction(input.risk), source: 'risk_default' };
}

