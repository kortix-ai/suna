/**
 * Links in rendered markdown come from agent output, which is untrusted. Only
 * schemes that open a browser or a mail composer are allowed; everything else
 * (app deep links, intent:, tel:, file:, relative paths) is ignored on press.
 */
const SAFE_EXTERNAL_LINK = /^(?:https?|mailto):/i;

export function isSafeExternalLink(href: unknown): href is string {
  return typeof href === 'string' && SAFE_EXTERNAL_LINK.test(href.trim());
}
