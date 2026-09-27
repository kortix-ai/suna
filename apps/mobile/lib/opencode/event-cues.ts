/**
 * Which live SSE event earns a sound (and a haptic). Framework-free so it is
 * testable without React Native; `event-stream.ts` plays the returned cue.
 *
 * Rules:
 * - reply complete: a session goes idle after this stream saw it busy. A
 *   session never seen busy (already idle at connect, finished while the
 *   stream was down) plays nothing, and `session.status` idle followed by
 *   `session.idle` plays once.
 * - question / permission prompt: once per request id.
 * - turn error: once per turn. A user abort (`MessageAbortedError`) is not
 *   an error and also cancels the completion cue.
 * - only while the app is in the foreground. The tracker still records turns
 *   in the background, so a turn that started in the foreground and ends
 *   while backgrounded stays quiet.
 *
 * History never passes through here: transcripts, pending questions and
 * pending permissions after a reconnect are read over REST and written to the
 * store directly.
 */

import type { SoundEvent } from '@/stores/sound-store';

export interface EventCue {
  sound: SoundEvent;
  haptic?: 'success';
}

export interface CueEvent {
  type: string;
  properties?: Record<string, any>;
}

export interface CueTracker {
  /** Sessions this stream saw busy whose turn has not ended yet. */
  busy: Set<string>;
  /** Sessions whose current turn already played the error cue. */
  errored: Set<string>;
  /** Question / permission request ids that already played a cue. */
  prompted: Set<string>;
}

/** Bound on remembered prompt ids; the oldest are forgotten first. */
export const MAX_REMEMBERED_PROMPTS = 500;

const ABORT_ERROR = 'MessageAbortedError';

export function createCueTracker(): CueTracker {
  return { busy: new Set(), errored: new Set(), prompted: new Set() };
}

function rememberPrompt(tracker: CueTracker, key: string): boolean {
  if (tracker.prompted.has(key)) return false;
  tracker.prompted.add(key);
  if (tracker.prompted.size > MAX_REMEMBERED_PROMPTS) {
    const oldest = tracker.prompted.values().next().value;
    if (oldest !== undefined) tracker.prompted.delete(oldest);
  }
  return true;
}

function endTurn(tracker: CueTracker, sessionID: string): EventCue | null {
  if (!tracker.busy.delete(sessionID)) return null;
  return { sound: 'completion', haptic: 'success' };
}

/**
 * Record `event` in `tracker` and return the cue it earns, or null.
 * Call once per applied live event, in stream order.
 */
export function cueForEvent(
  tracker: CueTracker,
  event: CueEvent,
  ctx: { foreground: boolean },
): EventCue | null {
  const props = event.properties ?? {};
  const sessionID: unknown = props.sessionID;
  let cue: EventCue | null = null;

  switch (event.type) {
    case 'session.status': {
      if (typeof sessionID !== 'string') return null;
      const status = props.status?.type;
      if (status === 'busy' || status === 'retry') {
        if (!tracker.busy.has(sessionID)) tracker.errored.delete(sessionID);
        tracker.busy.add(sessionID);
      } else if (status === 'idle') {
        cue = endTurn(tracker, sessionID);
      }
      break;
    }

    case 'session.idle': {
      if (typeof sessionID !== 'string') return null;
      cue = endTurn(tracker, sessionID);
      break;
    }

    case 'session.error': {
      if (typeof sessionID !== 'string') return null;
      tracker.busy.delete(sessionID);
      if (props.error?.name === ABORT_ERROR) return null;
      if (tracker.errored.has(sessionID)) return null;
      tracker.errored.add(sessionID);
      cue = { sound: 'error' };
      break;
    }

    case 'question.asked':
    case 'permission.asked': {
      const id: unknown = props.id;
      if (typeof id !== 'string') return null;
      const kind = event.type === 'question.asked' ? 'q' : 'p';
      if (!rememberPrompt(tracker, `${kind}:${id}`)) return null;
      cue = { sound: 'notification' };
      break;
    }

    default:
      return null;
  }

  return ctx.foreground ? cue : null;
}
