// Anonymous, read-only session-share viewing — `/v1/public/session-shares/:ref`
// and `.../messages` (apps/api/src/public-session-shares/index.ts). `:ref` is a
// share's `share_id` or its `kps_` `public_token`. Only a `transcript` share
// (`createSessionPublicShare(..., { transcript: true })`) read `/messages`;
// a `preview` or `file` share got 404 there.
//
// REMOVED SERVER-SIDE (KRTX-2358): public transcript sharing is gone — the API
// no longer serves `/v1/public/session-shares/**` and rejects transcript share
// creates with 400. The functions stay exported until the next major (a
// published package does not drop public names in a minor); every call now
// answers 404. File and preview shares are unaffected — they never used these
// routes (the web viewer reads `/p/public-share/:token`).
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

/** @deprecated Public transcript shares were removed (KRTX-2358).
 *  Removed in the next major. */
export class PublicSessionShareError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'PublicSessionShareError';
  }
}

/** @deprecated The server route was removed with public transcript sharing
 *  (KRTX-2358). Removed in the next major. */
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

/** @deprecated Public transcript shares were removed (KRTX-2358).
 *  Removed in the next major. */
export interface PublicSessionTranscriptToolCall {
  tool: string;
  status: string | null;
}

/** @deprecated Public transcript shares were removed (KRTX-2358).
 *  Removed in the next major. */
export interface PublicSessionTranscriptMessage {
  role: string;
  created: string | null;
  completed: string | null;
  text: string;
  tools: PublicSessionTranscriptToolCall[];
  files: Array<{ filename: string | null; mime: string | null }>;
  reasoning_omitted: boolean;
}

/** @deprecated Public transcript shares were removed (KRTX-2358).
 *  Removed in the next major. */
export interface PublicSessionTranscript {
  available: boolean;
  reason: string | null;
  /** Which source answered: the running sandbox (`live`), the saved
   *  transcript (`mirror`), or nothing (`none`, only with `available: false`).
   *  Absent from servers that predate the saved-transcript fallback. */
  source?: 'live' | 'mirror' | 'none';
  /** When the saved transcript was last written. Null for a live read. */
  captured_at?: string | null;
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

/** Anonymous session metadata (title/status/timestamps) for a share. Takes
 *  the `share_id` or the `kps_` public token.
 *
 *  @deprecated The server route was removed with public transcript sharing
 *  (KRTX-2358); every call answers 404. Removed in the next major. */
export async function getPublicSessionShare(shareId: string): Promise<PublicSessionShareMeta> {
  return getJson<PublicSessionShareMeta>(publicSessionShareUrl(shareId));
}

/** Anonymous, sanitized (text-only, no tool args/output, no file contents)
 *  transcript digest for a `transcript` share. Takes the `share_id` or the
 *  `kps_` public token. Throws `PublicSessionShareError` with status 404 for a
 *  share that does not name the conversation, 410 when revoked or expired, and
 *  503 when no sandbox runs and no transcript was saved.
 *
 *  @deprecated The server route was removed with public transcript sharing
 *  (KRTX-2358); every call answers 404. Removed in the next major. */
export async function getPublicSessionShareMessages(shareId: string): Promise<PublicSessionTranscript> {
  return getJson<PublicSessionTranscript>(publicSessionShareUrl(shareId, '/messages'));
}
