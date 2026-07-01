import type { Effect } from 'effect';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { sharedConfig as config } from '../shared/effect';
import { SILENT_MP3_B64 } from './meet-voices';

export const MEET_REALTIME_PATH = '/v1/webhooks/meet/realtime';
export const MEET_DEFAULT_WAKE = 'kortix';

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

export function meetSessionToken(sessionId: string): string {
  return createHmac('sha256', config.API_KEY_SECRET).update(`meet:${sessionId}`).digest('hex');
}

export function verifyMeetSessionToken(sessionId: string, token: string): boolean {
  if (!sessionId || !token) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(meetSessionToken(sessionId));
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface MeetJoinPatch {
  metadata: Record<string, unknown>;
  realtimeEndpoints: unknown[];
  automaticAudioOutput: unknown;
}

export function meetRealtimeJoinPatch(
  projectId: string,
  sessionId: string,
  wake: string = MEET_DEFAULT_WAKE,
  botName = '',
): MeetJoinPatch | null {
  const base = (config.KORTIX_URL || '').replace(/\/+$/, '');
  if (!base) return null;
  return {
    metadata: {
      kortix_project_id: projectId,
      kortix_session_id: sessionId,
      kortix_token: meetSessionToken(sessionId),
      kortix_wake: wake,
      kortix_bot_name: botName,
    },
    realtimeEndpoints: [
      {
        type: 'webhook',
        url: `${base}${MEET_REALTIME_PATH}`,
        events: ['transcript.data', 'participant_events.chat_message'],
      },
    ],
    automaticAudioOutput: { in_call_recording: { data: { kind: 'mp3', b64_data: SILENT_MP3_B64 } } },
  };
}
