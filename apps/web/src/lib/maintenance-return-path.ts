import { sanitizeAuthReturnUrl } from '@/lib/auth/return-url';

/**
 * Where `/maintenance?from=` sends a visitor once maintenance is over.
 *
 * `/maintenance` is public, so `from` is untrusted input that ends up in a
 * Location header. The shared return-path sanitizer refuses control characters
 * and backslashes (browsers strip or rewrite both, which turns `/\t/host` into
 * `//host`) and returns the canonical same-origin path.
 */
export function maintenanceReturnPath(from?: string): string {
  return sanitizeAuthReturnUrl(from, '/');
}
