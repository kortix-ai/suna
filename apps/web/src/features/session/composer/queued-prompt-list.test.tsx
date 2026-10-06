import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';

import { TooltipProvider } from '@/components/ui/tooltip';
import type { QueueRow } from '../queue-projection';
import { QueuedPromptList, type QueuedPromptListProps } from './queued-prompt-list';

const row = (over: Partial<QueueRow> & { id: string }): QueueRow => ({
  clientMessageId: `c-${over.id}`,
  text: `text ${over.id}`,
  attachmentCount: 0,
  state: 'queued',
  removable: true,
  interruptible: true,
  takeBackEligible: true,
  rawText: over.text ?? `text ${over.id}`,
  editText: over.text ?? `text ${over.id}`,
  ...over,
});

const render = (props: Partial<QueuedPromptListProps>) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <NextIntlClientProvider locale="en" messages={{}} onError={() => {}}>
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
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );

const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

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
    const markup = render({
      rows: [
        row({ id: 'queued' }),
        row({ id: 'delivering', state: 'delivering', removable: false }),
        row({ id: 'sending', state: 'sending', removable: false }),
      ],
    });
    expect(count(markup, 'aria-label="Remove from queue"')).toBe(1);
  });

  test('a failed row says so and offers Retry and Remove, both visible without hover', () => {
    const markup = render({
      rows: [row({ id: 'f', state: 'failed', lastError: 'boom', takeBackEligible: false })],
    });
    expect(markup).toContain('Not sent');
    expect(markup).toContain('aria-label="Retry"');
    expect(markup).toContain('aria-label="Remove from queue"');
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
    expect(markup).not.toContain('aria-label="Edit"');
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
    expect(count(render({ rows, onStopAndSend: () => {} }), 'Stop and send')).toBe(1);
    expect(render({ rows })).not.toContain('Stop and send');
  });
});
