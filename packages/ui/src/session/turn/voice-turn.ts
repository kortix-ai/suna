/**
 * A voice call's turn the voice answered itself (its fast lane: no agent turn), as the session keeps it: a note the
 * voice writes into the session (packages/voice, cascade.ts) so the agent has the conversation, in one of two shapes:
 *
 *   [Voice turn answered by the voice directly; part of this conversation]
 *   User: <what the caller said>
 *   You said: <what the voice answered>
 *
 *   [You added this on your own after they said "<…>"; part of this conversation]   (or "in a quiet moment")
 *   You said: <what the voice said unprompted>
 *
 * and the caller's words steered into the agent's running turn: `[said while you work] <words>`.
 *
 * Read by prefix and line, never by a pattern over the whole text (no backtracking on a long note).
 */
export interface VoiceTurnInfo {
  /** The caller's words; absent for a line the voice said on its own. */
  user?: string;
  /** What the voice said; absent for words steered into the agent's work (its own answer follows as a turn). */
  said?: string;
}

const ANSWERED = '[Voice turn answered by the voice directly; part of this conversation]';
const ADDED = '[You added this on your own';
const USER = '\nUser: ';
const SAID = '\nYou said: ';
const STEERED = '[said while you work] ';

export function parseVoiceTurn(text: string): VoiceTurnInfo | null {
  const t = text.trim();
  if (t.startsWith(STEERED)) {
    const user = t.slice(STEERED.length).trim();
    return user ? { user } : null;
  }
  if (t.startsWith(ANSWERED)) {
    const u = t.indexOf(USER, ANSWERED.length - 1);
    const s = u < 0 ? -1 : t.indexOf(SAID, u + USER.length);
    if (u < 0 || s < 0) return null;
    // A note holding a second marker did not come from cleanly written words: drawn as it is, never as a call turn.
    if (t.indexOf(USER, u + USER.length) >= 0 || t.indexOf(SAID, s + SAID.length) >= 0) return null;
    const said = t.slice(s + SAID.length).trim();
    return said ? { user: t.slice(u + USER.length, s).trim(), said } : null;
  }
  if (t.startsWith(ADDED)) {
    const end = t.indexOf('; part of this conversation]');
    const s = end < 0 ? -1 : t.indexOf(SAID, end);
    if (s < 0) return null;
    const said = t.slice(s + SAID.length).trim();
    return said ? { said } : null;
  }
  return null;
}
