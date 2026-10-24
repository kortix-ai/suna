/**
 * Secret shapes a memory page must not hold. Only real credential shapes:
 * provider key prefixes, JWTs, PEM private keys, `password=`-style
 * assignments with a value, and long high-entropy tokens. Ordinary words,
 * hyphenated phrases ("risk-management-framework") and prose ("the bearer of
 * bad news", "password reset flow") pass. The audit redactor keeps its own,
 * wider pattern (`shared/secret-value.ts`): over-matching is safe there, not
 * here, where it refuses a person's sentence.
 */

/** Not preceded by a token character, so `sk-` inside "risk-…" or "desk-…" is no key. */
const START = '(?<![A-Za-z0-9_-])';

const PATTERNS: readonly RegExp[] = [
  // OpenAI / Anthropic style: sk-, sk-proj-, sk-ant-…, 20+ characters with a digit.
  new RegExp(`${START}sk-(?=[A-Za-z0-9_-]*\\d)[A-Za-z0-9_-]{20,}`),
  // Stripe: sk_live_, sk_test_, rk_live_…
  new RegExp(`${START}[sr]k_(?:live|test)_[A-Za-z0-9]{16,}`),
  // AWS access key ids.
  new RegExp(`${START}(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Za-z0-9])`),
  // GitHub tokens.
  new RegExp(`${START}(?:gh[opusr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})`),
  // Chat bot and app tokens.
  new RegExp(`${START}xox[abpsr]-[A-Za-z0-9-]{10,}`),
  // Google API keys.
  new RegExp(`${START}AIza[0-9A-Za-z_-]{35}`),
  // Kortix tokens.
  new RegExp(`${START}kortix_(?:pat|sbx)_[A-Za-z0-9_-]{8,}`),
  // A bearer token: 20+ token characters with a digit after "Bearer ".
  /\bbearer\s+(?=[A-Za-z0-9._~+/=-]*\d)[A-Za-z0-9._~+/=-]{20,}/i,
  // A JWT: three base64url segments, the first a JSON header.
  new RegExp(`${START}eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}`),
  // A PEM private key block.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  // An assignment with a value: password=…, api_key = "…".
  /\b(?:password|passwd|pwd|token|secret|api[_-]?key|access[_-]?key|client[_-]?secret)\s*=\s*["']?[^\s"']{4,}/i,
];

/** A run of token characters long enough to be a generated secret. */
const TOKEN_RUN = /[A-Za-z0-9_+=-]{32,}/g;

/** Shannon entropy of `text` in bits per character. */
function entropy(text: string): number {
  const counts = new Map<string, number>();
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** A long token of upper case, lower case and digits with near-random character spread. */
function highEntropyToken(text: string): boolean {
  for (const [run] of text.matchAll(TOKEN_RUN)) {
    if (/[A-Z]/.test(run) && /[a-z]/.test(run) && /\d/.test(run) && entropy(run) >= 4.2) return true;
  }
  return false;
}

export function findSecret(text: string): boolean {
  return PATTERNS.some((pattern) => pattern.test(text)) || highEntropyToken(text);
}
