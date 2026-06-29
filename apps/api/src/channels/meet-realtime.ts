import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config';
import { SILENT_MP3_B64 } from './meet-voices';

/**
 * Meet (Recall.ai) live relay — the shared contract between the side that MINTS
 * the join-time bot metadata (the executor gateway, server-side) and the side
 * that VERIFIES it (the realtime webhook). Recall round-trips a bot's `metadata`
 * on every realtime event, so we stamp the owning session + an HMAC token at
 * join and trust it back without a mapping table.
 */
export const MEET_REALTIME_PATH = '/v1/webhooks/meet/realtime';

/** Default wake word: the agent is only escalated when an utterance mentions it. */
export const MEET_DEFAULT_WAKE = 'kortix';

/**
 * Phonetic skeleton of a word — a poor-man's Soundex tuned for "kortix". Speech
 * captions routinely mis-hear the name ("cortex", "cortix", "kortex", "quartix",
 * "core tex"…), so exact-substring matching misses real addresses. We reduce a
 * word to its consonant shape (c/k/q→k, x→ks, ph→f, drop vowels, collapse
 * repeats) so all those variants collapse to the SAME key as "kortix" → "krtks".
 */
export function wakeKey(word: string): string {
  return word
    .toLowerCase()
    .replace(/[^a-z]/g, '')
    .replace(/[ckq]/g, 'k')
    .replace(/ph/g, 'f')
    .replace(/x/g, 'ks')
    .replace(/[aeiouy]/g, '')
    .replace(/(.)\1+/g, '$1');
}

/**
 * Was the bot addressed? True if the text contains the wake word literally, OR
 * any token (or adjacent token pair, catching split mis-hearings like "core
 * tex") is phonetically equal to it. Tuned for recall over precision — a rare
 * false wake just means the agent reads it and chooses to do nothing.
 */
export function isWake(text: string, wake: string = MEET_DEFAULT_WAKE): boolean {
  const lower = text.toLowerCase();
  if (wake && lower.includes(wake.toLowerCase())) return true;
  const wkey = wakeKey(wake);
  if (!wkey) return false;
  const toks = lower.split(/[^a-z0-9]+/).filter(Boolean);
  for (let i = 0; i < toks.length; i++) {
    if (wakeKey(toks[i]!) === wkey) return true;
    if (i + 1 < toks.length && wakeKey(toks[i]! + toks[i + 1]!) === wkey) return true;
  }
  return false;
}

/** Sign a session id so the webhook can trust the `bot.metadata` it gets back. */
export function meetSessionToken(sessionId: string): string {
  return createHmac('sha256', config.API_KEY_SECRET).update(`meet:${sessionId}`).digest('hex');
}

/** Constant-time verify of a session token presented in a realtime event. */
export function verifyMeetSessionToken(sessionId: string, token: string): boolean {
  if (!sessionId || !token) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(meetSessionToken(sessionId));
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface MeetJoinPatch {
  metadata: Record<string, unknown>;
  realtimeEndpoints: unknown[];
  /** Enables the output_audio endpoint (a silent placeholder clip). */
  automaticAudioOutput: unknown;
}

/**
 * The `metadata` + `recording_config.realtime_endpoints` to inject into a Recall
 * join so it streams transcript + chat back to our webhook, tagged with this
 * session. Returns null if no public base URL is configured (KORTIX_URL).
 */
export function meetRealtimeJoinPatch(
  projectId: string,
  sessionId: string,
  wake: string = MEET_DEFAULT_WAKE,
): MeetJoinPatch | null {
  const base = (config.KORTIX_URL || '').replace(/\/+$/, '');
  if (!base) return null;
  return {
    metadata: {
      kortix_project_id: projectId,
      kortix_session_id: sessionId,
      kortix_token: meetSessionToken(sessionId),
      kortix_wake: wake,
    },
    realtimeEndpoints: [
      {
        type: 'webhook',
        url: `${base}${MEET_REALTIME_PATH}`,
        events: ['transcript.data', 'participant_events.chat_message'],
      },
    ],
    // Enable the output_audio endpoint so the agent can speak in-call (the silent
    // clip means it doesn't blurt anything on join).
    automaticAudioOutput: { in_call_recording: { data: { kind: 'mp3', b64_data: SILENT_MP3_B64 } } },
  };
}
