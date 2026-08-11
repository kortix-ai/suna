/**
 * Pure payload helpers for webhook triggers — template rendering, session-key
 * derivation, and the delivery filter.
 *
 * Deliberately free of `config`, `db`, and every other side-effecting import so
 * this logic stays unit-testable without booting the server environment.
 * `./triggers` re-exports all of it, so existing importers are unaffected.
 */
import type { GitTriggerSpec } from '../triggers';

/** Longest session key we persist. Bounds hostile payloads out of metadata. */
const SESSION_KEY_MAX = 512;

export function isPlainPayloadObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function valueAtPath(source: unknown, path: string[]): unknown {
  let current = source;
  for (const segment of path) {
    if (!isPlainPayloadObject(current)) return undefined;
    current = current[segment];
  }
  return current;
}

export function templateValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

export function renderPromptTemplate(template: string, payload: Record<string, unknown>) {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, token: string) => {
    const [root, ...path] = token.split('.');
    if (!root) return '';
    const value = path.length === 0 ? payload[root] : valueAtPath(payload[root], path);
    return templateValue(value);
  });
}

/**
 * Render a trigger's `session_key` template against a delivery payload.
 *
 * Returns null when the trigger isn't keyed or the template renders empty —
 * both mean "fall back to a fresh session". A blank key would otherwise bucket
 * every keyless delivery into one shared session, which is strictly worse than
 * a fresh one per fire.
 */
export function renderSessionKey(
  spec: GitTriggerSpec,
  payload: Record<string, unknown>,
): string | null {
  if (spec.sessionMode !== 'keyed' || !spec.sessionKey) return null;
  const rendered = renderPromptTemplate(spec.sessionKey, payload).trim();
  return rendered ? rendered.slice(0, SESSION_KEY_MAX) : null;
}

/**
 * Evaluate a trigger's optional `filter` against a delivery payload. False
 * means "accept the delivery, but don't spawn a session".
 *
 * The canonical use is loop-breaking: a source that reports BOTH directions of
 * a conversation would otherwise re-fire the agent with the agent's own reply.
 * Comparison is stringwise so `true`, `3` and `"3"` behave predictably across
 * JSON and manifest types. A missing path fails closed.
 */
export function triggerFilterMatches(
  spec: GitTriggerSpec,
  payload: Record<string, unknown>,
): boolean {
  if (!spec.filter) return true;
  for (const [path, expected] of Object.entries(spec.filter)) {
    const [root, ...rest] = path.split('.');
    if (!root) return false;
    const actual = rest.length === 0 ? payload[root] : valueAtPath(payload[root], rest);
    if (templateValue(actual) !== expected) return false;
  }
  return true;
}
