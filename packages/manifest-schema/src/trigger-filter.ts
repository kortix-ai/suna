/**
 * A trigger's `filter` (KRTX-1721): payload path → condition. A delivery fires
 * only when every condition matches. A plain value means "equals". An object
 * holds exactly one operator:
 *
 *   body.type: push                                  equals
 *   body.sender.login: { not: kortix-bot }           equals none of
 *   body.action: { in: [opened, reopened] }          equals one of
 *   body.pull_request: { exists: true }              is present (not missing, not null)
 *   body.ref: { prefix: refs/heads/release/ }        starts with one of
 *   body.ref: { not_prefix: refs/heads/kortix/ }     starts with none of
 *
 * Values compare as text, so `true`, `3` and `"3"` behave the same in the
 * manifest and the payload. A missing or null path reads as an empty string.
 * The API parser, the manifest validator and the matcher share this module.
 */

export const TRIGGER_FILTER_OPERATORS = ['not', 'in', 'exists', 'prefix', 'not_prefix'] as const;
export type TriggerFilterOperator = (typeof TRIGGER_FILTER_OPERATORS)[number];

export type TriggerFilterCondition =
  | { not: string[] }
  | { in: string[] }
  | { exists: boolean }
  | { prefix: string[] }
  | { not_prefix: string[] };

/** One path's condition. A string means "equals". */
export type TriggerFilterValue = string | TriggerFilterCondition;
export type TriggerFilter = Record<string, TriggerFilterValue>;

const OPERATOR_LIST = TRIGGER_FILTER_OPERATORS.join(', ');

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function parseCondition(path: string, raw: Record<string, unknown>): TriggerFilterCondition | { error: string } {
  const operators = Object.keys(raw);
  if (operators.length !== 1) {
    return { error: `filter.${path} takes one operator, got ${operators.length}${operators.length ? `: ${operators.join(', ')}` : ''}` };
  }
  const operator = operators[0] as string;
  const operand = raw[operator];
  if (!(TRIGGER_FILTER_OPERATORS as readonly string[]).includes(operator)) {
    return { error: `filter.${path} has an unknown operator "${operator}"; use one of: ${OPERATOR_LIST}` };
  }
  if (operator === 'exists') {
    return typeof operand === 'boolean' ? { exists: operand } : { error: `filter.${path}.exists must be true or false` };
  }
  const list = Array.isArray(operand) ? operand : [operand];
  if (list.length === 0) return { error: `filter.${path}.${operator} must list at least one value` };
  if (!list.every(isScalar)) return { error: `filter.${path}.${operator} values must be strings, numbers, or booleans` };
  const values = list.map(String);
  if ((operator === 'prefix' || operator === 'not_prefix') && values.some((v) => v === '')) {
    return { error: `filter.${path}.${operator} values must not be empty` };
  }
  return { [operator]: values } as TriggerFilterCondition;
}

/** Validate and normalize a `filter`. Absent, null or empty is no filter. */
export function parseTriggerFilter(raw: unknown): { filter: TriggerFilter | null } | { error: string } {
  if (raw === undefined || raw === null) return { filter: null };
  if (!isPlainRecord(raw)) return { error: 'filter must map payload paths to a value or one operator' };
  const entries: [string, TriggerFilterValue][] = [];
  for (const [key, value] of Object.entries(raw)) {
    const path = key.trim();
    if (!path) return { error: 'filter paths must not be blank' };
    if (isScalar(value)) {
      entries.push([path, String(value)]);
    } else if (isPlainRecord(value)) {
      const condition = parseCondition(path, value);
      if ('error' in condition) return condition;
      entries.push([path, condition]);
    } else {
      return { error: `filter.${path} must be a string, number, boolean, or one operator: ${OPERATOR_LIST}` };
    }
  }
  // fromEntries defines own properties, so a `__proto__` path stays a plain key.
  return { filter: entries.length > 0 ? Object.fromEntries(entries) : null };
}

function filterText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/** Whether the payload value at a filter path satisfies its condition. */
export function triggerFilterValueMatches(condition: TriggerFilterValue, actual: unknown): boolean {
  if (typeof condition === 'string') return filterText(actual) === condition;
  if ('exists' in condition) return (actual !== undefined && actual !== null) === condition.exists;
  const text = filterText(actual);
  if ('in' in condition) return condition.in.includes(text);
  if ('not' in condition) return !condition.not.includes(text);
  if ('prefix' in condition) return condition.prefix.some((prefix) => text.startsWith(prefix));
  return !condition.not_prefix.some((prefix) => text.startsWith(prefix));
}
