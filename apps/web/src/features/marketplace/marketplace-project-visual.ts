/** Deterministic per-project banner gradient — kortix-* tokens only, no raw
 *  palette. Shared by the card and the detail page so the same project gets
 *  the same identity everywhere. */
const BANNER_TOKENS = [
  'from-kortix-blue/30 via-kortix-blue/5',
  'from-kortix-purple/30 via-kortix-purple/5',
  'from-kortix-green/30 via-kortix-green/5',
  'from-kortix-orange/30 via-kortix-orange/5',
  'from-kortix-yellow/30 via-kortix-yellow/5',
] as const;

function hashOf(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

export function projectBannerClass(seed: string): string {
  return BANNER_TOKENS[hashOf(seed) % BANNER_TOKENS.length];
}
