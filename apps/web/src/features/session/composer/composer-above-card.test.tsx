/**
 * Pins the moved above-card stack after KRTX-373 phase 1 split it out of
 * `composer.tsx` into `ComposerAboveCard.tsx`.
 *
 * No other suite renders this subtree: `quote-list.test.tsx` renders the list
 * itself, `composer-input-slot.test.tsx` renders notices into the slot class
 * directly, and nothing rendered the WRAPPER structure around them — the
 * rounding stack (every layer full width, square under a visible strip) and
 * the in-flow `'above'` dock anchor. The assertions are on the
 * RENDERED MARKUP, never on source text, with the same
 * `renderToStaticMarkup` shell `composer-underbar.test.tsx` uses.
 */
import { describe, expect, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';

import messages from '../../../../translations/en.json';

import { COMPOSER_INPUT_SLOT_CLASS, COMPOSER_SHELL_CLASS } from './composer';
import { ComposerAboveCard } from './ComposerAboveCard';

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
  questionActive?: boolean;
}): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={messages}>
      <ComposerAboveCard
        dockId="composer-slash-dock-test"
        quotes={(props?.quotes ?? []) as never}
        quoteListLabels={labels}
        handleRemoveQuote={noop}
        notice={props?.notice ?? null}
        onNoticeRetry={props?.onNoticeRetry}
        inputSlot={props?.inputSlot}
        questionActive={props?.questionActive}
        slashMenuPlacement="above"
        sessionId="ses_test"
        onSend={async () => {}}
      />
    </NextIntlClientProvider>,
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

  test('with nothing to show, the stack block is absent entirely', () => {
    const html = render();
    expect(html).not.toContain('role="status"');
    // And the shell class it will be mounted into is not part of this subtree.
    expect(html).not.toContain(COMPOSER_SHELL_CLASS);
  });
});

/** The class list of the first element with `marker` in its attributes. */
function classOf(html: string, marker: string): string {
  const tag = html.slice(0, html.indexOf(marker)).lastIndexOf('<');
  return /class="([^"]*)"/.exec(html.slice(tag))?.[1] ?? '';
}

const NOTICE = 'role="status" aria-live="polite" class=';
const SERVED = 'data-testid="served-model-bar"';
const question = <div>question</div>;

// A bar under a full-width layer is a middle layer: square top, side ring
// only. A rounded top there cut notches into the docked question.
describe('ComposerAboveCard stack corners', () => {
  test('alone, the notice rounds its top and carries no ring', () => {
    expect(classOf(render({ notice: 'waking' }), NOTICE)).toContain('rounded-t-xl');
    expect(classOf(render({ notice: 'waking' }), NOTICE)).not.toContain('ring-3');
  });

  test('under a docked question, the notice is square with the side ring', () => {
    const cls = classOf(
      render({ notice: 'waking', inputSlot: question, questionActive: true }),
      NOTICE,
    );
    expect(cls).toContain('rounded-t-none');
    expect(cls).not.toContain('rounded-t-xl');
    expect(cls).toContain('ring-3 [clip-path:inset(0_-8px_0_-8px)]');
  });

  // KRTX-2685: the chat input is not the error surface for model switches —
  // the served-model strip (#8759, incident 2026-10-02) moved to the turn footer.
  test('no served-model strip renders at the composer', () => {
    expect(render({ notice: 'waking', inputSlot: question })).not.toContain(SERVED);
  });

  test('the strip is always full width: a narrower strip exposes the corners under it', () => {
    expect(COMPOSER_INPUT_SLOT_CLASS).toContain('w-full');
    expect(COMPOSER_INPUT_SLOT_CLASS).not.toMatch(/\bw-\[|\bw-\d|max-w-/);
  });

  test('a visible strip squares every layer under it (CSS: the strip may be empty)', () => {
    const html = render({ notice: 'waking', inputSlot: question });
    expect(html).toContain('data-composer-strip="true"');
    expect(classOf(html, 'data-composer-stack="true"')).toContain(
      '[&amp;&gt;[data-composer-strip]:not(:empty)~*]:rounded-t-none',
    );
  });
});
