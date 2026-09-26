/**
 * Does `<markdown>` drop the text of an ordered list inside a scrolled
 * `<scrollbox>`? No. This script is the proof, and the record of what the
 * reported symptom really was.
 *
 *   bun run apps/tui/scripts/repro-markdown-list.tsx [width]
 *
 * ── The report ──
 * Wave 3 read a live transcript frame whose left column held `1`, `2`, … `17`
 * on rows of their own with no item text, directly above a `MessageAbortedError`
 * banner, and filed it as "`<markdown>` renders an ordered list's numbers
 * without their text".
 *
 * ── What it actually was ──
 * The literal content of the reply. The turn above it, in the live warm session
 * `1124e1b1-9e3d-481f-a028-7713a42bdfb7`, is the user prompt
 * "Count slowly from 1 to 40, one number per line." — and the assistant's reply
 * is the 41 characters `1\n2\n…\n17`, cut off at 17 because the turn was
 * aborted. Bare numbers on their own lines, rendered as bare numbers on their
 * own rows. There was never a list marker on screen.
 *
 * ── The one real finding ──
 * `<markdown>` keeps a HARD line break where CommonMark folds one. `1\n2\n3` is
 * a single paragraph "1 2 3" to a CommonMark renderer; OpenTUI 0.5.11 gives it
 * three rows. That is why the count looked like a list in the first place, and
 * it is the behavior a transcript wants — an agent that writes one item per
 * line means one row per line. See `docs/opentui-notes.md`.
 *
 * Every case below runs at the transcript's own nesting (scrollbox → per-turn
 * column box → markdown with an explicit width) and at three scroll offsets.
 * The script exits non-zero if any list item's text goes missing.
 */

import type { ScrollBoxRenderable } from '@opentui/core';
import { SyntaxStyle } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import { createRoot } from '@opentui/react';
import { useEffect, useRef } from 'react';

const WIDTH = Number(process.argv[2] ?? 60);
const HEIGHT = 16;
const ITEMS = 15;

/** The shape that was reported broken: a long ordered list, then more text. */
const ORDERED_LIST = [
  'Here is what I can do:',
  '',
  ...Array.from({ length: ITEMS }, (_, i) => `${i + 1}. Item number ${i + 1} with words after it`),
  '',
  'That is the list.',
].join('\n');

/** The shape that was actually on screen: bare numbers, one per line. */
const BARE_NUMBERS = Array.from({ length: 17 }, (_, i) => String(i + 1)).join('\n');

const style = SyntaxStyle.create();

/** The transcript's own nesting — `transcript.tsx` → `turn.tsx` → `text-part.tsx`. */
function Repro({
  content,
  scrollTop,
  markdownWidth,
  streaming,
}: {
  content: string;
  scrollTop: number;
  markdownWidth: number | undefined;
  streaming: boolean;
}) {
  const ref = useRef<ScrollBoxRenderable | null>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = scrollTop;
  }, [scrollTop]);
  const inner = Math.max(WIDTH - 2, 12);
  return (
    <box flexDirection="column" width={WIDTH} height={HEIGHT} overflow="hidden">
      <scrollbox
        ref={ref}
        flexGrow={1}
        stickyScroll
        stickyStart="bottom"
        contentOptions={{ flexDirection: 'column' }}
      >
        <box flexDirection="column" marginBottom={1}>
          <box flexDirection="column" width={inner}>
            <text>◆ agent · now</text>
            <markdown
              content={content}
              syntaxStyle={style}
              streaming={streaming}
              {...(markdownWidth === undefined ? {} : { width: markdownWidth })}
            />
          </box>
        </box>
      </scrollbox>
    </box>
  );
}

const setup = await createTestRenderer({ width: WIDTH, height: HEIGHT });
const root = createRoot(setup.renderer);

/** `<markdown>` parses asynchronously; a frame captured before it settles is
 *  blank. 900 ms is well past the 600 ms the transcript's own tests use. */
async function settle(ms: number): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    await setup.renderOnce();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** One captured row without its padding or the scrollbar glyph on the right. */
function stripChrome(row: string): string {
  return row.replace(/[█▄▀░▌▐]+\s*$/, '').trim();
}

let failures = 0;

for (const streaming of [false, true]) {
  for (const markdownWidth of [Math.max(WIDTH - 2, 12), undefined]) {
    for (const scrollTop of [0, 5, 40]) {
      root.render(
        <Repro
          content={ORDERED_LIST}
          scrollTop={scrollTop}
          markdownWidth={markdownWidth}
          streaming={streaming}
        />,
      );
      await settle(900);
      const frame = setup.captureCharFrame();
      const label = `ordered list · streaming=${streaming} width=${markdownWidth ?? '(none)'} scrollTop=${scrollTop}`;
      // Every marker that is on screen must carry its item text. A row of "12"
      // with nothing after it is the reported symptom.
      const orphan = frame
        .split('\n')
        .map(stripChrome)
        .find((row) => /^\d+\.$/.test(row));
      if (orphan === undefined) {
        console.log(`  ok · ${label}`);
      } else {
        failures += 1;
        console.log(`  FAIL · ${label} — a marker row carries no text: ${JSON.stringify(orphan)}`);
        console.log(frame);
      }
    }
  }
}

// The hard-line-break finding, asserted rather than described.
root.render(
  <Repro content={BARE_NUMBERS} scrollTop={0} markdownWidth={WIDTH - 2} streaming={false} />,
);
await settle(900);
const numbersFrame = setup.captureCharFrame();
const numberRows = numbersFrame
  .split('\n')
  .map(stripChrome)
  .filter((row) => /^\d+$/.test(row))
  .map(Number);
// The viewport is HEIGHT rows, so it holds the TAIL of the 17. Consecutive and
// ascending is the claim: one hard line break per row, nothing folded.
const consecutive =
  numberRows.length >= 12 &&
  numberRows.every((n, i) => i === 0 || n === (numberRows[i - 1] as number) + 1);
if (consecutive && numberRows.at(-1) === 17) {
  console.log(
    `  ok · bare numbers keep one hard line break per row (${numberRows.length} rows visible, ` +
      `${numberRows[0]}…17 — CommonMark would fold all 17 into one paragraph)`,
  );
} else {
  failures += 1;
  console.log(
    `  FAIL · expected consecutive bare-number rows ending at 17, got ${numberRows.join(',')}`,
  );
  console.log(numbersFrame);
}

console.log(failures === 0 ? '\nPASS — no orphan list markers' : `\nFAILED — ${failures} case(s)`);
root.unmount();
setup.renderer.destroy();
process.exit(failures === 0 ? 0 : 1);
