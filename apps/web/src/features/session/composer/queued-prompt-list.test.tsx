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
  takeBackEligible: true,
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
});


test('Queue List identifies waiting and sending rows without hover', () => {
  const markup = render({ rows: [row({ id: 'waiting' }), row({ id: 'sending', state: 'delivering', removable: false, takeBackEligible: false })] });
  expect(markup).toContain('aria-label="Queue List"');
  expect(markup).toContain('Waiting');
  expect(markup).toContain('Sending…');
});
