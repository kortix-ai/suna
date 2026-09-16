'use client';

/**
 * The status word under a user bubble the agent has not reached yet.
 *
 * Queued ENTRIES are not drawn in the transcript: they are listed above the
 * composer (`composer/queued-prompt-list.tsx`) and enter the transcript when
 * the agent reaches them. What remains here is the transcript's own pending
 * state — an idle send the server is about to admit, or a message a Stop
 * stranded before a step opened under it.
 */

import { InlineMeta } from '@/components/ui/inline-meta';

/** The dim a pending bubble sits at. One number, so every pending surface agrees. */
export const QUEUED_BUBBLE_OPACITY_CLASS = 'opacity-50';

/** `interrupted`: the runtime holds the message but a Stop ended the turn
 *  before a step opened under it — it runs with the next send. */
export type QueuedPromptState = 'queued' | 'interrupted';

export function queuedPromptStatusLabel(state: QueuedPromptState): string {
  return state === 'interrupted' ? 'Queued — runs with your next message' : 'Queued';
}

/**
 * A plainly pending bubble says nothing: the dim IS the state, and a caption
 * under every pending message read as clutter. An interrupted one needs the
 * words to be understood.
 */
export function QueuedPromptStatus({ state }: { state: QueuedPromptState }) {
  if (state === 'queued') return null;
  return (
    <InlineMeta>
      <span data-queued-status={state} className="flex items-center gap-1">
        {queuedPromptStatusLabel(state)}
      </span>
    </InlineMeta>
  );
}
