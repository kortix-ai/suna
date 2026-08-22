/**
 * Shared shapes for the voice room UI. Kept separate from the LiveKit event
 * plumbing in `page.tsx` so the presentational components below don't need
 * to know anything about `livekit-client` — they just render plain data.
 */

/** Mirrors LiveKit's ConnectionState plus a deliberate, non-error "left". */
export type ConnectionPhase = 'connecting' | 'connected' | 'reconnecting' | 'failed' | 'left';

export interface PresenceEntry {
  identity: string;
  name: string;
  isLocal: boolean;
  isAgent: boolean;
  micEnabled: boolean;
  speaking: boolean;
}

/**
 * The four things that can appear in a call's record — kept as four kinds and
 * not two "sides", because "the agent" is genuinely two different actors and
 * a tool call is nobody speaking at all:
 *
 *  - `human` — someone in the room said this out loud.
 *  - `voice` — the voice on the call said this out loud (the LiveKit worker's
 *    own speech, labelled with the bot's display name).
 *  - `kortix` — the KORTIX agent, the one being handed work, put this into the
 *    call from outside it: a `send_prompt`, a finished turn's result, an
 *    error. It reaches the room through the voice, so the `voice` line that
 *    follows is a paraphrase of it, not a duplicate of it.
 *  - `tool` — an MCP call the voice made (`ask_kortix`, `run_command`).
 *    Nothing was spoken. It must never be rendered as speech.
 */
export type CallEntryKind = 'human' | 'voice' | 'kortix' | 'tool';

/** One line of the durable record (`kortix.voice_call_turns`), already
 *  interpreted — see `toCallRecordEntries` for the role/speaker rules that
 *  produce these, which are the only place they should be applied. */
export interface CallRecordEntry {
  /** The call's monotonic cursor. Unique per call, so it doubles as the key. */
  cursor: number;
  kind: CallEntryKind;
  /** Display name for the spoken kinds; the tool's name for `tool`. */
  name: string;
  /** What was said. For `tool`, the call itself with its redundant
   *  `toolname: ` prefix and its ` → outcome` suffix already split off. */
  text: string;
  /** `tool` only: how it turned out — `ok`, `exit 1`, `timed out`, `failed`. */
  outcome: string | null;
  /** ISO-8601. */
  at: string;
}

/**
 * Something being said RIGHT NOW, straight off LiveKit's client-side
 * transcription — the one thing the durable record cannot be: instant.
 *
 * This is a tail on the end of the record, not part of it. An entry lives here
 * only until the same words arrive as a durable line (see `unrecordedLive`),
 * which is what keeps the feed from showing a sentence twice.
 */
export interface LiveUtterance {
  /** LiveKit's segment id — stable across the interim revisions of one utterance. */
  id: string;
  name: string;
  isLocal: boolean;
  text: string;
  /** false while the STT result is still being revised. */
  final: boolean;
  firstReceivedTime: number;
}
