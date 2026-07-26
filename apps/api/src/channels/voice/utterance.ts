/**
 * Every way Kortix puts words into a live call, in ONE place — each paired with
 * the transcript line that has to survive it.
 *
 * Two different strings are needed for the same utterance, and conflating them
 * is what made the call record wrong in both directions:
 *
 *  - `instruction` is what goes on the wire. The worker hands it to
 *    `generateReply({ instructions })` (apps/voice-agent/src/inbound-replies.ts),
 *    so it is a DIRECTION TO A MODEL — "[result] The work finished. Here is the
 *    outcome, which you should now say out loud in your own words…". Recording
 *    that verbatim would fill the transcript with stage directions nobody said.
 *  - `transcript` is what the room is being told, stripped of the wrapper. That
 *    is the line a human (or the agent re-reading its own call) needs.
 *
 * Keeping them adjacent is the point. Before this, `promptVoiceAgent` took a
 * bare string, and every caller invented its own framing inline — so there was
 * no way to record a Kortix utterance without re-deriving the payload out of a
 * prompt, and consequently nothing recorded it at all: the /voice page showed
 * none of what the Kortix agent said into the call, because the ONLY record of
 * it was whatever the worker happened to echo back via ConversationItemAdded.
 *
 * Nothing here touches the DB or the network, which is what makes the exact
 * wording testable — see unit-voice-recording.test.ts. The `instruction` text
 * of each kind is carried over verbatim from the call sites it replaces
 * (turn.ts, answer-watch.ts, executor/db-deps.ts); changing it changes what a
 * live call actually says, so treat these strings as behaviour, not comments.
 *
 * WHY THESE INSTRUCTIONS ARE PHRASED THE WAY THEY ARE. Voice is the only channel
 * with its OWN LLM on the far side. Slack, Teams and email are one model talking
 * to humans; here, whatever apps/api says is read by a second model that has its
 * own conversation history and its own beliefs — and that model can be, and has
 * been, WRONG about the project. On a real call a transcription artifact led it
 * to assert "this project is about developing a system involving dogs", and
 * because that claim sat in its history as fact, every correct answer sent from
 * here CONTRADICTED it. It could not simply relay an answer that disagreed with
 * itself, so it asked Kortix again to resolve the contradiction, indefinitely,
 * at real cost per ask.
 *
 * The old phrasing made that worse. "[result] … say it out loud now, in your own
 * words" is a licence: own words invites blending the answer with what the model
 * already believes. So every instruction below that carries FACT now does three
 * things instead — states that this is what Kortix says, that it SUPERSEDES
 * anything the model said earlier, and that nothing may be added to it. The
 * supersede clause is the one that breaks the loop: without explicit permission
 * to be wrong, the model keeps trying to reconcile its own false claim.
 *
 * They are still INSTRUCTIONS run through `generateReply`, not scripts read by
 * `say()`. A result recited verbatim by TTS sounds like a robot reading a
 * ticket, and the answer text is written for a chat surface, not a mouth.
 * Removing the licence to invent is not the same as removing natural phrasing.
 */

/**
 * The clause that lets the voice model abandon a claim it already made.
 *
 * Shared verbatim by every utterance that asserts something about the project,
 * because half of it working is worse than none: if a `result` supersedes but an
 * `error` does not, the model still has a standing contradiction to chase.
 */
const SUPERSEDES =
  'This is what your Kortix agent — the one that actually knows this project — says, so it ' +
  'is now the truth and it REPLACES anything you said or assumed earlier in this call. If it ' +
  'contradicts something the room already heard you say, correct that plainly in the same ' +
  'breath ("I had that wrong — it is actually…") and move on. Do not ask Kortix about it again.';

/** No invention: say this and only this. */
const NOTHING_ADDED =
  'Say only what is here, in natural spoken language. Add no detail, no explanation, no ' +
  'guess and no context that is not in it.';

export type KortixUtteranceKind = 'say' | 'progress' | 'result' | 'question' | 'review' | 'error';

export interface KortixUtterance {
  kind: KortixUtteranceKind;
  /** Sent to the worker and handed to `generateReply` as INSTRUCTIONS. */
  instruction: string;
  /** The transcript line — what the room is told, without the instruction wrapper. */
  transcript: string;
}

/**
 * `speaker` for every turn Kortix itself puts into a call.
 *
 * Deliberately NOT the bot's display name: the worker labels the speech it
 * actually produces with that (apps/voice-agent/src/transcripts.ts), and the
 * two are different events — what Kortix asked the room to hear, and what the
 * voice model then said. A reader has to be able to tell them apart, and both
 * are `role: 'agent'` because the CHECK constraint on voice_call_turns has
 * exactly three roles (user | agent | tool) and neither of these is a human or
 * a tool call.
 */
export const KORTIX_SPEAKER = 'kortix';

/**
 * `send_prompt` — the Kortix agent speaking into the call unprompted.
 *
 * FRAME IT. What reaches the worker is handed to `generateReply` as
 * INSTRUCTIONS, not as a script — so raw text arrives at the voice model as an
 * unattributed order and it has no idea the words came from its own Kortix
 * agent, or whether it is meant to say them, answer them, or act on them.
 * Sending "the connector works straight from the session" raw made the call
 * treat a statement as a prompt. Every other kind below tags its intent; this
 * one must too.
 */
export function kortixSay(text: string): KortixUtterance {
  return {
    kind: 'say',
    instruction:
      `[say] Your Kortix agent — the one you hand work to — wants the room to hear this now. ` +
      `Say it out loud in your own voice, keeping its meaning exactly, and do not treat it ` +
      `as a question or a task to act on. ${SUPERSEDES} ${NOTHING_ADDED} Here it is: ${text}`,
    transcript: text,
  };
}

/**
 * A step of an in-flight turn, spoken sparingly (see turn.ts's throttle).
 *
 * No supersede clause: a step is not a finding, and telling the model that a
 * step overrides its beliefs would invite it to spin one into an answer. What it
 * DOES need is the ban on extrapolating — "reading the config" is not permission
 * to guess what the config says.
 */
export function kortixProgress(step: string): KortixUtterance {
  return {
    kind: 'progress',
    instruction:
      `[progress] You are still working on the request; there is no answer yet. Current step: ${step}. Mention this briefly and naturally, in one short sentence, only if it has been a while since you last spoke. Say what the step is and nothing else — do not guess what it will find, and do not treat it as an answer.`,
    transcript: `Working on: ${step}`,
  };
}

/**
 * The outcome of a finished turn — the answer to whatever was handed over.
 *
 * THE utterance this whole file's framing exists for. It used to end "say it out
 * loud now, in your own words", which is exactly the licence that let the voice
 * model blend a correct answer with a false belief it was holding. It now states
 * the answer, supersedes the belief, and forbids the addition.
 */
export function kortixResult(text: string): KortixUtterance {
  return {
    kind: 'result',
    instruction:
      `[result] Kortix has answered. State this answer to the room now, briefly and ` +
      `conversationally. ${SUPERSEDES} ${NOTHING_ADDED} The answer: ${text}`,
    transcript: text,
  };
}

/**
 * A turn that failed. `message` is the cause, if there is a readable one.
 *
 * Supersedes too, and for the same reason as a result: "that didn't work" is a
 * fact about the request, and a model holding a belief about what the request
 * WOULD have said must not talk over it with a theory.
 */
export function kortixError(message?: string | null): KortixUtterance {
  const cause = message?.trim() ? `: ${message.trim()}` : '';
  return {
    kind: 'error',
    instruction:
      `[error] That request failed${cause}. Tell them briefly that it didn't work, without ` +
      `reading the error verbatim. ${SUPERSEDES} Do not offer a theory about why, do not ` +
      `answer the original question from memory, and do not hand the same request over again.`,
    transcript: `That request failed${cause}`,
  };
}

/** The agent asking the room something and ending its turn (see relayTurnQuestion). */
export function kortixQuestion(text: string): KortixUtterance {
  return {
    kind: 'question',
    instruction: `[question] Ask the room this, in your own words: ${text}`,
    transcript: text,
  };
}

/** A change ready for review, announced in the call. */
export function kortixReview(title: string): KortixUtterance {
  return {
    kind: 'review',
    instruction: `[review] Mention briefly that ${title} is ready for review, and that the link is in the meeting chat.`,
    transcript: `${title} is ready for review — the link is in the meeting chat.`,
  };
}
