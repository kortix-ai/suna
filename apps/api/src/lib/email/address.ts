import type { EmailAddress } from './types';

/**
 * Parse EMAIL_FROM. Accepts the forms operators actually write:
 *   Kortix <noreply@example.com>
 *   "Kortix Support" <noreply@example.com>
 *   noreply@example.com
 * Returns null when the value has no usable address, so the caller can fall
 * back rather than send from an empty envelope.
 */
export function parseEmailAddress(raw: string | undefined | null): EmailAddress | null {
  const value = (raw || '').trim();
  if (!value) return null;

  const angle = value.match(/^(.*)<\s*([^<>\s]+@[^<>\s]+)\s*>$/);
  if (angle) {
    const name = angle[1].trim().replace(/^"(.*)"$/, '$1').trim();
    return { email: angle[2].trim(), name };
  }
  if (!value.includes('@') || /\s/.test(value)) return null;
  return { email: value, name: '' };
}

/** Render an address as a header value: `Name <addr>` or bare `addr`. */
export function formatEmailAddress(address: EmailAddress): string {
  if (!address.name) return address.email;
  // Quote names containing specials, per RFC 5322 atom rules.
  const needsQuoting = /[",;:<>@()\[\]\\.]/.test(address.name);
  const name = needsQuoting ? `"${address.name.replace(/(["\\])/g, '\\$1')}"` : address.name;
  return `${name} <${address.email}>`;
}
