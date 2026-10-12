/**
 * Pins the moved above-card stack after KRTX-373 phase 1 split it out of
 * `composer.tsx` into `ComposerAboveCard.tsx`.
 *
 * No other suite renders this subtree: `quote-list.test.tsx` renders the list
 * itself, `composer-input-slot.test.tsx` renders notices into the slot class
 * directly, and nothing rendered the WRAPPER structure around them — the
 * width-based rounding stack (`queue strip` narrower than the full-width
 * notice) and the in-flow `'above'` dock anchor. The assertions are on the
 * RENDERED MARKUP, never on source text, with the same
 * `renderToStaticMarkup` shell `composer-underbar.test.tsx` uses.
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { COMPOSER_INPUT_SLOT_CLASS, COMPOSER_SHELL_CLASS } from './composer';
import { ComposerAboveCard } from './ComposerAboveCard';
import type { ComputerAwakeLine } from './computer-awake';

const noop = () => {};

const labels = { count: '2 quotes', expand: 'Expand', collapse: 'Collapse', remove: 'Remove' };
const quote = {
  id: 'q1',
  text: 'the passage to reply to',
  source: 'transcript',
} as never;

function render(props?: {
  notice?: string | null;
  onNoticeRetry?: () => void;
  inputSlot?: React.ReactNode;
  quotes?: unknown[];
  computerAwake?: ComputerAwakeLine | null;
  servedModel?: { served: string; fallbackFrom: string } | null;
  questionActive?: boolean;
}): string {
  return renderToStaticMarkup(
    <ComposerAboveCard
      dockId="composer-slash-dock-test"
      quotes={(props?.quotes ?? []) as never}
      quoteListLabels={labels}
      handleRemoveQuote={noop}
      notice={props?.notice ?? null}
      onNoticeRetry={props?.onNoticeRetry}
      inputSlot={props?.inputSlot}
      computerAwake={props?.computerAwake ?? null}
      servedModel={(props?.servedModel ?? null) as never}
      onModelChange={props?.servedModel ? noop : undefined}
      questionActive={props?.questionActive ?? false}
      slashMenuPlacement="above"
      sessionId="ses_test"
      onSend={async () => {}}
    />,
  );
}

describe('ComposerAboveCard (the moved above-card stack)', () => {
  test("the 'above' dock anchor renders in flow, first in the stack", () => {
    const html = render();
    expect(html).toContain('id="composer-slash-dock-test"');
    // The anchor precedes everything else the component renders.
    expect(html.indexOf('id="composer-slash-dock-test"')).toBeLessThan(
      html.indexOf('mb-2 w-full empty:hidden'),
    );
  });

  test('the quote card carries the empty:hidden wrapper and its labels', () => {
    const html = render({ quotes: [quote] });
    expect(html).toContain('mb-2 w-full empty:hidden');
    expect(html).toContain('the passage to reply to');
    expect(html).toContain('2 quotes');
  });

  test('the queue strip mounts inputSlot inside the slot class only while it has content', () => {
    const withSlot = render({ inputSlot: <div data-testid="queued">queued row</div> });
    expect(withSlot).toContain(COMPOSER_INPUT_SLOT_CLASS);
    expect(withSlot).toContain('queued row');

    const withoutSlot = render();
    expect(withoutSlot).not.toContain(COMPOSER_INPUT_SLOT_CLASS);
  });

  test('the notice bar renders as a polite status with a Retry wired to onNoticeRetry', () => {
    const html = render({ notice: 'waking', onNoticeRetry: noop });
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('waking');
    expect(html).toContain('>Retry<');
  });

  // KRTX-1729: the "computer stays on" strip.
  test('the computer-awake strip renders above the card, rounded on top', () => {
    const html = render({ computerAwake: { kind: 'stays', minutes: 25 } });
    expect(html).toContain('data-testid="computer-awake-bar"');
    expect(html).toContain('up to 25 min');
    expect(html).toMatch(/data-testid="computer-awake-bar" class="[^"]*rounded-t-xl/);
  });

  test('a waking notice outranks the computer-awake strip', () => {
    const html = render({ notice: 'waking', computerAwake: { kind: 'stays', minutes: 25 } });
    expect(html).toContain('waking');
    expect(html).not.toContain('computer-awake-bar');
  });

  // A docked question and the card are one surface; a strip between them
  // broke the seam. A question left open on an idle session is exactly when
  // the strip would show.
  test('a docked question hides the computer-awake strip', () => {
    const html = render({
      questionActive: true,
      inputSlot: <div>question</div>,
      computerAwake: { kind: 'stays', minutes: 25 },
    });
    expect(html).toContain('question');
    expect(html).not.toContain('computer-awake-bar');
  });

  test('the served-model strip under the computer-awake strip stays square and shares its divider', () => {
    const html = render({
      computerAwake: { kind: 'stops', minutes: 9 },
      servedModel: { served: 'Model B', fallbackFrom: 'Model A' },
    });
    expect(html.indexOf('computer-awake-bar')).toBeLessThan(html.indexOf('served-model-bar'));
    expect(html).toMatch(/data-testid="served-model-bar" class="(?![^"]*rounded-t-xl)[^"]*"/);
  });

  test('with nothing to show, the stack block is absent entirely', () => {
    const html = render();
    expect(html).not.toContain('role="status"');
    // And the shell class it will be mounted into is not part of this subtree.
    expect(html).not.toContain(COMPOSER_SHELL_CLASS);
  });
});
