/**
 * Approval-rule matchers and argument conditions: one copy for the validator
 * (`policies` at the top level and on a connector) and the runtime
 * (`apps/api/src/connectors/policy.ts`). Dependency-free.
 */

export interface PolicyArgCondition {
  arg: string;
  match: string;
  /** Invert: the condition holds when the value does NOT match. */
  negate?: boolean;
}

/**
 * A `match` is EITHER a glob (default) OR an explicit regex when wrapped in
 * slashes: `/^charges\.(create|update)$/i`. Regex is NOT auto-anchored and is
 * case-insensitive by default.
 */
export function isRegexMatcher(pattern: string): boolean {
  return /^\/.*\/[a-z]*$/.test(pattern) && pattern.length > 2;
}

/**
 * Heuristic catastrophic-backtracking detector: true if a quantified group
 * (`(...)+`, `(...)*`, `(...){n,}`) itself contains a quantified sub-pattern
 * (`a+`, `a*`, `a{n,}`), the classic ReDoS shape such as `(a+)+`. Not a full
 * regex-safety proof, just enough to reject the obvious unsafe shapes.
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
    if (!(after === '*' || after === '+' || after === '{')) continue;
    if (/[*+]|\{\d*,\d*\}/.test(inner.replace(/\\./g, ''))) return true;
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
  return !hasNestedQuantifier(body);
}

/** Arg paths are dotted identifiers — no globs, no indexes, no traversal. */
const ARG_PATH_REGEX = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;
/**
 * Segments that would walk off the payload and into the prototype chain.
 * Rejected at write time AND skipped at read time, because rows predating this
 * check exist.
 */
export const FORBIDDEN_ARG_SEGMENTS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);
/** Bound the condition list so one rule can't turn into a regex workload. */
export const MAX_CONDITIONS_PER_POLICY = 10;

/**
 * Validate a rule's argument conditions at WRITE time, so a malformed
 * guardrail is rejected on save rather than silently never matching (a
 * never-matching `block` rule is an outage-shaped security hole).
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
