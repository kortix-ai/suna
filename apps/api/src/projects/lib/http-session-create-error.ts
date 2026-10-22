import type { Context } from 'hono';
import type { SessionCreateError } from './session-create';

export function sendSessionCreateError(c: Context, error: SessionCreateError) {
  for (const [key, value] of Object.entries(error.headers ?? {})) c.header(key, value);
  return c.json(error.body, error.status);
}
