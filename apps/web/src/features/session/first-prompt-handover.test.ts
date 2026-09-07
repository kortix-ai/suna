import { describe, expect, test } from 'bun:test';

import { resolveFirstPromptHandover, transcriptCarriesFirstPrompt } from './first-prompt-handover';

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

describe('resolveFirstPromptHandover', () => {
  const base = { hasPreview: true, transcriptShowsText: false, transcriptCarriesFiles: false, releasedBefore: false };

  test('the stand-in draws until the transcript shows the text', () => {
    expect(resolveFirstPromptHandover(base)).toEqual({ showStandIn: true, handOverToRealTurn: false, released: false });
  });

  test('the frame the text shows, the stand-in steps aside and the real turn takes over', () => {
    expect(resolveFirstPromptHandover({ ...base, transcriptShowsText: true })).toEqual({
      showStandIn: false,
      handOverToRealTurn: true,
      released: true,
    });
  });

  // The glitch (2026-09-06, on video): the transcript\'s first message loses
  // its parts for ~176 ms while the store swaps in the runtime\'s echo. A live
  // boolean brought the stand-in back at full opacity over the dimmed real
  // turn, then dropped it again — "the same message twice, then it vanishes".
  test('a release is a latch — the stand-in never comes back', () => {
    const out = resolveFirstPromptHandover({ ...base, transcriptShowsText: false, releasedBefore: true });
    expect(out.showStandIn).toBe(false);
    expect(out.handOverToRealTurn).toBe(true);
    expect(out.released).toBe(true);
  });

  test('once the files have landed the real turn needs nothing handed over', () => {
    expect(
      resolveFirstPromptHandover({ ...base, transcriptShowsText: true, transcriptCarriesFiles: true, releasedBefore: true }),
    ).toEqual({ showStandIn: false, handOverToRealTurn: false, released: true });
  });

  test('no preview, nothing to hand over', () => {
    expect(resolveFirstPromptHandover({ ...base, hasPreview: false }).showStandIn).toBe(false);
    expect(resolveFirstPromptHandover({ ...base, hasPreview: false }).handOverToRealTurn).toBe(false);
  });
});
