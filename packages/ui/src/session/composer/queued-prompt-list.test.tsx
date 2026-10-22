import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, test } from 'bun:test';
import { IntlTestProvider } from '../../test-utils/intl';

import { renderToStaticMarkup } from 'react-dom/server';

import { TooltipProvider } from '../../primitives/tooltip';
import type { QueueRow } from './queue-projection';
import {
  QueuedPromptList,
  queuedRowActions,
  type QueuedPromptListProps,
} from './queued-prompt-list';

const row = (over: Partial<QueueRow> & { id: string }): QueueRow => ({
  clientMessageId: `c-${over.id}`,
  text: `text ${over.id}`,
  attachmentCount: 0,
  state: 'queued',
  removable: true,
  // As the projection sets it for the author's own failed row.
  retryable: over.state === 'failed',
  interruptible: true,
  takeBackEligible: true,
  rawText: over.text ?? `text ${over.id}`,
  editText: over.text ?? `text ${over.id}`,
  ...over,
});

const render = (props: Partial<QueuedPromptListProps>) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <IntlTestProvider locale="en" onError={() => {}}>
        <TooltipProvider>
          <QueuedPromptList
            rows={[]}
            heldCount={0}
            onResume={() => {}}
            onRemove={() => {}}
            onRetry={() => {}}
            {...props}
          />
        </TooltipProvider>
      </IntlTestProvider>
    </QueryClientProvider>,
  );

const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

const noop = () => {};
const keys = (r: QueueRow, handlers: Parameters<typeof queuedRowActions>[1] = {
  onEdit: noop,
  onRetry: noop,
  onRemove: noop,
}) => queuedRowActions(r, handlers).map((action) => action.key);

describe('QueuedPromptList', () => {
  test('renders nothing at all when nothing is queued or held', () => {
    // The composer's inset strip hides itself with `:empty`; any wrapper here
    // would paint an empty rounded sliver above the card.
    expect(render({})).toBe('');
  });

  test('one row per entry, in order, with the full text', () => {
    const markup = render({
      rows: [row({ id: 'a', text: 'first line\nsecond line' }), row({ id: 'b' })],
    });
    expect(markup.indexOf('data-queued-prompt-id="a"')).toBeLessThan(
      markup.indexOf('data-queued-prompt-id="b"'),
    );
    expect(markup).toContain('first line\nsecond line');
    expect(markup).not.toContain('Queue paused');
  });

  test('Remove only where the server will honour a removal', () => {
    expect(keys(row({ id: 'queued' }))).toContain('remove');
    expect(keys(row({ id: 'delivering', state: 'delivering', removable: false }))).not.toContain('remove');
    expect(keys(row({ id: 'sending', state: 'sending', removable: false }))).not.toContain('remove');
  });

  test('the row actions live in one menu per row: no inline buttons, one trigger per row with actions', () => {
    const markup = render({
      rows: [
        row({ id: 'q' }),
        // Nothing to do on this row, so it draws no menu trigger.
        row({ id: 'd', state: 'delivering', removable: false, takeBackEligible: false, interruptible: false }),
      ],
      onEdit: () => {},
      onStopAndSend: () => {},
    });
    expect(count(markup, 'data-queued-actions')).toBe(1);
    expect(markup).toContain('aria-label="Message actions"');
    expect(markup).not.toContain('Send now');
    expect(markup).not.toContain('Stop and send');
    expect(markup).not.toContain('aria-label="Remove from queue"');
    expect(markup).not.toContain('aria-label="Edit"');
  });

  test('a held `/` command says when it runs and offers Remove only', () => {
    const held = row({
      id: 'command:x',
      text: '/review',
      command: true,
      interruptible: false,
      takeBackEligible: false,
    });
    expect(keys(held)).toEqual(['remove']);
    expect(render({ rows: [held] })).toContain('data-queued-command');
  });

  test('menu order: Edit, Send now, Stop and send, then Remove', () => {
    expect(
      keys(row({ id: 'q' }), { onEdit: noop, onRetry: noop, onStopAndSend: noop, onRemove: noop }),
    ).toEqual(['edit', 'sendNow', 'stopAndSend', 'remove']);
  });

  test('the action matrix: Send now on the one queued own row only; a failed row keeps Retry and gets no second button; delivering, sending and another member\'s rows get nothing to hurry', () => {
    // One render pins the whole matrix, so the failed-row half is not a
    // vacuous pass at the base (where no Send now exists anywhere): the
    // queued row's counted Send now already fails there.
    expect(keys(row({ id: 'q' }))).toContain('sendNow');
    expect(keys(row({ id: 'f', state: 'failed', lastError: 'boom', takeBackEligible: false }))).toEqual([
      'retry',
      'remove',
    ]);
    const hurry = (r: QueueRow) => keys(r).filter((k) => k === 'sendNow' || k === 'retry');
    expect(
      hurry(row({ id: 'd', state: 'delivering', removable: false, takeBackEligible: false, interruptible: false })),
    ).toEqual([]);
    expect(
      hurry(row({ id: 's', state: 'sending', removable: false, takeBackEligible: false, interruptible: false })),
    ).toEqual([]);
    expect(hurry(row({ id: 'o', fromAnotherMember: true }))).toEqual([]);
  });

  test('a row the running turn already took — steer, no fallback — keeps only Remove; a fallen-back row still offers Send now', () => {
    // A steered row is read at the turn's NEXT step: there is nothing left to
    // hurry. A row whose fallback holds it for the turn's end is still
    // waiting, so Send now (the promote) is meaningful there. The server
    // clears the steer delivery when it writes the fallback
    // (command-transitions.ts), so the two rows here are the two shapes the
    // projection can produce.
    expect(keys(row({ id: 'steer', steer: true as const, takeBackEligible: false }))).toEqual(['remove']);
    expect(keys(row({ id: 'fallback', steerFallback: 'turn_ended' }))).toContain('sendNow');
  });

  test('a held row still offers Send now — the hold\'s per-row way out (KRTX-683 releases its batch)', () => {
    const markup = render({ rows: [row({ id: 'h' })], heldCount: 1 });
    expect(markup).toContain('Queue paused');
    expect(keys(row({ id: 'h' }))).toContain('sendNow');
  });

  test('a failed row says so, and its menu (Retry, Remove) is visible without hover', () => {
    const markup = render({
      rows: [row({ id: 'f', state: 'failed', lastError: 'boom', takeBackEligible: false })],
    });
    expect(markup).toContain('Not sent');
    expect(markup).toContain('data-queued-actions');
    expect(markup).not.toContain('group-hover/queued:opacity-100');
  });

  test('a held queue shows one line with Resume, even with no rows to list', () => {
    const markup = render({ heldCount: 2 });
    expect(markup).toContain('Queue paused');
    expect(markup).toContain('Resume');
    expect(markup).not.toContain('<ul');
  });

  test('Resume is disabled and shows Loading while the release is in flight', () => {
    const markup = render({ heldCount: 1, resumePending: true });
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*Resume/);
  });

  test('a row with files shows how many', () => {
    const markup = render({ rows: [row({ id: 'a', attachmentCount: 3 })] });
    expect(markup).toContain('3 files');
  });

  test('the row being edited stays in its slot, offers Cancel, and blocks a second Edit', () => {
    const markup = render({
      rows: [row({ id: 'a' }), row({ id: 'b', text: 'old b' }), row({ id: 'c' })],
      onEdit: () => {},
      onCancelEdit: () => {},
      editing: { promptId: 'b' },
    });
    const a = markup.indexOf('data-queued-prompt-id="a"');
    const b = markup.indexOf('data-queued-editing');
    const c = markup.indexOf('data-queued-prompt-id="c"');
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
    // ONE row for b: the editing row replaces it, it is not drawn twice.
    expect(markup).not.toContain('data-queued-prompt-id="b"');
    expect(markup).toContain('old b');
    expect(markup).toContain('aria-label="Cancel"');
    // The list passes no Edit handler while an edit is open.
    expect(keys(row({ id: 'a' }), { onRemove: noop })).not.toContain('edit');
  });

  test('an edit whose row has gone draws no editing row', () => {
    const markup = render({ rows: [row({ id: 'a' })], editing: { promptId: 'gone' } });
    expect(markup).not.toContain('data-queued-editing');
  });
});


test('Queue List rows carry no waiting or sending caption', () => {
  const markup = render({ rows: [row({ id: 'waiting' }), row({ id: 'sending', state: 'delivering', removable: false, takeBackEligible: false })] });
  expect(markup).toContain('aria-label="Queue List"');
  expect(markup).not.toContain('Waiting');
  expect(markup).not.toContain('Sending');
  expect(markup).not.toContain('role="status"');
});

describe('steering rows', () => {
  test('a steer row says the agent reads it at its next step', () => {
    const markup = render({ rows: [row({ id: 's', steer: true }), row({ id: 'q' })] });
    expect(count(markup, 'Read at next step')).toBe(1);
  });

  test('a fallen-back row says why it waits, not the steer caption', () => {
    const markup = render({
      rows: [
        row({ id: 'u', steerFallback: 'unsupported' }),
        row({ id: 'n', steerFallback: 'not_prompter' }),
        row({ id: 't', steerFallback: 'turn_ended' }),
      ],
    });
    expect(markup).toContain('This session cannot take messages mid-turn.');
    expect(markup).toContain('Another member started it.');
    expect(markup).toContain('The turn ended first.');
    expect(markup).not.toContain('Read at next step');
  });

  test('Stop and send shows on waiting rows only, and only while a turn runs', () => {
    const rows = [
      row({ id: 'waiting' }),
      row({ id: 'delivering', state: 'delivering', removable: false, interruptible: false }),
      row({ id: 'sending', state: 'sending', removable: false, interruptible: false }),
    ];
    expect(rows.filter((r) => keys(r, { onStopAndSend: noop }).includes('stopAndSend')).map((r) => r.id)).toEqual([
      'waiting',
    ]);
    expect(rows.some((r) => keys(r).includes('stopAndSend'))).toBe(false);
  });
});
