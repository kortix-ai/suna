import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The panel column is a FILL-AND-SCROLL column, not a scrolling stack.
 *
 * Outputs, Context and Preview used to sit at their natural heights inside one
 * scrolling box, so expanding Outputs to two hundred files pushed the other two
 * below the fold. Now the column owns the height and hands the leftover to
 * exactly one card: Outputs shrinks and scrolls its own rows, Context and
 * Preview stay whole.
 *
 * That behavior is four CSS facts spread over four files, and every one of them
 * is individually deletable by someone tidying up classnames — `min-h-0` in
 * particular reads like noise and is the single thing holding the shrink open.
 * Source assertions because there is no layout to measure in bun's DOM-less
 * runner, and because what is worth pinning is the contract, not a rendered
 * pixel height. Same approach, and same reason, as
 * `session-panel-shortcut.test.ts`.
 */
const read = (name: string) =>
  readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8');

const easyPanel = read('./easy-panel.tsx');
const panelCard = read('./panel-card.tsx');
const outputsCard = read('./outputs-card.tsx');
const contextCard = read('./context-card.tsx');
const appsCard = read('./apps-card.tsx');
const column = read('../../session-action-panel-column.tsx');

/** The `fill` branch's literal class list, with the surrounding prose dropped —
 *  these assertions are about what ships to the browser, and the comments in
 *  this file name the very classes they explain. */
function fillClassList(): string {
  const marker = 'className={cn(fill && ';
  const start = panelCard.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  const open = panelCard.indexOf("'", start);
  return panelCard.slice(open, panelCard.indexOf("'", open + 1) + 1);
}

describe('the column owns a real height to divide', () => {
  // Without a definite height on the container, `h-full` below resolves
  // against nothing, every card falls back to its natural height, and the
  // whole design silently degrades to the stack it replaced.
  test('the panel box stretches instead of sizing to its content', () => {
    expect(column).toContain('self-stretch');
    expect(column).not.toContain('max-h-full min-h-0 overflow-hidden');
  });

  test('the height is handed down to the card column', () => {
    expect(column).toContain('h-full overflow-y-auto');
  });

  test('the card column is a full-height flex column that may shrink', () => {
    expect(easyPanel).toContain('flex h-full min-h-0 flex-col gap-3');
  });
});

describe('exactly one card yields its height', () => {
  test('Outputs is the one that fills — it is the list that grows unbounded', () => {
    expect(outputsCard).toContain('fill');
  });

  test('Context does not fill, so it stays wholly visible', () => {
    expect(contextCard).not.toMatch(/^\s*fill$/m);
  });

  test('Preview does not fill either', () => {
    expect(appsCard).not.toMatch(/^\s*fill$/m);
  });

  // A column where every card can shrink has no anchor and clips all three.
  test('cards are unshrinkable unless they opt in', () => {
    expect(panelCard).toContain("fill ? 'flex min-h-0 flex-col' : 'shrink-0'");
  });
});

describe('shrinking and scrolling arrive together', () => {
  // Shrinking is only safe for a card whose content can scroll what no longer
  // fits. Either half alone reintroduces the clipping this replaced. The card
  // hands DOWN the height; `OutputRows` is what scrolls.
  test('the fill card is a bounded flex parent, not a scroller itself', () => {
    expect(fillClassList()).toContain('flex min-h-0 flex-col');
    expect(fillClassList()).not.toContain('overflow-y-auto');
  });

  test('the bounded chain reaches the animated body', () => {
    expect(outputsCard).toContain('contentClassName="flex min-h-0 flex-col px-2 py-2"');
  });

  test('the rows are the scroll area', () => {
    expect(outputsCard).toContain('<FadedScrollArea');
    expect(outputsCard).toContain('</FadedScrollArea>');
  });

  // `h-full` is FadedScrollArea's default and would resolve against the
  // height-animated body above, which has no definite height of its own.
  test('the scroll area is sized by flex, never by a percentage height', () => {
    expect(outputsCard).toContain('rootClassName="h-auto min-h-0 flex-1"');
  });

  // `flex-1` would make a COLLAPSED card still claim the leftover height and
  // render as an empty rectangle under its own header.
  test('the card body may shrink but never grow', () => {
    // The class list alone — the comment above it explains why `flex-1` is
    // absent, so a substring check over the whole element would match prose.
    expect(fillClassList()).not.toContain('flex-1');
  });

  // A flick past the last file must not scroll the chat transcript behind it.
  test('the scroll does not chain into the chat behind the panel', () => {
    expect(outputsCard).toContain('overscroll-contain');
    expect(column).toContain('overscroll-contain');
  });

  // The fade has to dissolve into the card's own surface. Any other colour
  // draws a visible band across the last row instead of blending with it.
  test('the fade matches the card surface', () => {
    expect(panelCard).toContain('bg-pane');
    expect(outputsCard).toContain('fadeColor="from-pane"');
  });
});

describe('the fill card draws exactly one header divider', () => {
  // The divider lives on the scroll container, so it stays under the header
  // instead of scrolling away with the first row — which means the caller must
  // not also draw one.
  test('the wrapper above the scroll area carries it', () => {
    expect(fillClassList()).toContain('border-t');
  });

  test("Outputs' own content class does not, or the card would draw two", () => {
    const contentClass = outputsCard.slice(
      outputsCard.indexOf('contentClassName="'),
      outputsCard.indexOf('"', outputsCard.indexOf('contentClassName="') + 18) + 1,
    );
    expect(contentClass).not.toContain('border-t');
  });

  // The non-filling cards are unchanged: their divider is still on the body.
  test('a non-filling card keeps the divider on its body', () => {
    expect(panelCard).toContain("contentClassName = 'border-border border-t p-4'");
  });
});
