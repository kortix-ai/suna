// Anonymous, read-only session-share viewing — `/v1/public/session-shares/:shareId`
// and `.../messages` (apps/api/src/public-session-shares/index.ts). Backs the
// logged-out `(public)/share/[shareId]` page (`ShareViewer.tsx`).
//
// Deliberately NOT built on `backendApi` (platform/api-client.ts): that client
// wraps every call in the authenticated fetch path, which for a visitor with
// no token synthesizes a failure WITHOUT ever making the network call (see
// `opencode/client.ts`'s `getPublicClientForUrl` doc comment for the same
// footgun on the sandbox side). These routes are genuinely public — no
// Authorization header is ever sent, and no `configureKortix()` call is
// required for these functions to work; `getBackendUrl()` degrades to a sane
// localhost default when unconfigured, exactly like the sibling
// `getPublicShareUrlForToken`.

import { getBackendUrl } from '../../session/server-store/url-helpers';

export class PublicSessionShareError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'PublicSessionShareError';
  }
}

export interface PublicSessionShareMeta {
  share: {
    share_id: string;
    session_id: string;
    project_id: string;
    resource_type: string;
    label: string;
    sandbox_status: string | null;
    expires_at: string | null;
  };
  session: {
    session_id: string;
    title: string | null;
    status: string;
    created_at: string;
    updated_at: string;
  };
}

export interface PublicSessionTranscriptToolCall {
  tool: string;
  status: string | null;
}

export interface PublicSessionTranscriptMessage {
  role: string;
  created: string | null;
  completed: string | null;
  text: string;
  tools: PublicSessionTranscriptToolCall[];
  files: Array<{ filename: string | null; mime: string | null }>;
  reasoning_omitted: boolean;
}

export interface PublicSessionTranscript {
  available: boolean;
  reason: string | null;
  opencode_session_id: string | null;
  message_count: number;
  messages: PublicSessionTranscriptMessage[];
}

function publicSessionShareUrl(shareId: string, suffix = ''): string {
  return `${getBackendUrl()}/public/session-shares/${encodeURIComponent(shareId)}${suffix}`;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' } });
  const text = await res.text().catch(() => '');
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // Non-JSON body — fall through to the generic error message below.
  }
  if (!res.ok) {
    const message =
      (body && typeof body === 'object' && 'error' in body && typeof (body as { error?: unknown }).error === 'string'
        ? (body as { error: string }).error
        : null) || res.statusText || `HTTP ${res.status}`;
    throw new PublicSessionShareError(message, res.status);
  }
  return body as T;
}

/** Anonymous session metadata (title/status/timestamps) for a share id — the
 *  route's own `:shareId` param, NOT the `kps_...` public token. */
export async function getPublicSessionShare(shareId: string): Promise<PublicSessionShareMeta> {
  return getJson<PublicSessionShareMeta>(publicSessionShareUrl(shareId));
}

/** Anonymous, sanitized (text-only, no tool args/output, no file contents)
 *  transcript digest for a share id. */
export async function getPublicSessionShareMessages(shareId: string): Promise<PublicSessionTranscript> {
  return getJson<PublicSessionTranscript>(publicSessionShareUrl(shareId, '/messages'));
}
