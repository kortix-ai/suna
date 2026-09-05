import { parseFileReferences } from './message-parsing';

/**
 * When the transcript's own copy of the first prompt is complete enough for the
 * boot preview to step aside.
 *
 * "The transcript has it" used to mean a user message WITH TEXT on screen. But
 * the runtime streams a message's parts, and it streams the text part FIRST:
 * measured in a real browser on 2026-09-04, the file parts followed ~6 s later.
 * Releasing on text alone therefore swapped a bubble with three tiles and an
 * "Uploading 3 files…" line for a bubble with nothing under it — the exact
 * frame Jay screenshotted as "prompt only, no attachments" — and the tiles
 * only came back when the last part landed.
 *
 * So the preview is released when the transcript carries the text AND at
 * least as many attachments as the preview promised. Attachments arrive two
 * ways and both count: a model-native file as a `file` part, a materialized
 * one as a `<file …>` reference the API folded into a text part.
 *
 * Bounded: an ANSWERED turn releases unconditionally. Nothing more is streaming
 * then, and a file that never showed is never going to — holding on would pin
 * a stale bubble over a finished turn.
 */
interface PartLike {
  type: string;
  text?: string;
  synthetic?: boolean;
}

interface TurnLike {
  userMessage: { parts: readonly PartLike[] };
  assistantMessages: readonly unknown[];
}

function messageAttachmentCount(parts: readonly PartLike[]): number {
  let count = 0;
  for (const part of parts) {
    if (part.type === 'file') count += 1;
    else if (part.type === 'text' && part.text) count += parseFileReferences(part.text).files.length;
  }
  return count;
}

export function transcriptCarriesFirstPrompt(
  turns: readonly TurnLike[],
  expectedAttachments: number,
): boolean {
  return turns.some((turn) => {
    const parts = turn.userMessage.parts;
    const hasText = parts.some(
      (part) => part.type === 'text' && !!part.text?.trim() && !part.synthetic,
    );
    if (!hasText) return false;
    if (expectedAttachments <= 0) return true;
    if (turn.assistantMessages.length > 0) return true;
    return messageAttachmentCount(parts) >= expectedAttachments;
  });
}
