/**
 * Checks an event trigger's config against the provider's JSON schema before
 * the provider sees it. Covers the subset provider config schemas use:
 * `required`, `type` (string, number, integer, boolean, array), `enum`.
 * Anything else passes: the reconciler still reports provider errors.
 */
import type { EventTypeInfo } from './types';

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'array': return Array.isArray(value);
    case 'null': return value === null;
    default: return true;
  }
}

/** One line per bad field, each quoting the field description when the schema has one. */
export function validateEventConfig(schema: Record<string, unknown>, config: Record<string, unknown>): string[] {
  const properties = asRecord(schema.properties);
  const required = Array.isArray(schema.required) ? schema.required.filter((k): k is string => typeof k === 'string') : [];
  const errors: string[] = [];
  const describe = (field: string, problem: string): string => {
    const description = asRecord(properties[field]).description;
    return `${field} ${problem}${typeof description === 'string' && description ? ` (${description})` : ''}`;
  };
  for (const field of required) {
    if (config[field] === undefined || config[field] === null || config[field] === '') errors.push(describe(field, 'is required'));
  }
  for (const [field, value] of Object.entries(config)) {
    const prop = properties[field];
    if (prop === undefined || value === undefined || value === null) continue;
    const spec = asRecord(prop);
    const types = (Array.isArray(spec.type) ? spec.type : [spec.type]).filter((t): t is string => typeof t === 'string');
    if (types.length && !types.some((t) => matchesType(t, value))) {
      errors.push(describe(field, `must be ${types.join(' or ')}`));
    } else if (Array.isArray(spec.enum) && !spec.enum.includes(value)) {
      errors.push(describe(field, `must be one of ${spec.enum.map((v) => JSON.stringify(v)).join(', ')}`));
    }
  }
  return errors;
}

/** `null` when the event exists and its config is valid; otherwise the 400 message. */
export function eventConfigProblem(
  items: readonly EventTypeInfo[],
  connectorSlug: string,
  eventType: string,
  config: Record<string, unknown>,
): string | null {
  const info = items.find((t) => t.type === eventType);
  if (!info) return `Unknown event ${eventType} for ${connectorSlug}. Run kortix triggers events --connector ${connectorSlug}.`;
  const errors = validateEventConfig(info.configSchema, config);
  return errors.length ? `Invalid config for ${eventType}: ${errors.join('; ')}.` : null;
}
