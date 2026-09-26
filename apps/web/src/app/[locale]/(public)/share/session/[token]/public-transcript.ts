import type { UiTranslator } from '@/i18n/translator';
import {
  PublicSessionShareError,
  type PublicSessionTranscript,
  type PublicSessionTranscriptMessage,
} from '@kortix/sdk';

/**
 * Pure helpers for the public transcript share (`resource_type: 'transcript'`).
 *
 * Restored from the `/share/[shareId]` viewer that `af592fb7b9` deleted, and
 * adapted to the token route: the anonymous reads
 * (`GET /v1/public/session-shares/:ref[/messages]`) now accept the `kps_`
 * token, so the page passes its route token straight through.
 */

export interface ShareLoadError {
  status: number | null;
  message: string;
}

/** Normalize a rejected `getPublicSessionShareMessages` into status + message.
 *  `PublicSessionShareError` carries the real HTTP status (404/410/503). */
export function toShareLoadError(err: unknown): ShareLoadError {
  if (err instanceof PublicSessionShareError) {
    return { status: err.status, message: err.message };
  }
  return { status: null, message: err instanceof Error ? err.message : 'Failed to load share' };
}

/**
 * Display copy for a load error. 404 = unknown token or a share that does not
 * name the conversation, 410 = revoked or expired, 503 = no sandbox runs and
 * no transcript was saved yet. Any other failure gets `genericDescription`:
 * the page is anonymous, so the API's own error text is never shown.
 */
export function describeShareError(
  error: ShareLoadError | null,
  tI18nComplete: UiTranslator,
  genericDescription: string,
): { title: string; description: string } {
  if (error?.status === 404) {
    return {
      title: tI18nComplete.raw('text046e63364fb7'),
      description: tI18nComplete.raw('text9d0813f9e116'),
    };
  }
  if (error?.status === 410) {
    return {
      title: tI18nComplete.raw('text2a517f64c473'),
      description: tI18nComplete.raw('text1c5f0707e8b0'),
    };
  }
  if (error?.status === 503) {
    return {
      title: tI18nComplete.raw('texta6331929630a'),
      description: tI18nComplete.raw('text7e19c0ed80e9'),
    };
  }
  return {
    title: tI18nComplete.raw('textfe4e2e5988fd'),
    description: genericDescription,
  };
}

/**
 * The messages the page renders. The API returns them in conversation order,
 * so this does not re-sort: a message without a timestamp must not jump to the
 * top. Messages with no text (tool-only steps) carry nothing a reader can use.
 */
export function visibleTranscriptMessages(
  transcript: PublicSessionTranscript,
): PublicSessionTranscriptMessage[] {
  if (!transcript.available) return [];
  return transcript.messages.filter((message) => message.text.trim().length > 0);
}

/**
 * The capture time of a saved transcript, or null for a live read. The API
 * answers from the saved copy when the session's sandbox is stopped; the
 * reader must know the conversation may have moved on since.
 */
export function savedCopyTimestamp(transcript: PublicSessionTranscript): string | null {
  if (transcript.source !== 'mirror' || !transcript.captured_at) return null;
  return Number.isNaN(Date.parse(transcript.captured_at)) ? null : transcript.captured_at;
}
