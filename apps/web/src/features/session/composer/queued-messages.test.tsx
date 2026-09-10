import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { TooltipProvider } from '@/components/ui/tooltip';
import en from '../../../../translations/en.json';
import { QUEUE_FULL_HINT_KEY, QUEUE_MAX_DEPTH } from './queue-gates';
import { QueuedMessages, type QueuedMessagesProps } from './queued-messages';

/**
 * The queue list's chrome, asserted on RENDERED MARKUP.
 *
 * Everything here is a claim about what the user sees — a header that names
 * the hold, a number per row, one "Runs next" marker — and every one of them
 * was previously provable only by reading the JSX. Source-text assertions
 * cannot fail once the string moves, which is the whole reason these render.
 *
 * `renderToStaticMarkup`, same shell as `composer-toolbar.test.tsx`. Radix
 * menu CONTENT is not in this markup (it mounts on open), so the two new
 * dropdown items are covered by `canMoveToTop` in the logic tests instead.
 */

const noop = () => {};

/**
 * The list renders CATALOG keys now — the words live in
 * `hardcodedUi.i18nComplete` because it ships in nine locales. Without a
 * provider `useTranslations` falls back to English (`i18n/use-translations.ts`),
 * so these assertions still read as sentences; resolving the constant through
 * the catalog is what keeps the cap hint pinned to its real wording.
 */
const CATALOG = en.hardcodedUi.i18nComplete as Record<string, string>;
const QUEUE_FULL_HINT = CATALOG[QUEUE_FULL_HINT_KEY];

function render(props: Partial<QueuedMessagesProps>): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <QueuedMessages messages={[]} {...props} />
    </TooltipProvider>,
  );
}

function rows(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `m${index + 1}`,
    text: `message ${index + 1}`,
  }));
}

describe('header', () => {
  test('names the depth and what the queue is waiting for', () => {
    const html = render({ messages: rows(2), runState: 'running' });
    expect(html).toContain('2 queued · runs after this turn');
  });

  test('a paused queue says paused, not the run state underneath', () => {
    // Stop can leave the run in `error`. The user who just pressed Stop needs
    // "paused", not "last run failed".
    const html = render({ messages: rows(2), runState: 'error', paused: true });
    expect(html).toContain('2 queued · paused');
    expect(html).not.toContain('last run failed');
  });

  test('offers Resume for a held queue when the host wired one', () => {
    const html = render({ messages: rows(2), paused: true, onResume: noop });
    expect(html).toContain('Resume');
  });

  test('offers Retry after a failed run', () => {
    const html = render({ messages: rows(2), runState: 'error', onRetryQueue: noop });
    expect(html).toContain('Retry');
  });

  test('renders no action button when the host wired no handler', () => {
    // A Resume that does nothing is worse than none: the user stops looking
    // for the real way out.
    const html = render({ messages: rows(2), paused: true });
    expect(html).not.toContain('Resume');
  });

  test('says the queue is full at the cap', () => {
    const html = render({ messages: rows(QUEUE_MAX_DEPTH) });
    expect(html).toContain(QUEUE_FULL_HINT);
  });

  test('says nothing about the cap below it', () => {
    const html = render({ messages: rows(2) });
    expect(html).not.toContain(QUEUE_FULL_HINT);
  });
});

describe('collapse', () => {
  test('a deep queue opens collapsed, header only', () => {
    const html = render({ messages: rows(6) });
    expect(html).toContain('6 queued');
    expect(html).not.toContain('message 1');
  });

  test('a short queue opens with its rows visible', () => {
    const html = render({ messages: rows(3) });
    expect(html).toContain('message 1');
    expect(html).toContain('message 3');
  });

  test('a failed row shows even under a collapsed queue', () => {
    // A failure hidden behind a collapse is a message the user believes sent.
    const html = render({
      messages: rows(6),
      failed: [{ id: 'f1', text: 'this one broke' }],
    });
    expect(html).not.toContain('message 1');
    expect(html).toContain('this one broke');
  });
});

describe('positions and markers', () => {
  test('numbers every row from 1, in the order shown', () => {
    const html = render({ messages: rows(3) });
    expect(html).toContain('Position 1');
    expect(html).toContain('Position 2');
    expect(html).toContain('Position 3');
  });

  test('marks exactly one row as the one that runs next', () => {
    const html = render({ messages: rows(3) });
    expect(html.match(/Runs next/g)).toHaveLength(1);
  });

  test('the row on the wire is not the one that runs next', () => {
    const html = render({ messages: rows(3), inFlightIds: ['m1'] });
    // The marker sits with row 2's position, not row 1's.
    expect(html.indexOf('Runs next')).toBeGreaterThan(html.indexOf('Position 2'));
    expect(html.indexOf('Runs next')).toBeLessThan(html.indexOf('Position 3'));
  });

  test('nothing runs next while the queue is held', () => {
    // The header says "paused". A row saying "Runs next" under it says the
    // opposite about the same queue.
    const html = render({ messages: rows(3), paused: true });
    expect(html).toContain('3 queued · paused');
    expect(html).not.toContain('Runs next');
  });

  test('the marker comes back once the hold is released', () => {
    const html = render({ messages: rows(3), paused: false });
    expect(html.match(/Runs next/g)).toHaveLength(1);
  });

  test('a parked row is pinned, counted, and never runs next', () => {
    const html = render({
      messages: [
        { id: 'm1', text: 'held one', parked: true },
        { id: 'm2', text: 'message 2' },
      ],
    });
    expect(html).toContain('Parked, position 1');
    expect(html).toContain('Position 2');
    // One marker, and it is on the row that is not parked.
    expect(html.match(/Runs next/g)).toHaveLength(1);
    expect(html.indexOf('Runs next')).toBeGreaterThan(html.indexOf('Position 2'));
  });

  test('marks no row when every row is parked', () => {
    const html = render({
      messages: [
        { id: 'm1', text: 'a', parked: true },
        { id: 'm2', text: 'b', parked: true },
      ],
    });
    expect(html).not.toContain('Runs next');
  });
});

describe('live region', () => {
  test('the queue speaks through one polite region per fact', () => {
    // Two regions updated in the same frame race; the move/queue announcement
    // shares one region on purpose.
    const html = render({ messages: rows(2) });
    expect(html.match(/aria-live="polite"/g)).toHaveLength(2);
  });
});

describe('the spoken queue and the seen queue agree', () => {
  test('a failed run says the same thing in both places', () => {
    // The sr-only summary used to have wording of its own, written before this
    // list knew about `runState`: it said "all send when this turn ends" while
    // the header said the run had failed. Both read `queueHeaderLabel` now, so
    // the string appears twice and never differs.
    const html = render({ messages: rows(2), runState: 'error' });
    expect(html.match(/2 queued · last run failed/g)).toHaveLength(2);
  });

  test('a queue waiting on approval says so to both', () => {
    const html = render({ messages: rows(2), runState: 'awaiting_input' });
    expect(html.match(/2 queued · waiting on your approval/g)).toHaveLength(2);
  });

  test('a held queue says paused to both', () => {
    const html = render({ messages: rows(2), runState: 'error', paused: true });
    expect(html.match(/2 queued · paused/g)).toHaveLength(2);
    expect(html).not.toContain('all send when this turn ends');
  });
});

/**
 * NOT ONE CATALOG ID ON SCREEN.
 *
 * Every string in this list is `t.raw('text…')` or `t('text…', values)` now.
 * A key that is missing from the catalog resolves to its own id, and next-intl
 * returns it without throwing — so the failure mode is a row that reads
 * `texte26d39e7b323` where "Runs next" belongs. That has shipped in this app
 * before (the i18nComplete re-key pass), and no type or lint rule catches it.
 */
describe('every rendered string resolves', () => {
  const KEY_ID = /text[0-9a-f]{12}/;

  test('the full list, every state, renders no raw key id', () => {
    for (const runState of ['idle', 'running', 'awaiting_input', 'error'] as const) {
      for (const paused of [true, false]) {
        const html = render({
          messages: [
            { id: 'm1', text: 'first', parked: true },
            { id: 'm2', text: 'second' },
            { id: 'm3', text: 'third', attachmentCount: 2 },
          ],
          failed: [{ id: 'f1', text: 'broken', lastError: 'delivery outcome: failed' }],
          runState,
          paused,
          isRunning: runState === 'running',
          onRemove: noop,
          onEdit: noop,
          onSendNow: noop,
          onDuplicate: noop,
          onMoveToTop: noop,
          onRetry: noop,
          onResume: noop,
          onRetryQueue: noop,
        });
        expect(html.match(KEY_ID), `${runState}/${paused}`).toBeNull();
      }
    }
  });

  test('the capped list renders no raw key id either — the cap hint is a key too', () => {
    const html = render({ messages: rows(QUEUE_MAX_DEPTH) });
    expect(html.match(KEY_ID)).toBeNull();
    expect(html).toContain(QUEUE_FULL_HINT);
  });
});
