/**
 * Turn relay for the voice platform — how a Kortix turn narrates itself into a
 * live call.
 *
 * Slack and Teams render a turn as a message that gets edited in place. Voice
 * has no canvas: everything here becomes speech, so the bar for saying anything
 * at all is much higher. Two rules follow from that:
 *
 *  - Steps are spoken sparingly. A chat surface can list twelve steps; reading
 *    twelve steps aloud to a room is unbearable. We speak the first one (so the
 *    silence after "let me check" is explained) and then only occasionally.
 *  - Nothing is spoken twice. The realtime model already said "let me check
 *    that" when it called ask_kortix, so echoing the same beat back is worse
 *    than silence.
 */
import { listCallsForSession, promptVoiceAgent } from './runtime';

/** Speak at most one progress line per this interval, per session. */
const STEP_SPEAK_INTERVAL_MS = 25_000;

const lastSpokenAt = new Map<string, number>();
const spokenStepCount = new Map<string, number>();

function liveCallId(sessionId: string): string | null {
  const calls = listCallsForSession(sessionId);
  return calls.length > 0 ? calls[0]!.callId : null;
}

export function hasLiveCall(sessionId: string): boolean {
  return liveCallId(sessionId) !== null;
}

export async function relayTurnStep(
  sessionId: string,
  title: string,
  _opts: unknown = {},
): Promise<boolean> {
  const callId = liveCallId(sessionId);
  if (!callId) return false;

  const count = (spokenStepCount.get(sessionId) ?? 0) + 1;
  spokenStepCount.set(sessionId, count);

  const now = Date.now();
  const last = lastSpokenAt.get(sessionId) ?? 0;
  // Always voice the first step — it tells the room why nothing is happening —
  // then throttle hard so the agent doesn't monologue its own todo list.
  const shouldSpeak = count === 1 || now - last > STEP_SPEAK_INTERVAL_MS;
  if (!shouldSpeak) return false;

  lastSpokenAt.set(sessionId, now);
  return promptVoiceAgent(
    callId,
    `[progress] You are still working on the request. Current step: ${title}. Mention this briefly and naturally, in one short sentence, only if it has been a while since you last spoke.`,
  );
}

export async function relayTurnAnswer(
  sessionId: string,
  text: string,
  _blocks?: unknown[],
): Promise<boolean> {
  const callId = liveCallId(sessionId);
  if (!callId) return false;
  clear(sessionId);
  return promptVoiceAgent(
    callId,
    `[result] The work finished. Here is the outcome, which you should now say out loud in your own words, conversationally and briefly: ${text}`,
  );
}

export async function relayTurnEnd(
  sessionId: string,
  status: 'idle' | 'error' = 'idle',
  errorInfo?: { message?: string },
): Promise<boolean> {
  const callId = liveCallId(sessionId);
  if (!callId) return false;
  clear(sessionId);

  // A clean end with no answer means relayTurnAnswer already spoke the result;
  // saying anything more would just be noise in the room.
  if (status !== 'error') return false;

  return promptVoiceAgent(
    callId,
    `[error] That request failed${errorInfo?.message ? `: ${errorInfo.message}` : ''}. Tell them briefly that it didn't work, without reading the error verbatim.`,
  );
}

export async function relayTurnQuestion(
  sessionId: string,
  questions: Array<{ question?: string }>,
): Promise<{ ok: boolean; answers?: string[][]; error?: string }> {
  const callId = liveCallId(sessionId);
  if (!callId) return { ok: false, error: 'no live call' };

  const text = questions.map((q) => q.question ?? '').filter(Boolean).join(' ');
  if (!text) return { ok: false, error: 'no question' };

  promptVoiceAgent(callId, `[question] Ask the room this, in your own words: ${text}`);

  // The answer arrives as speech, which reaches the session through ask_kortix as
  // a NEW turn — there is no way to block here for it, and blocking is exactly
  // what would wedge the agent. So end the turn and let the reply wake it.
  return { ok: true, answers: [['(asked in the call — the reply will arrive as a new message)']] };
}

export async function relayReviewCard(
  sessionId: string,
  item: { title?: string },
): Promise<{ ok: boolean; error?: string }> {
  const callId = liveCallId(sessionId);
  if (!callId) return { ok: false, error: 'no live call' };
  const title = item.title ?? 'a change';
  promptVoiceAgent(
    callId,
    `[review] Mention briefly that ${title} is ready for review, and that the link is in the meeting chat.`,
  );
  return { ok: true };
}

function clear(sessionId: string): void {
  lastSpokenAt.delete(sessionId);
  spokenStepCount.delete(sessionId);
}
