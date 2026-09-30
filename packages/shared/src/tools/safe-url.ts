/**
 * Safe URL helpers: allow-list http(s) URLs and pick link-only document
 * previews. Moved verbatim from apps/web `lib/safe-url.ts` +
 * `features/session/preview-url-fallback.ts` (KRTX-365 phases 2–3; the hosts
 * import this module since phase 3). `openSafeExternalUrl` stays in the web
 * app: it opens `window`.
 */

const LINK_ONLY_PREVIEW_EXT_RE = /\.(pdf|docx?|pptx?|xlsx?)(?:[?#]|$)/i;

export function safeHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

export function prefersPreviewLink(candidateUrl: string | null): boolean {
  if (!candidateUrl) return false;
  try {
    const url = new URL(candidateUrl);
    return LINK_ONLY_PREVIEW_EXT_RE.test(`${url.pathname}${url.search}`);
  } catch {
    return LINK_ONLY_PREVIEW_EXT_RE.test(candidateUrl);
  }
}
