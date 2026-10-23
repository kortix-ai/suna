/** The body of `POST /api/preview-url`: one port + path inside the session sandbox. */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PATH_LENGTH = 4096;
const MAX_TARGET_LENGTH = 8192;
const LOCALHOST = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]']);

export interface PreviewRequest {
  projectId?: unknown;
  sessionId?: unknown;
  preview?: { port?: unknown; path?: unknown };
  targetUrl?: unknown;
}

/** A port + path inside the sandbox, from `{ preview: { port, path } }` or a sandbox-local `targetUrl`. */
export function parsePreviewRequest(
  body: PreviewRequest,
): { projectId: string; sessionId: string; port: number; path: string } | null {
  const projectId = typeof body.projectId === 'string' ? body.projectId : '';
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
  if (!projectId || !UUID_RE.test(sessionId)) return null;

  let port: unknown = body.preview?.port;
  let path = typeof body.preview?.path === 'string' ? body.preview.path : '/';
  if (typeof body.targetUrl === 'string') {
    const raw = body.targetUrl.trim();
    if (!raw || raw.length > MAX_TARGET_LENGTH) return null;
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return null;
    }
    if (!/^https?:$/.test(url.protocol) || !LOCALHOST.has(url.hostname)) return null;
    port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    path = `${url.pathname}${url.search}`;
  }
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (!path.startsWith('/') || path.length > MAX_PATH_LENGTH) return null;
  return { projectId, sessionId, port, path };
}
