import type { SessionLogBlock, SessionLogTurn } from '@kortix/sdk';
import { splitPastedContent } from '@kortix/shared';

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
 * ways and both count: a model-native file as an attachment block (or a
 * harness `file` block, a text/plain or directory mention), a materialized
 * one as a `<file …>` reference the API folded into a text block.
 *
 * Bounded: an ANSWERED turn releases unconditionally. Nothing more is streaming
 * then, and a file that never showed is never going to — holding on would pin
 * a stale bubble over a finished turn.
 */
/**
 * The text of a block that was a v1 text part: a text block, or an ignored
 * text part (a harness `text` block, its data the v1 part).
 */
function textOf(block: SessionLogBlock): { text?: string; synthetic?: boolean } | undefined {
  if (block.type === 'text') return block;
  if (block.type === 'harness' && block.kind === 'text') return block.data as { text?: string; synthetic?: boolean };
  return undefined;
}

function messageAttachmentCount(blocks: readonly SessionLogBlock[]): number {
  let count = 0;
  for (const block of blocks) {
    if (block.type === 'attachment' || (block.type === 'harness' && block.kind === 'file')) count += 1;
    // A `<file>` inside a paste is paste text, not an attachment.
    else {
      const text = textOf(block)?.text;
      if (typeof text === 'string' && text)
        count += parseFileReferences(splitPastedContent(text).text).files.length;
    }
  }
  return count;
}

export function transcriptCarriesFirstPrompt(
  turns: readonly Pick<SessionLogTurn, 'user' | 'assistant'>[],
  expectedAttachments: number,
): boolean {
  return turns.some((turn) => {
    const blocks = turn.user.blocks;
    // Ignored text counts, as it did for the v1 part: only `synthetic` text is not the prompt's.
    const hasText = blocks.some((block) => {
      const part = textOf(block);
      return typeof part?.text === 'string' && !!part.text.trim() && !part.synthetic;
    });
    if (!hasText) return false;
    if (expectedAttachments <= 0) return true;
    if (turn.assistant.length > 0) return true;
    return messageAttachmentCount(blocks) >= expectedAttachments;
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
interface FirstPromptHandoverInput {
  /** The producer's copy exists (the boot preview store has this session). */
  hasPreview: boolean;
  /** The transcript's first user message carries its text right now. */
  transcriptShowsText: boolean;
  /** …and the attachments the preview promised. */
  transcriptCarriesFiles: boolean;
  /** The stand-in already stepped aside on an earlier frame. */
  releasedBefore: boolean;
  /**
   * The transcript has NO turns at all right now.
   *
   * The latch below is what a release means, and it is right for the frames it
   * was written for: the message is on screen and briefly loses its parts, so a
   * turn still exists and the real turn owns the prompt. It is wrong for the
   * one frame where the message is not on screen at all — between the server
   * taking the prompt off the queue (its synthetic bubble goes with the row)
   * and the runtime echoing it. The transcript is then empty, the latch says
   * "the real turn has this", and nothing draws anything: the whole thread
   * blanks with Stop still showing (dev, 2026-09-06, on video).
   *
   * Safe against the glitch the latch exists for: a user message with zero
   * parts is still a turn, so an emptied bubble leaves this false.
   *
   * Optional — a caller that does not track it keeps the pure latch.
   */
  transcriptEmpty?: boolean;
}

interface FirstPromptHandover {
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
    // A release is a latch, EXCEPT over an empty transcript: there is no real
    // turn to have handed the prompt to. See `transcriptEmpty`.
    showStandIn: !released || !!input.transcriptEmpty,
    handOverToRealTurn: released && !input.transcriptCarriesFiles,
    released,
  };
}
