import { describe, expect, test } from 'bun:test';

import { transcriptCarriesFirstPrompt } from './first-prompt-handover';

const text = (t: string) => ({ type: 'text', text: t });
const file = (name: string) => ({ type: 'file', mime: 'image/png', filename: name, url: 'data:x' });
const ref = (name: string) =>
  text(`<file path="/workspace/uploads/x/${name}" mime="application/zip" filename="${name}">u</file>`);
type Part = { type: string; text?: string; synthetic?: boolean };
const turn = (parts: Part[], answered = false) => ({
  userMessage: { parts },
  assistantMessages: answered ? [{ parts: [text('hi')] }] : [],
});

describe('transcriptCarriesFirstPrompt', () => {
  test('a text-only prompt is carried the moment its text shows', () => {
    expect(transcriptCarriesFirstPrompt([turn([text('YO BRO')])], 0)).toBe(true);
  });

  test('an info frame with no text is not carried yet', () => {
    expect(transcriptCarriesFirstPrompt([turn([text('  ')])], 0)).toBe(false);
    expect(transcriptCarriesFirstPrompt([], 0)).toBe(false);
  });

  // The 2026-09-04 blackout, measured in a real browser: the runtime streams
  // the TEXT part first and the file parts ~6 s later. Releasing the preview
  // on text alone left the bubble with no tiles for those seconds — the exact
  // frame Jay screenshotted ("prompt only, no attachments").
  test('a prompt that promised files is NOT carried until the files show', () => {
    expect(transcriptCarriesFirstPrompt([turn([text('YO BRO')])], 3)).toBe(false);
    expect(transcriptCarriesFirstPrompt([turn([text('YO BRO'), file('a.png')])], 3)).toBe(false);
    expect(
      transcriptCarriesFirstPrompt([turn([text('YO BRO'), file('a.png'), file('b.png'), file('c.png')])], 3),
    ).toBe(true);
  });

  // A materialized file arrives as a `<file …>` ref folded into a text part,
  // not as a file part. Both count, or a zip beside a photo waits forever.
  test('counts materialized <file> refs as attachments', () => {
    expect(
      transcriptCarriesFirstPrompt([turn([text('look'), ref('bundle.zip'), file('shot.png')])], 2),
    ).toBe(true);
  });

  // If the turn has already been ANSWERED, nothing more is streaming — a file
  // that never showed is never going to. Holding the preview then would pin a
  // stale bubble over a finished turn.
  test('releases once the turn is answered, even short of the promise', () => {
    expect(transcriptCarriesFirstPrompt([turn([text('x'), file('a.png')], true)], 3)).toBe(true);
  });
});
