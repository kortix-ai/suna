import type { PreviewPortProbe } from '@kortix/sdk';

/**
 * A call's state as the bar shows it, and the relay messages that move it (packages/voice README, "The call,
 * from the browser"). Pure: `use-voice-call.ts` owns the socket and feeds this.
 */
export type CallPhase = 'connecting' | 'live' | 'reconnecting' | 'ended';

/** Why a call ended by itself. A hang-up closes the bar instead. */
export type CallEnd =
  /** The relay closed the call (`{type:'closed'}`). */
  | 'closed'
  /** Nothing listens on the relay's port: the sandbox started before the flag was on. */
  | 'unavailable'
  /** The first dial or the audio failed. */
  | 'failed'
  /** A live call dropped and every redial failed. */
  | 'lost';

export interface CallLine {
  role: 'agent' | 'user';
  /** The relay's name for the speaker: the voice's name for an agent line. */
  who: string;
  text: string;
}

export interface CallState {
  phase: CallPhase;
  /** The voice is audible now. */
  speaking: boolean;
  /** The latest line said or heard. */
  line: CallLine | null;
  end: CallEnd | null;
  /** The browser gave no microphone: the call only listens to the voice. */
  micBlocked: boolean;
  /** Redials since the call was last live (or, before its first `ready`, since it was placed). */
  redials: number;
  /** When it was first answered (ms): a call's length counts from there, across reconnects. */
  liveAt: number | null;
}

export const INITIAL_CALL: CallState = {
  phase: 'connecting',
  speaking: false,
  line: null,
  end: null,
  micBlocked: false,
  redials: 0,
  liveAt: null,
};

/** A live call that drops is dialed again after each of these waits, then it ends as `lost`. */
export const REDIAL_MS = [1_000, 2_000, 4_000] as const;

/**
 * A first dial that drops before `ready` is dialed again after each of these waits, then the call ends: a box that
 * just started (a call placed from the agent page boots its own session) opens the relay's port a few seconds after
 * its daemon answers.
 */
export const DIAL_MS = [1_000, 2_000, 3_000, 4_000] as const;

export type CallEvent =
  | { type: 'ready'; at?: number }
  | { type: 'text'; role?: unknown; who?: unknown; text?: unknown }
  | { type: 'closed' }
  /** The socket closed without `closed`. `relay` is the health probe's answer, taken only for a first dial. */
  | { type: 'drop'; relay?: PreviewPortProbe }
  | { type: 'audio-failed' }
  | { type: 'speaking'; on: boolean }
  | { type: 'mic-blocked' };

export function reduceCall(state: CallState, event: CallEvent): CallState {
  switch (event.type) {
    case 'ready':
      return state.phase === 'ended' ? state : { ...state, phase: 'live', redials: 0, liveAt: state.liveAt ?? event.at ?? null };
    case 'text': {
      const { role, who, text } = event;
      // `screen` lines are what the voice read off a shared screen: neither said nor heard.
      if ((role !== 'agent' && role !== 'user') || typeof text !== 'string' || !text.trim()) return state;
      return { ...state, line: { role, who: typeof who === 'string' ? who : '', text: text.trim() } };
    }
    case 'closed':
      return ended(state, 'closed');
    case 'audio-failed':
      return state.phase === 'ended' ? state : ended(state, 'failed');
    case 'drop':
      if (state.phase === 'ended') return state;
      if (state.phase === 'connecting') {
        if (state.redials < DIAL_MS.length) return { ...state, redials: state.redials + 1 };
        return ended(state, event.relay === 'unreachable' ? 'unavailable' : 'failed');
      }
      if (state.phase === 'live') return { ...state, phase: 'reconnecting', speaking: false, redials: 0 };
      return state.redials + 1 < REDIAL_MS.length ? { ...state, redials: state.redials + 1 } : ended(state, 'lost');
    case 'speaking':
      return state.speaking === event.on ? state : { ...state, speaking: event.on };
    case 'mic-blocked':
      return state.micBlocked ? state : { ...state, micBlocked: true };
  }
}

function ended(state: CallState, end: CallEnd): CallState {
  return { ...state, phase: 'ended', end, speaking: false };
}

/** The voice's gain while `duck` is on: quieter, because someone may be talking. */
export const DUCK_GAIN = 0.25;
/** `clear` lowers the voice for this long before the queue is dropped, so the cut is a roll-off, not a click. */
export const CLEAR_ROLLOFF_MS = 120;
/** `hold` pauses the queue within this beat, after the gain went to 0. */
export const HOLD_PAUSE_MS = 60;

/** What the playback messages act on: the speaker worklet's port and the voice's gain. */
export interface PlaybackOutput {
  post(message: 'clear' | 'pause' | 'resume'): void;
  level(gain: number): void;
}

/**
 * The relay's playback messages (`clear`, `duck`, `hold`), ported from the voice lab's call page. A `clear`
 * ends a hold and a duck as well: no `hold off` follows it, and the worklet's flush unpauses.
 */
export function createPlayback(
  out: PlaybackOutput,
  schedule: (run: () => void, ms: number) => void = (run, ms) => void setTimeout(run, ms),
) {
  let held = false;
  let ducked = false;
  return {
    /** Where a speaker set up later starts. */
    current: () => ({ held, ducked }),
    /** Acts on a playback message; false for any other message. */
    handle(message: { type?: unknown; on?: unknown }): boolean {
      switch (message.type) {
        case 'clear':
          held = ducked = false;
          out.level(0);
          schedule(() => {
            out.post('clear');
            out.level(held ? 0 : ducked ? DUCK_GAIN : 1);
          }, CLEAR_ROLLOFF_MS);
          return true;
        case 'duck':
          ducked = !!message.on;
          if (!held) out.level(ducked ? DUCK_GAIN : 1);
          return true;
        case 'hold':
          held = !!message.on;
          if (held) {
            out.level(0);
            schedule(() => held && out.post('pause'), HOLD_PAUSE_MS);
          } else {
            out.post('resume');
            out.level(ducked ? DUCK_GAIN : 1);
          }
          return true;
        default:
          return false;
      }
    },
  };
}

/** The voice counts as audible above this output level (RMS), and as speaking until this long after. */
export const AUDIBLE_RMS = 0.003;
export const SPEAKING_HOLD_MS = 250;
