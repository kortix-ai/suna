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

/**
 * Append `messages[from..]`, stopping at the first failure.
 *
 * Returns the new watermark: the index of the first message NOT persisted, so
 * a caller can assign it straight back and resume there next time. Never
 * throws — a turn that produced a correct answer must not be reported as
 * failed because bookkeeping could not be written.
 */
export async function persistNewMessages(
  sink: DurableMessageSink,
  messages: readonly unknown[],
  from: number,
  toDurable: (message: unknown) => unknown,
  log: (line: string) => void = (line) => console.error(line),
): Promise<number> {
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
      return i;
    }
    persisted = i + 1;
  }
  return persisted;
}
