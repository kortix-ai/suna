import type { Context } from 'hono';
import { TeamsError } from '../domain/errors';

export function respondWithDomainError(c: Context, err: unknown, fallbackLog: string) {
  if (err instanceof TeamsError) {
    const status = (err as any).httpStatus ?? 400;
    return c.json({ success: false, error: err.message }, status);
  }
  console.error(fallbackLog, err);
  return c.json({ success: false, error: 'Internal error' }, 500);
}
