/**
 * Join-time wiring for the voice channel (Recall.ai).
 *
 * Replaces the notetaker's join patch. Three things it used to do are gone:
 *
 *  - `realtime_endpoints` — there is no transcript webhook any more. The
 *    realtime provider does its own ASR and the runtime writes transcript rows
 *    directly, so routing captions through an HTTP hop bought nothing but lag.
 *  - `automatic_audio_output` — the bot no longer plays discrete mp3 clips. It
 *    streams continuous audio from a rendered page (Output Media), and Recall
 *    forbids combining the two.
 *  - the wake word — server-side VAD handles turn-taking, so there is nothing
 *    to phonetically match against.
 *
 * What survives is the session-correlation metadata and the HMAC token that
 * proves an inbound Recall callback belongs to a session we started.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config';

export function voiceSessionToken(sessionId: string): string {
  return createHmac('sha256', config.API_KEY_SECRET).update(`voice:${sessionId}`).digest('hex');
}

export function verifyVoiceSessionToken(sessionId: string, token: string): boolean {
  if (!sessionId || !token) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(voiceSessionToken(sessionId));
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface VoiceJoinPatch {
  metadata: Record<string, unknown>;
  /**
   * Recall renders this page inside the bot and streams its audio into the call.
   * Shape verified against the live API: `camera.kind` + nested `config`. Recall's
   * reference docs also show a `camera.webpage.url` form — create-bot rejects it.
   */
  outputMedia: { camera: { kind: 'webpage'; config: { url: string } } };
}

/**
 * `bridgeUrl` is now a LiveKit client page (see channels/voice/livekit.ts —
 * `bridgePageUrl`), carrying a room name + a scoped LiveKit access token, in
 * place of the old raw-audio-WebSocket page's `kvr_` bridge token. Recall
 * doesn't care what the page does; this function's job — wrap it into the
 * join patch — is unchanged.
 */
export function voiceJoinPatch(
  projectId: string,
  sessionId: string,
  bridgeUrl: string,
): VoiceJoinPatch | null {
  if (!bridgeUrl) return null;
  return {
    metadata: {
      kortix_project_id: projectId,
      kortix_session_id: sessionId,
      kortix_token: voiceSessionToken(sessionId),
    },
    outputMedia: { camera: { kind: 'webpage', config: { url: bridgeUrl } } },
  };
}
