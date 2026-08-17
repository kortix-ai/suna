/**
 * Whether a tool call is executing right now.
 *
 * The queue's interrupt path waits on this: a message queued mid-run stops the
 * turn at the next tool boundary, and "boundary" means no tool is
 * mid-execution. Aborting while a Bash command, file write, or git commit is
 * running kills it halfway — the one thing the interrupt must never do. A tool
 * in `pending` has not started executing, so it does not block; interrupting
 * then is exactly the boundary the user wants, because the tool never starts.
 *
 * Only the LAST assistant message is scanned, and only while it is still open.
 * A completed or errored turn cannot have a genuinely live tool, and a dead
 * turn's husk (sandbox died mid-run, parts frozen at `running`) must not block
 * interrupts for the rest of the session's life. The interrupt additionally
 * requires the server to report busy (`shouldInterruptForQueue`), so a frozen
 * part on an idle session never reaches this check at all.
 */

/** The shape this predicate needs. Wider message types satisfy it structurally. */
export interface RunningToolMessage {
  info: {
    role: string;
    time?: { completed?: number | null; [key: string]: unknown } | null;
    error?: unknown;
  };
  parts?: Array<{ type?: string; state?: { status?: string } | null } | null | undefined> | null;
}

export function hasRunningToolCall(messages: RunningToolMessage[] | undefined): boolean {
  if (!messages?.length) return false;

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.info.role !== 'assistant') continue;
    if (message.info.time?.completed || message.info.error) return false;
    return (message.parts ?? []).some(
      (part) => part?.type === 'tool' && part.state?.status === 'running',
    );
  }
  return false;
}
