/**
 * Iframe `sandbox` token sets. A frame that shows agent-written content does
 * not pick one of these itself: it asks `framePolicy` in
 * `features/file-viewer/preview-policy.ts`, which owns the origin rule.
 */

/** A running app on an origin of its own: same-origin, scripts, forms, popups, downloads, modals. */
export const INTERACTIVE_PREVIEW_IFRAME_SANDBOX = [
  'allow-same-origin',
  'allow-scripts',
  'allow-forms',
  'allow-popups',
  'allow-downloads',
  'allow-modals',
].join(' ');

/** Agent-written HTML: scripts, forms, popups and downloads run; the origin is opaque. */
export const ISOLATED_HTML_PREVIEW_IFRAME_SANDBOX = [
  'allow-scripts',
  'allow-forms',
  'allow-popups',
  'allow-downloads',
].join(' ');

/** A deck slide on an origin of its own. */
export const SLIDE_IFRAME_SANDBOX = ['allow-same-origin', 'allow-scripts', 'allow-modals'].join(
  ' ',
);

/** A deck slide on a privileged origin: scripts and modals, opaque origin. */
export const ISOLATED_SLIDE_IFRAME_SANDBOX = ['allow-scripts', 'allow-modals'].join(' ');

export const CLIPBOARD_IFRAME_ALLOW = 'clipboard-read; clipboard-write';
