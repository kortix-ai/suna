import type { voice } from '@livekit/agents';
/**
 * The other direction: Kortix speaking INTO the call once a `send_prompt`
 * hand-off finishes. Mirrors the old in-process `promptVoiceAgent()` path,
 * but across a process boundary this time.
 *
 * The contract this expects from apps/api (see README.md): once
 * `continueSession()` resolves for a hand-off started by `send_prompt`,
 * apps/api sends a LiveKit data message into this call's room —
 * `RoomServiceClient.sendData(roomName, utf8(JSON.stringify({ type:
 * 'kortix_reply', call_id, text })), DataPacket_Kind.RELIABLE, { topic:
 * 'kortix' })` (verified to exist: livekit-server-sdk@2.17.0's
 * `RoomServiceClient.sendData`). This worker just needs to listen for it —
 * LiveKit already delivers data messages to every participant in the room,
 * agent included, with no separate subscription step required.
 *
 * `text` is an INSTRUCTION, not a script — every caller in apps/api's
 * `turn.ts` writes it that way on purpose: `"[progress] ... Mention this
 * briefly and naturally, in one short sentence"`, `"[result] ... say out loud
 * in your own words"`, `"[question] Ask the room this, in your own words:
 * ..."`. That only makes sense if an LLM turns it into speech. `session.say()`
 * does the opposite — per agent_activity.ts's `say()`, it is a literal
 * TTS-only pass-through with no LLM step, so calling it here spoke those
 * instructions verbatim into the room ("Mention this briefly and naturally,
 * in one short sentence: Fetching data" — an actual sentence a participant
 * would hear), and `transcripts.ts` then recorded exactly that, because a
 * ConversationItemAdded message's content is always the literal string that
 * was spoken (verified: @livekit/agents@1.5.5's `ChatContent` type is
 * `ImageContent | AudioContent | Instructions | string` — say() puts its
 * `text` argument straight into that as-is). The transcript wasn't lying;
 * the call was speaking the wrong thing. `generateReply({ instructions })`
 * is the fix already used one file over for the intro greeting
 * (index.ts's `session.generateReply({ instructions: 'Greet the room...' })`)
 * — it runs `text` through the LLM, so what gets spoken (and therefore what
 * lands in voice_call_turns via the same ConversationItemAdded path) is the
 * model's natural phrasing of the instruction, not the instruction itself.
 */
import { type Room, RoomEvent } from '@livekit/rtc-node';
import type { CallContext } from './call-context';

const REPLY_TOPIC = 'kortix';

interface KortixReplyPayload {
  type?: unknown;
  call_id?: unknown;
  text?: unknown;
}

function parsePayload(raw: Uint8Array): KortixReplyPayload | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(raw));
    return parsed && typeof parsed === 'object' ? (parsed as KortixReplyPayload) : null;
  } catch {
    return null;
  }
}

export function wireInboundReplies(
  room: Room,
  session: voice.AgentSession<CallContext>,
  ctx: CallContext,
): void {
  room.on(RoomEvent.DataReceived, (payload, _participant, _kind, topic) => {
    if (topic !== REPLY_TOPIC) return;

    const message = parsePayload(payload);
    if (!message || message.type !== 'kortix_reply') return;

    // A worker process can run many calls, but not more than one room per
    // job — this guard only matters if a stray message ever lands on the
    // wrong topic/room pairing upstream.
    if (typeof message.call_id === 'string' && message.call_id !== ctx.callId) return;

    const text = typeof message.text === 'string' ? message.text.trim() : '';
    if (!text) return;

    // NOT session.say(text) — see the doc comment above. `text` is an
    // instruction ("mention this briefly", "say this in your own words"),
    // and generateReply() is what actually turns it into natural speech
    // instead of reciting it.
    //
    // generateReply() THROWS `AgentSession is not running` once the session has
    // closed, and because this is an event handler nobody awaits, that throw
    // surfaced only as an unhandled rejection in the worker log — the call
    // looked healthy and the hand-off silently never reached the room. A job
    // whose session has closed can still be connected to the room (it holds the
    // participant until shutdown), so it keeps RECEIVING these messages while
    // being incapable of acting on them. Drop them explicitly instead of
    // throwing into the void; onSessionClosed in index.ts is what stops the
    // dead job from squatting the room in the first place.
    try {
      const reply = session.generateReply({ instructions: text });
      void Promise.resolve(reply).catch((err) => {
        console.error('[voice] generateReply failed for kortix_reply', err);
      });
    } catch (err) {
      console.error('[voice] dropped kortix_reply — session not running', err);
    }
  });
}
