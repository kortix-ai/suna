import type { Context } from 'hono';
import { normalizeJsonObject } from './json';

/**
 * The request's JSON body as a plain object.
 *
 * Returns `{}` when the body is missing, is not valid JSON, or parses to a
 * non-object value (`null`, an array, a string, a number, a boolean). Callers
 * read fields with `body.x` and validate each field; they never see `null`.
 */
export async function readJsonObject(c: Context): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = await c.req.json();
  } catch {
    return {};
  }
  return normalizeJsonObject(parsed);
}
