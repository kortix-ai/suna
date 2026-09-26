import { describe, expect, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';

import en from '../../../../translations/en.json';
import { QueuedPromptFailure, queuedBubbleTone } from './queued-prompt-bubbles';
import { BUBBLE_SURFACE } from './user-message';

const renderFailure = () =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={en} onError={() => {}}>
      <QueuedPromptFailure lastError="Runtime refused" onRetry={() => {}} onRemove={() => {}} />
    </NextIntlClientProvider>,
  );

describe('queued bubble tone', () => {
  test('waiting and sending share one tone, so a retry never recolors the ring', () => {
    expect(queuedBubbleTone('queued')).toBe('pending');
    expect(queuedBubbleTone('sending')).toBe('pending');
    expect(queuedBubbleTone('interrupted')).toBe('pending');
    expect(queuedBubbleTone('held')).toBe('held');
    expect(queuedBubbleTone('failed')).toBe('failed');
    expect(queuedBubbleTone(null)).toBeUndefined();
  });

  test('the bubble surface stays neutral in every queue state', () => {
    expect(BUBBLE_SURFACE).not.toMatch(/queue-tone|kortix-(yellow|orange|red|green)/);
  });
});

describe('queued user message text', () => {
  test('no waiting, sending, paused, or interrupted copy exists to render', () => {
    const threads = (en as { threads: Record<string, string> }).threads;
    expect(threads.quickQueueWaiting).toBeUndefined();
    expect(threads.quickQueueSending).toBeUndefined();
  });

  test('a delivery failure keeps its cause and recovery actions', () => {
    const failed = renderFailure();
    expect(failed).toContain('data-queued-status="failed"');
    expect(failed).toContain('Runtime refused');
    expect(failed.match(/<button/g)?.length).toBe(2);
    expect(failed).not.toMatch(/Quick Queue|Waiting|Sending|Queued/);
  });
});
