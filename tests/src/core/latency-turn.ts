/**
 * Correlating a `prompt_async` call to the assistant reply it produced.
 *
 * The turn-latency spec (PR #7840) §5's own methodology sends the SAME trivial
 * prompt ("Reply with exactly: OK") on every iteration, on purpose — so the
 * generated text can never be used to tell turns apart. The harness instead
 * diffs the OpenCode message-id set before/after sending: any assistant
 * message whose id was not already known is this turn's reply. Same wire
 * shape `tests/src/flows/session-thread-reliability.flow.ts` already uses
 * (`info.id`/`info.role`/`info.time.{created,completed}`).
 */

export interface OcMessage {
  info?: {
    id?: string;
    role?: string;
    time?: { created?: number; completed?: number };
  };
}

export function knownMessageIds(messages: OcMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const m of messages) {
    const id = m.info?.id;
    if (id) ids.add(id);
  }
  return ids;
}

/** First assistant message in `messages` whose id is not in `known`, or null. */
export function findNewAssistantMessage(
  messages: OcMessage[],
  known: Set<string>,
): OcMessage | null {
  for (const m of messages) {
    if (m.info?.role !== 'assistant') continue;
    const id = m.info?.id;
    if (id && known.has(id)) continue;
    return m;
  }
  return null;
}

/**
 * The turn-latency spec (PR #7840) §5's "model generation": assistant created ->
 * completed. Both timestamps come from the SAME clock (the box's OpenCode
 * process), so this delta is immune to client/box clock skew — unlike any
 * comparison against a client-observed wall-clock time. Null while still
 * generating, or on a non-positive delta (a clock anomaly, not a real 0ms
 * turn) — never a misleading negative or zero duration.
 */
export function messageGenerationMs(message: OcMessage): number | null {
  const time = message.info?.time;
  if (!time || typeof time.created !== 'number' || typeof time.completed !== 'number') {
    return null;
  }
  const deltaMs = time.completed - time.created;
  return deltaMs > 0 ? deltaMs : null;
}
