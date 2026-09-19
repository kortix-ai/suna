import { describe, expect, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';

import en from '../../../../translations/en.json';
import { QueuedPromptFailure, queuedBubbleTone } from './queued-prompt-bubbles';
import { BUBBLE_SURFACE } from './user-message';

const renderFailure = (props: { lastError?: string | null; failureCode?: string | null } = {}) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={en} onError={() => {}}>
      <QueuedPromptFailure
        lastError="Runtime refused"
        onRetry={() => {}}
        onRemove={() => {}}
        {...props}
      />
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

  test('the bubble surface never tints by queue state', () => {
    // A queue state reads from words, not from the bubble's colour: muted text
    // while it waits, a failure line with Retry when it fails.
    expect(BUBBLE_SURFACE).not.toMatch(/queue-tone/);
    expect(BUBBLE_SURFACE).not.toMatch(/kortix-(yellow|orange|red)/);
    // The one surface every user bubble shares stays intact.
    expect(BUBBLE_SURFACE).toContain('bg-sidebar');
    expect(BUBBLE_SURFACE).toContain('dark:bg-muted');
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

describe('a Quick Queue failure says what the Queue List says', () => {
  // Two surfaces draw the same failed prompt. One sentence map, so they cannot
  // disagree about what went wrong.
  test('a named cause reads as its sentence, with the server prose in the title', () => {
    const markup = renderFailure({
      failureCode: 'out_of_credits',
      lastError: 'Out of credits. Top up to continue.',
    });
    expect(markup).toContain('Not sent. Out of credits.');
    expect(markup).not.toContain('— Out of credits');
    expect(markup).toContain('title="Out of credits. Top up to continue."');
  });

  test('a cause the server could not name keeps the reason it gave', () => {
    expect(renderFailure({ failureCode: 'unknown' })).toContain('Not sent — Runtime refused');
  });

  test('a session that no longer exists offers no Retry here either', () => {
    // The Queue List row for this cause shows Remove alone. A Retry on the
    // bubble would re-POST into a session that does not exist, every press.
    const markup = renderFailure({ failureCode: 'session_gone' });
    expect(markup).toContain('Not sent. This session no longer exists.');
    expect(markup).toContain('Remove');
    expect(markup).not.toContain('Retry');
    expect(markup.match(/<button/g)?.length).toBe(1);
  });

  test('every other cause keeps its Retry', () => {
    expect(renderFailure({ failureCode: 'out_of_credits' })).toContain('Retry');
  });
});
