import { timingSafeEqual } from 'node:crypto';
import { config } from '../config';
import { bearerToken } from './bearer-token';

/**
 * Does the request carry this host's `INTERNAL_SERVICE_KEY`, as a Bearer token
 * or as `X-Kortix-Internal-Key`? The compare is timing-safe. Only the host
 * (its cron, its operator, its own scripts) holds the key.
 */
export function hasInternalServiceKey(c: { req: { header(name: string): string | undefined } }): boolean {
  const expected = Buffer.from(config.INTERNAL_SERVICE_KEY);
  const matches = (value: string) => {
    const given = Buffer.from(value);
    return given.length > 0 && given.length === expected.length && timingSafeEqual(given, expected);
  };
  return matches(bearerToken(c.req.header('Authorization')) ?? '') || matches(c.req.header('X-Kortix-Internal-Key') ?? '');
}
