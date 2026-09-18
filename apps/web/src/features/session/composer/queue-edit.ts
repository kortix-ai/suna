import type { SessionPromptPart } from '@kortix/sdk';
import { cleanPromptText, type QueueRow } from '../queue-projection';

/**
 * Editing a queued message in the composer — the pure half.
 *
 * The row stays in the queue while the composer shows its words. ✓ replaces
 * it: the row is removed and re-queued with the new words, under its own
 * client id and its original send time (`use-queue-edit.ts`). Whatever the
 * composer held before the edit is set aside and comes back afterwards, so
 * opening an edit never costs a draft.
 */

/** Can the composer edit this row? Its words must be all there is (or
 *  this tab must still hold its files), and nothing else may be acting on it. */
export function queueRowEditable(row: QueueRow): boolean {
  return row.state === 'queued' && row.takeBackEligible && !row.pendingAction;
}

/** The row ↑ opens for editing: the LAST editable one, and only from an empty
 *  composer — with text in it, ↑ is an ordinary caret move. */
export function rowForArrowEdit(rows: readonly QueueRow[], composerEmpty: boolean): string | null {
  if (!composerEmpty) return null;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (queueRowEditable(rows[index])) return rows[index].id;
  }
  return null;
}

/**
 * What the composer holds after the edit ends.
 *
 * Saved or cancelled: the stash — whatever the composer held when the edit
 * began — exactly. Refused (the message went out with its old words while it
 * was being edited, or its re-queue failed): the edited words stay too, ABOVE the stash, so neither is
 * lost. Generic over the stash so the composer can hand back its own document
 * and files untouched.
 */
export function planQueueEditExit<Stash>(input: {
  outcome: 'saved' | 'cancelled' | 'refused';
  stash: Stash;
  editedText: string;
}): { stash: Stash; above: string | null } {
  const keep = input.outcome === 'refused' && input.editedText.trim() ? input.editedText : null;
  return { stash: input.stash, above: keep };
}

/**
 * The wire text an in-place save sends.
 *
 * The composer shows a queued prompt's VISIBLE words (`cleanPromptText`). The
 * wire text around them — a reply context before, reference blocks after — is
 * not the user's to retype, so the edit replaces the visible words and keeps
 * the rest. When the visible words cannot be found verbatim, the edit is the
 * whole text.
 */
export function rebuildEditedPromptText(original: string, edited: string): string {
  const visible = cleanPromptText(original).text;
  // The visible words follow the reply context, so the search starts after it
  // — the quoted text can contain the same words.
  const REPLY_END = '</reply_context>';
  const replyEnd = original.indexOf(REPLY_END);
  const from = replyEnd < 0 ? 0 : replyEnd + REPLY_END.length;
  const at = visible ? original.indexOf(visible, from) : -1;
  if (at < 0) return edited;
  return `${original.slice(0, at)}${edited}${original.slice(at + visible.length)}`;
}

/**
 * The parts an edited message is re-queued with: the first text part takes the
 * new words, any other text parts go, and file and agent parts stay where they
 * were.
 */
export function withEditedText(
  parts: readonly SessionPromptPart[],
  text: string,
): SessionPromptPart[] {
  const next: SessionPromptPart[] = [];
  let placed = false;
  for (const part of parts) {
    if (part.type !== 'text') next.push(part);
    else if (!placed) {
      next.push({ ...part, text });
      placed = true;
    }
  }
  if (!placed) next.unshift({ type: 'text', text });
  return next;
}
