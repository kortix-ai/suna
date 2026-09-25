import type { Context } from 'hono';

/**
 * The request's parsed JSON body, or `fallback` when the body is missing or is
 * not valid JSON. A body of JSON `null` parses, so it is returned as `null`;
 * callers that need an object add `?? fallback` themselves.
 */
export async function readJsonBody<T>(c: Context, fallback: T): Promise<T> {
  try {
    return await c.req.json<T>();
  } catch {
    return fallback;
  }
}
