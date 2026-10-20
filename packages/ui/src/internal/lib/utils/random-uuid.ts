/**
 * A v4 UUID that works on every page. Browsers expose `crypto.randomUUID`
 * only in secure contexts (https, localhost), so a self-hosted instance opened
 * over plain http on a LAN address has none and every caller threw.
 * `crypto.getRandomValues` exists in every context, so the fallback is just as
 * random (RFC 9562 §5.4: version 4, variant 10).
 */
export function randomUUID(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
