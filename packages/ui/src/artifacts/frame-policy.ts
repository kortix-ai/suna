/**
 * The iframe sandbox. It allows same-origin; the content server's CSP sandbox
 * decides: an opaque origin on the API host, the page's own origin on the
 * dedicated content host (ARTIFACT_CONTENT_URL), where embedded players work.
 */
export const ARTIFACT_IFRAME_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads';

/** Features an embedded player in the page may use. */
export const ARTIFACT_FRAME_ALLOW = 'fullscreen; clipboard-write; autoplay; encrypted-media; picture-in-picture';

/** Artifact frames share the Apps frame pool (`@kortix/ui/apps`); their keys start with this. */
export const ARTIFACT_FRAME_PREFIX = 'artifact:';

/** One pooled frame per artifact state: a save (`updated_at`) or an old version gets its own. */
export function artifactFrameKey(artifact: { artifact_id: string; updated_at: string }, version?: string | null): string {
  return `${ARTIFACT_FRAME_PREFIX}${artifact.artifact_id}:${version ?? artifact.updated_at}`;
}

/**
 * Print a doc to PDF without leaving the page: its print view (`?print=1`)
 * loads in a hidden frame and opens the print dialog for that frame alone. The
 * page posts `artifact-printed` after the dialog closes; the frame then goes.
 */
export function printArtifact(viewUrl: string): void {
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', ARTIFACT_IFRAME_SANDBOX);
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none';
  const cleanup = () => {
    window.removeEventListener('message', onMessage);
    frame.remove();
  };
  const onMessage = (event: MessageEvent) => {
    if (event.source === frame.contentWindow && (event.data as { kortix?: string } | null)?.kortix === 'artifact-printed') cleanup();
  };
  window.addEventListener('message', onMessage);
  // A dialog left open past this still prints; the frame is only cleanup.
  window.setTimeout(cleanup, 10 * 60_000);
  frame.src = `${viewUrl}?print=1`;
  document.body.appendChild(frame);
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const IN_PROJECT = new RegExp(`/projects/(${UUID})/artifacts/(${UUID})/?$`, 'i');
const PUBLIC = new RegExp(`/share/artifact/(${UUID})/?$`, 'i');

/**
 * The artifact an app link names: `/projects/<project>/artifacts/<artifact>`
 * (the app viewer, on any Kortix host) or `/share/artifact/<artifact>` (a
 * public link, no project). Null for any other URL.
 */
export function parseArtifactUrl(url: string): { projectId: string | null; artifactId: string } | null {
  let path: string;
  try {
    path = new URL(url, 'http://localhost').pathname;
  } catch {
    return null;
  }
  const inProject = IN_PROJECT.exec(path);
  if (inProject) return { projectId: inProject[1]!.toLowerCase(), artifactId: inProject[2]!.toLowerCase() };
  const shared = PUBLIC.exec(path);
  return shared ? { projectId: null, artifactId: shared[1]!.toLowerCase() } : null;
}
