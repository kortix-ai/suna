/**
 * The iframe sandbox. It allows same-origin; the content server's CSP sandbox
 * decides: an opaque origin on the API host, the page's own origin on the
 * dedicated content host (ARTIFACT_CONTENT_URL), where embedded players work.
 */
export const ARTIFACT_IFRAME_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads';

/** Features an embedded player in the page may use. */
export const ARTIFACT_FRAME_ALLOW = 'fullscreen; clipboard-write; autoplay; encrypted-media; picture-in-picture';
