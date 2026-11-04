/**
 * The run line on a chat approval card (Slack, Teams) for an approved held
 * call. Status only: a card never shows the run's output.
 */

/** Where the run is. `content_changed`: refused because the content changed
 *  after approval, and a new approval waits. */
export type HeldRunCardState = 'running' | 'ok' | 'error' | 'refused' | 'unknown' | 'content_changed';

export const HELD_RUN_CARD_TEXT: Record<HeldRunCardState, string> = {
  running: 'Running…',
  ok: 'Ran once.',
  error: 'Ran, but failed.',
  refused: 'Not run: Kortix refused it at run time.',
  unknown: 'It may have run. Check before you repeat it.',
  content_changed: 'Not run: the content changed after approval. A new approval is waiting.',
};
