import type { Command } from '@/ui';
import type { QueueRow } from './queue-projection';

/**
 * A `/` command typed while the session works, held until it can run.
 *
 * A command is not an inbox row: it is dispatched by `runCommand`, so no
 * admission gate sees it, and one put on the wire mid-turn aborts the turn in
 * progress. Refusing it was a dead end (KRTX-2464): the draft stayed in the
 * editor and the user had to watch for the turn to end and send it again. It
 * is held here instead, drawn as a row in the queued list with a Remove, and
 * dispatched by `canReleaseHeldCommand` once the session can take it.
 *
 * ponytail: tab-local, in memory. A reload or a closed tab drops a held
 * command, and a second tab does not see it. Make the command an inbox row
 * (`POST .../prompts` with a command payload, delivered through the runtime's
 * `/command` verb) when that matters.
 */
export interface HeldCommand {
  id: string;
  command: Command;
  args?: string;
  split?: { before: string; after: string };
}

export const HELD_COMMAND_ROW_PREFIX = 'command:';

export function heldCommandLabel(held: HeldCommand): string {
  const name = `/${held.command.name}`;
  if (held.split) return [held.split.before, name, held.split.after].filter(Boolean).join(' ');
  return held.args ? `${name} ${held.args}` : name;
}

/** Rows for the queued list, after every inbox row: they run after them. */
export function heldCommandRows(held: readonly HeldCommand[]): QueueRow[] {
  return held.map((entry) => {
    const label = heldCommandLabel(entry);
    return {
      id: `${HELD_COMMAND_ROW_PREFIX}${entry.id}`,
      clientMessageId: `${HELD_COMMAND_ROW_PREFIX}${entry.id}`,
      text: label,
      rawText: label,
      editText: null,
      attachmentCount: 0,
      state: 'queued',
      removable: true,
      retryable: false,
      interruptible: false,
      takeBackEligible: false,
      command: true,
    };
  });
}

/**
 * The first held command may go out only when nothing else can run first:
 * no turn (server authority, never the 300 ms busy fade), a switched runtime
 * (`runCommand` swallows a dispatch at a box that is not up), no question or
 * permission on screen, and no inbox row still waiting — those were typed
 * first, or were queued behind this command and are about to be admitted, and
 * a command dispatched next to an admitted prompt aborts its turn.
 */
export function canReleaseHeldCommand(input: {
  sessionWorking: boolean;
  runtimeReady: boolean;
  awaitingUserInput: boolean;
  inboxRows: readonly Pick<QueueRow, 'state'>[];
}): boolean {
  if (input.sessionWorking || !input.runtimeReady || input.awaitingUserInput) return false;
  // A failed row waits for the user, not for a turn: it does not hold a command.
  return input.inboxRows.every((row) => row.state === 'failed');
}
