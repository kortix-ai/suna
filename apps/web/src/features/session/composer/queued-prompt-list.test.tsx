import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
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

  test('a queued row offers Send now; a delivering or sending row, or another member\'s, offers nothing to hurry', () => {
    const markup = render({
      rows: [
        row({ id: 'q' }),
        row({ id: 'd', state: 'delivering', removable: false, takeBackEligible: false, interruptible: false }),
        row({ id: 's', state: 'sending', removable: false, takeBackEligible: false, interruptible: false }),
        row({ id: 'o', fromAnotherMember: true }),
      ],
    });
    expect(count(markup, 'aria-label="Send now"')).toBe(1);
  });

  test('a row the running turn already took — steer, no fallback — keeps only Remove; a steer row with a fallback still offers Send now', () => {
    // A steered row is read at the turn's NEXT step: there is nothing left to
    // hurry. A steer row whose fallback holds it for the turn's end is still
    // waiting, so Send now (the promote) is meaningful there.
    const markup = render({
      rows: [row({ id: 'steer', steer: true as const }), row({ id: 'fallback', steer: true as const, steerFallback: 'turn_ended' })],
    });
    expect(count(markup, 'aria-label="Send now"')).toBe(1);
  });

  test('a failed row keeps Retry and gets no second Send now — one primitive, one button', () => {
    const markup = render({
      rows: [row({ id: 'f', state: 'failed', lastError: 'boom', takeBackEligible: false })],
    });
    expect(markup).toContain('aria-label="Retry"');
    expect(markup).not.toContain('aria-label="Send now"');
  });

  test('a held row still offers Send now — the hold\'s per-row way out (KRTX-683 releases its batch)', () => {
    const markup = render({ rows: [row({ id: 'h' })], heldCount: 1 });
    expect(markup).toContain('Queue paused');
    expect(count(markup, 'aria-label="Send now"')).toBe(1);
  });

  test('clicking Send now runs THAT row through onRetry, and only that row', async () => {
    const retried: string[] = [];
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <QueryClientProvider client={new QueryClient()}>
          <NextIntlClientProvider locale="en" messages={{}} onError={() => {}}>
            <TooltipProvider>
              <QueuedPromptList rows={[row({ id: 'a' }), row({ id: 'b' })]} heldCount={0} onRetry={(id) => retried.push(id)} />
            </TooltipProvider>
          </NextIntlClientProvider>
        </QueryClientProvider>,
      );
    });
    const buttons = renderer.root.findAll(
      (node) => node.type === 'button' && node.props['aria-label'] === 'Send now',
    );
    expect(buttons).toHaveLength(2);
    // The row's `li` carries `data-queued-prompt-id`; walk up to it so the
    // click proves WHICH row's id reached `onRetry`.
    const rowIdOf = (button: ReactTestInstance): string | undefined => {
      let current: ReactTestInstance | null = button;
      while (current && current.props['data-queued-prompt-id'] === undefined) {
        current = current.parent;
      }
      return current ? (current.props['data-queued-prompt-id'] as string) : undefined;
    };
    const target = buttons.find((button) => rowIdOf(button) === 'b');
    expect(target).toBeDefined();
    await act(async () => {
      target!.props.onClick();
    });
    expect(retried).toEqual(['b']);
    renderer.unmount();
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
