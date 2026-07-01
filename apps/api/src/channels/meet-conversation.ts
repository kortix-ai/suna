import { isWake } from './meet-realtime';
import { runSharedTimeout, stopSharedTimer, type SharedTimer } from '../shared/effect';

export interface MeetTurn {
  speaker: string;
  text: string;
  spoken: boolean;
}

export interface MeetIngestInput {
  sessionId: string;
  speaker: string;
  text: string;
  spoken: boolean;
  wake: string;
  deliver: (turn: MeetTurn) => void;
}

export interface MeetConversationOptions {
  debounceMs?: number;
  followUpWindowMs?: number;
}

interface SessionState {
  buffer: string[];
  speaker: string;
  spoken: boolean;
  deliver: (turn: MeetTurn) => void;
  timer: SharedTimer | null;
  followUpUntil: number;
}

const MAX_TRACKED_SESSIONS = 512;
const PRUNE_AFTER_MS = 60_000;

export function createMeetConversation(options: MeetConversationOptions = {}) {
  const debounceMs = options.debounceMs ?? 1_200;
  const followUpWindowMs = options.followUpWindowMs ?? 20_000;
  const sessions = new Map<string, SessionState>();

  function flush(sessionId: string): void {
    const state = sessions.get(sessionId);
    if (!state) return;
    state.timer = null;
    const text = state.buffer.join(' ').replace(/\s+/g, ' ').trim();
    state.buffer = [];
    if (!text) return;
    state.followUpUntil = Date.now() + followUpWindowMs;
    state.deliver({ speaker: state.speaker, text, spoken: state.spoken });
  }

  function ingest(input: MeetIngestInput): void {
    const existing = sessions.get(input.sessionId);
    const buffering = existing != null && existing.timer != null;
    const inWindow = existing != null && Date.now() < existing.followUpUntil;
    if (!buffering && !inWindow && !isWake(input.text, input.wake)) return;

    const state = existing ?? freshState(input);
    state.buffer.push(input.text);
    state.speaker = input.speaker;
    state.spoken = input.spoken;
    state.deliver = input.deliver;
    if (state.timer) stopSharedTimer(state.timer);
    state.timer = runSharedTimeout(() => flush(input.sessionId), debounceMs);
    sessions.set(input.sessionId, state);
    prune();
  }

  function freshState(input: MeetIngestInput): SessionState {
    return {
      buffer: [],
      speaker: input.speaker,
      spoken: input.spoken,
      deliver: input.deliver,
      timer: null,
      followUpUntil: 0,
    };
  }

  function prune(): void {
    if (sessions.size < MAX_TRACKED_SESSIONS) return;
    const cutoff = Date.now() - PRUNE_AFTER_MS;
    for (const [id, state] of sessions) {
      if (!state.timer && state.buffer.length === 0 && state.followUpUntil < cutoff) {
        sessions.delete(id);
      }
    }
  }

  return {
    ingest,
    flush,
    inFollowUp(sessionId: string): boolean {
      const state = sessions.get(sessionId);
      return state != null && Date.now() < state.followUpUntil;
    },
    size(): number {
      return sessions.size;
    },
  };
}

export const meetConversation = createMeetConversation();
