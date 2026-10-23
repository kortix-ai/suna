/**
 * Secret shapes a memory page must not hold: the audit redactor's family
 * (`SECRET_VALUE_RE`, shared/secret-value.ts) plus cloud keys, private keys, JWTs and
 * chat bot tokens. A plain word such as "token" or "password" does not match.
 */
import { SECRET_VALUE_RE } from '../shared/secret-value';

const PATTERNS: readonly RegExp[] = [
  SECRET_VALUE_RE,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]+/,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/,
  /\bAIza[0-9A-Za-z_-]{35}/,
];

export function findSecret(text: string): boolean {
  return PATTERNS.some((pattern) => pattern.test(text));
}
