/**
 * Dictation — pure rules for the composer's voice input.
 *
 * The platform recogniser (`expo-speech-recognition`: `SFSpeechRecognizer` on
 * iOS, `SpeechRecognizer` on Android) streams `result` events. The platforms
 * disagree on what one event holds:
 *
 * - Android (continuous, API 33+) runs a segmented session: partials for the
 *   current segment, then a final for it, then the next segment starts empty.
 * - iOS 18 behaves the same through the library's workaround, and prefixes a
 *   later segment with a space.
 * - iOS < 18 sends cumulative partials and one cumulative final.
 *
 * Keeping the finals and replacing the partial covers all three.
 */

/** Bars in the listening waveform, newest on the right. */
export const DICTATION_BAR_COUNT = 28;

export interface Transcript {
  /** Final segments, in order. */
  finals: string[];
  /** The current segment's partial text. */
  interim: string;
}

export const EMPTY_TRANSCRIPT: Transcript = { finals: [], interim: '' };

export function reduceTranscript(
  state: Transcript,
  result: { isFinal: boolean; transcript: string }
): Transcript {
  const text = result.transcript.trim();
  if (!result.isFinal) return { finals: state.finals, interim: text };
  // iOS ends a session with an empty final: keep the partial it closes.
  const final = text || state.interim;
  return { finals: final ? [...state.finals, final] : state.finals, interim: '' };
}

export function transcriptText(state: Transcript): string {
  return [...state.finals, state.interim].filter(Boolean).join(' ');
}

/** The composer text while dictating: what was typed before, then the words. */
export function dictationDraft(base: string, spoken: string): string {
  const words = spoken.trim();
  if (!words) return base;
  if (!base || /\s$/.test(base)) return base + words;
  return `${base} ${words}`;
}

/**
 * The recogniser reports volume from -2 to 10; 0 and below is inaudible.
 * The square root lifts quiet speech so the bars move for a normal voice.
 */
export function levelFromVolume(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.sqrt(Math.min(value, 10) / 10);
}

export function pushLevel(history: readonly number[], level: number): number[] {
  const next = [...history, level];
  return next.length > DICTATION_BAR_COUNT ? next.slice(next.length - DICTATION_BAR_COUNT) : next;
}

/** A BCP-47 tag for the recogniser from the device locale ("en_GB" → "en-GB"). */
export function dictationLocale(raw: string | undefined | null): string {
  const tag = (raw ?? '').replace(/_/g, '-').split('-u-')[0];
  const [language, region] = tag.split('-');
  if (!language || language === 'und') return 'en-US';
  return region && /^[A-Za-z]{2}$|^\d{3}$/.test(region)
    ? `${language.toLowerCase()}-${region.toUpperCase()}`
    : language.toLowerCase();
}

/**
 * The toast for a recogniser error code, or null when nothing went wrong from
 * the user's view: they cancelled, or said nothing.
 */
export function dictationErrorMessage(code: string): string | null {
  switch (code) {
    case 'aborted':
    case 'no-speech':
    case 'speech-timeout':
      return null;
    case 'not-allowed':
      return 'Allow microphone and speech recognition for Kortix in Settings.';
    case 'network':
      return 'Dictation needs a connection. Check your network and try again.';
    case 'language-not-supported':
      return 'Dictation does not support your language on this device.';
    case 'service-not-allowed':
      return 'Speech recognition is turned off on this device.';
    case 'busy':
      return 'The microphone is in use by another app.';
    case 'interrupted':
      return 'Dictation stopped because another app took the microphone.';
    default:
      return 'Dictation stopped. Try again.';
  }
}
