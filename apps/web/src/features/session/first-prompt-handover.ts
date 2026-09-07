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

/**
 * The whole first-prompt handover, as one decision.
 *
 * The stand-in steps aside the frame the transcript shows the prompt's text —
 * and then it STAYS aside. It used to be a live boolean, and the transcript's
 * first message briefly has no parts while the store swaps the optimistic copy
 * for the runtime's echo (measured 2026-09-06: ~176 ms as the file parts
 * landed). For those frames the text was gone, the stand-in re-mounted at full
 * opacity over the dimmed real turn, and the real turn drew nothing: the
 * message flashed bright, then blank. A release is a latch.
 *
 * After release the REAL turn owns the prompt, and is handed everything the
 * stand-in knew — text and file names — so it keeps drawing the bubble and the
 * pending tiles through any frame where its own parts are still streaming.
 */
export interface FirstPromptHandoverInput {
  /** The producer's copy exists (the boot preview store has this session). */
  hasPreview: boolean;
  /** The transcript's first user message carries its text right now. */
  transcriptShowsText: boolean;
  /** …and the attachments the preview promised. */
  transcriptCarriesFiles: boolean;
  /** The stand-in already stepped aside on an earlier frame. */
  releasedBefore: boolean;
}

export interface FirstPromptHandover {
  /** Draw the stand-in bubble. */
  showStandIn: boolean;
  /** Hand the preview's text + file names to the real first turn. */
  handOverToRealTurn: boolean;
  /** The latch value to keep for the next frame. */
  released: boolean;
}

export function resolveFirstPromptHandover(input: FirstPromptHandoverInput): FirstPromptHandover {
  if (!input.hasPreview) return { showStandIn: false, handOverToRealTurn: false, released: true };
  const released = input.releasedBefore || input.transcriptShowsText;
  return {
    showStandIn: !released,
    handOverToRealTurn: released && !input.transcriptCarriesFiles,
    released,
  };
}
