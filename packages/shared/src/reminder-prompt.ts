/**
 * The text a session reminder fire delivers into its session:
 *
 *   [REMINDER reminder.<12 hex> — one-time scheduled check-in on this session, not a new user message.]
 *
 *   <reminder text>
 *
 * The API writes it (`reminderPromptText`); web and mobile read it back
 * (`parseReminderPrompt`) to render the turn as a reminder, not as something
 * the person typed. One module owns both sides so they cannot drift.
 */

export interface ReminderPromptInfo {
  /** `reminder.<12 hex>`. */
  id: string;
  recurring: boolean;
  /** The reminder text, without the header. */
  prompt: string;
}

export function reminderPromptText(input: ReminderPromptInfo): string {
  const header = input.recurring
    ? `[REMINDER ${input.id} — recurring scheduled check-in on this session, not a new user message. When it is no longer needed, run \`kortix reminders rm ${input.id}\`.]`
    : `[REMINDER ${input.id} — one-time scheduled check-in on this session, not a new user message.]`;
  return `${header}\n\n${input.prompt}`;
}

const HEAD = /^\[REMINDER (reminder\.[0-9a-f]{12}) — (one-time|recurring) /;

/** The reminder a prompt carries, or undefined for any other text. Linear time. */
export function parseReminderPrompt(rawText: string | null | undefined): ReminderPromptInfo | undefined {
  if (!rawText) return undefined;
  const head = HEAD.exec(rawText);
  if (!head) return undefined;
  const close = rawText.indexOf(']', head[0].length);
  const lineEnd = rawText.indexOf('\n', head[0].length);
  if (close < 0 || (lineEnd >= 0 && lineEnd < close)) return undefined;
  return { id: head[1]!, recurring: head[2] === 'recurring', prompt: rawText.slice(close + 1).trim() };
}
