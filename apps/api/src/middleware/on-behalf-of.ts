import type { Context } from 'hono';

/** Fresh per-request value set by the auth middleware; null for non-session tokens. */
export function getRequestOnBehalfOf(c: Context): string | null {
  return (c.get('onBehalfOfUserId') as string | null | undefined) ?? null;
}
