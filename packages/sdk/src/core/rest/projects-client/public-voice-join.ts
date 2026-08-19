// Anonymous resolve step for a `voice_spawn` join link — `/v1/public/voice-join/:token`
// (apps/api/src/channels/voice/public-join-routes.ts). Backs the logged-out
// `(public)/voice/[token]` page: the URL now carries a short, ungessable id
// rather than the raw LiveKit access token, so the page exchanges it here for
// a freshly-minted token + the LiveKit server URL.
//
// Deliberately NOT built on `backendApi` (platform/api-client.ts) for the same
// reason `public-session-shares.ts` isn't: that client's authenticated fetch
// path synthesizes a failure for a visitor with no token WITHOUT ever making
// the network call. This route is genuinely public — no Authorization header,
// no `configureKortix()` call required — mirroring `getPublicShareUrlForToken`'s
// and `getPublicSessionShare`'s stance.

import { getBackendUrl } from '../../session/server-store/url-helpers';

export class PublicVoiceJoinError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'PublicVoiceJoinError';
  }
}

export interface PublicVoiceJoinInfo {
  call_id: string;
  /** The LiveKit server's `ws(s)://` URL — never assume it shares an origin
   *  with either the API or the frontend that served this page. */
  url: string;
  /** A freshly-minted, room-scoped LiveKit access token — not the join
   *  link's own token. */
  token: string;
}

function publicVoiceJoinUrl(token: string): string {
  return `${getBackendUrl()}/public/voice-join/${encodeURIComponent(token)}`;
}

async function getPublicVoiceJson<T>(url: string): Promise<T> {
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
    throw new PublicVoiceJoinError(message, res.status);
  }
  return body as T;
}

/** Resolves a short `voice_spawn` join-link token into a live LiveKit
 *  session's server URL + a fresh access token. Throws `PublicVoiceJoinError`
 *  (404 unknown, 410 expired/revoked) on anything but 200. */
export async function getPublicVoiceJoin(token: string): Promise<PublicVoiceJoinInfo> {
  return getPublicVoiceJson<PublicVoiceJoinInfo>(publicVoiceJoinUrl(token));
}

/**
 * One line of a call's durable record (`kortix.voice_call_turns`).
 *
 * `role` + `speaker` together say who — and they must be read together,
 * because `agent` covers two different things:
 *   - `user`  — a human in the room. `speaker` is a display name if one is known.
 *   - `agent` + `speaker === 'kortix'` — what the KORTIX agent put into the
 *     call (`send_prompt`, a finished turn's result, an error).
 *   - `agent` + anything else — what the voice itself actually said, labelled
 *     with the bot's display name.
 *   - `tool`  — an MCP call the voice made; `speaker` is the tool name
 *     (`ask_kortix`, `run_command`) and `text` is the call and its outcome.
 *     Nobody spoke this line.
 */
export interface PublicVoiceTranscriptTurn {
  /** Monotonic per-call sequence number — pass the page's last one back as `cursor`. */
  cursor: number;
  role: 'user' | 'agent' | 'tool' | (string & {});
  speaker: string | null;
  text: string;
  /** ISO-8601. */
  at: string;
}

export interface PublicVoiceTranscriptPage {
  call_id: string;
  /** The cursor to poll with next — unchanged when nothing new arrived. */
  cursor: number;
  turns: PublicVoiceTranscriptTurn[];
}

/**
 * Reads the durable transcript of the ONE call a join-link token was minted
 * for — every spoken turn on both sides, everything the Kortix agent said into
 * the call, and every tool call the voice made.
 *
 * This is not the same stream as LiveKit's client-side transcription, which
 * only ever carries the two voices. Authorized by the join link alone (same
 * capability, same revocation as `getPublicVoiceJoin`), so it works on the
 * logged-out `/voice/[token]` page. Throws `PublicVoiceJoinError` (404
 * unknown, 410 expired or the call ended).
 */
export async function getPublicVoiceTranscript(
  token: string,
  cursor = 0,
): Promise<PublicVoiceTranscriptPage> {
  const url = `${publicVoiceJoinUrl(token)}/transcript?cursor=${encodeURIComponent(String(cursor))}`;
  return getPublicVoiceJson<PublicVoiceTranscriptPage>(url);
}
