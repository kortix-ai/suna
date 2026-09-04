/**
 * Append new agent messages to the durable transcript, in order, without ever
 * leaving a hole.
 *
 * The durable log is APPEND-ONLY: whatever lands is what a restarted worker
 * replays into `initialState.messages`. So the one thing this must never do is
 * write message N+1 when N did not land. The previous loop did exactly that —
 * it swallowed a failed append and advanced the watermark to `all.length`
 * regardless — so a single 5xx from the store could drop an assistant message
 * carrying a `toolCall` while its `toolResult` appended fine. The provider
 * rejects that pair on every subsequent request (Anthropic and OpenAI both 400
 * on a tool result with no preceding tool use), and since the damage is in the
 * append-only log, restarting the box does not clear it: the session is dead
 * for good.
 *
 * Stopping at the first failure costs nothing — the watermark stays on the
 * failed index and the next `turn_end` retries from there.
 */
export interface DurableMessageSink {
  appendMessage(message: unknown): Promise<unknown>;
}

export interface PersistNewMessagesResult {
  persisted: number;
  error: Error | null;
}

/**
 * Append `messages[from..]`, stopping at the first failure.
 *
 * Returns the new watermark and the first append error. The caller decides
 * whether to retry or fail the turn, without losing how far the append got.
 */
export async function persistNewMessages(
  sink: DurableMessageSink,
  messages: readonly unknown[],
  from: number,
  toDurable: (message: unknown) => unknown,
  log: (line: string) => void = (line) => console.error(line),
): Promise<PersistNewMessagesResult> {
  let persisted = Math.max(0, Math.min(from, messages.length));
  for (let i = persisted; i < messages.length; i++) {
    try {
      await sink.appendMessage(toDurable(messages[i]));
    } catch (error) {
      log(
        JSON.stringify({
          msg: 'session append failed; halting so the log keeps no hole',
          index: i,
          remaining: messages.length - i,
          error: String((error as Error)?.message ?? error),
        }),
      );
      return {
        persisted: i,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
    persisted = i + 1;
  }
  return { persisted, error: null };
}
