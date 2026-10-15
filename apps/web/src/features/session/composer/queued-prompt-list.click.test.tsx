import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { TooltipProvider } from '@/components/ui/tooltip';
import type { QueueRow } from '../queue-projection';
import { QueuedPromptList } from './queued-prompt-list';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

// bun test has no `window`; the TooltipProvider's skip-delay effect needs one
// to clearTimeout its timer on unmount (this file unmounts inside act()).
const originalWindow = globalThis.window as Window | undefined;
beforeEach(() => {
  globalThis.window = Object.assign(new EventTarget(), {
    clearTimeout: () => {},
    setTimeout: () => 0,
  }) as unknown as Window & typeof globalThis;
});
afterEach(() => {
  globalThis.window = originalWindow as Window & typeof globalThis;
});

// This click test lives in its own file: it is the only test of the list that
// needs a live renderer (react-test-renderer), and mixing renderers in one
// file makes every run warn about concurrent context providers.
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

describe('clicking Send now', () => {
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
    await act(async () => {
      renderer.unmount();
    });
  });
});
