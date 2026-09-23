import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';

import { TooltipProvider } from '@/components/ui/tooltip';

import en from '../../../../translations/en.json';
import { QUEUE_ROW_ACTION_COOLDOWN_MS } from '../composer/queued-prompt-list';
import {
  createQueuedRemoveGate,
  QueuedPromptFailure,
  QueuedPromptRemove,
  queuedBubbleTone,
} from './queued-prompt-bubbles';
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

/** `TooltipProvider` because the control sits in a `Hint`, as the app root
 *  supplies one. */
const renderRemove = (pendingAction?: 'retry' | 'remove') =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={en} onError={() => {}}>
      <TooltipProvider>
        <QueuedPromptRemove onRemove={() => {}} pendingAction={pendingAction} />
      </TooltipProvider>
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
    // A queue state reads from words, not from the bubble's colour: muted text
    // while it waits, a failure line with Retry when it fails.
    expect(BUBBLE_SURFACE).not.toMatch(/queue-tone|kortix-(yellow|orange|red|green)/);
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

describe('a waiting Quick Queue prompt can be taken back', () => {
  test('one icon button, named the way the Queue List names it', () => {
    const markup = renderRemove();
    expect(markup.match(/<button/g)?.length).toBe(1);
    expect(markup).toContain('aria-label="Remove from queue"');
    expect(markup).not.toContain('aria-disabled');
    // A waiting prompt still renders no words: the name is the label alone.
    expect(markup.replace(/<[^>]*>/g, '')).toBe('');
  });

  test('an action in flight refuses a press without dropping focus', () => {
    // `aria-disabled`, never `disabled`: disabling the pressed button drops
    // focus to <body>.
    for (const pendingAction of ['remove', 'retry'] as const) {
      const markup = renderRemove(pendingAction);
      expect(markup).toContain('aria-disabled="true"');
      expect(markup).not.toMatch(/\sdisabled(=|\s|>)/);
    }
  });

  test('a removal in flight shows the one spinner, never a spinning icon', () => {
    const removing = renderRemove('remove');
    // `animate-spinner-orbit` is `Loading`'s own class.
    expect(removing).toContain('animate-spinner-orbit');
    expect(removing).not.toMatch(/animate-spin(?!ner-)/);
    // A retry in flight is not this control's work: it keeps its glyph.
    expect(renderRemove('retry')).not.toContain('animate-spinner-orbit');
  });

  test('it carries no tint and no reveal of its own', () => {
    const markup = renderRemove();
    expect(markup).not.toMatch(/kortix-(yellow|orange|red)/);
    expect(markup).not.toContain('opacity-0');
  });

  test('the glyph takes the app icon weight and the button colour, as the Queue List trash does', () => {
    const markup = renderRemove();
    const svg = markup.match(/<svg[^>]*>/)?.[0] ?? '';
    expect(svg).toContain('size-4');
    // A colour class here is rewritten by the muted bubble's own selector
    // (`QUEUED_BUBBLE_OPACITY_CLASS`), which pins the glyph and stops it
    // following the button's hover colour.
    expect(svg).not.toContain('text-foreground');
    const source = readFileSync(join(import.meta.dir, 'queued-prompt-bubbles.tsx'), 'utf8');
    expect(source).not.toMatch(/weight=/);
  });
});

describe('createQueuedRemoveGate — which press removes a waiting bubble', () => {
  const press = (
    gate: ReturnType<typeof createQueuedRemoveGate>,
    input: { detail: number; nowMs: number; pendingAction?: 'retry' | 'remove' },
  ) => gate(input);

  test('a pointer press removes, and leaves focus alone', () => {
    // Focusing the composer on a tap would raise the touch keyboard.
    expect(press(createQueuedRemoveGate(), { detail: 1, nowMs: 1_000 })).toEqual({
      accepted: true,
      focusComposer: false,
    });
  });

  test('a keyboard press removes, then hands focus to the composer', () => {
    // The bubble unmounts with its row; focus would otherwise fall to <body>.
    expect(press(createQueuedRemoveGate(), { detail: 0, nowMs: 1_000 })).toEqual({
      accepted: true,
      focusComposer: true,
    });
  });

  test('a row with an action in flight refuses every press', () => {
    // `aria-disabled` does not block a click; this is the only refusal.
    for (const pendingAction of ['retry', 'remove'] as const) {
      for (const detail of [0, 1]) {
        expect(press(createQueuedRemoveGate(), { detail, nowMs: 1_000, pendingAction })).toEqual({
          accepted: false,
          focusComposer: false,
        });
      }
    }
  });

  test('the second click of a double-click never removes the bubble that slid under the pointer', () => {
    // Each bubble is its own component, so the gate is shared by all of them.
    const gate = createQueuedRemoveGate();
    expect(press(gate, { detail: 1, nowMs: 1_000 }).accepted).toBe(true);
    expect(press(gate, { detail: 2, nowMs: 1_033 }).accepted).toBe(false);
    expect(press(gate, { detail: 1, nowMs: 1_000 + QUEUE_ROW_ACTION_COOLDOWN_MS - 1 }).accepted).toBe(
      false,
    );
    expect(press(gate, { detail: 1, nowMs: 1_000 + QUEUE_ROW_ACTION_COOLDOWN_MS }).accepted).toBe(
      true,
    );
  });

  test('a refused press never re-arms the cooldown', () => {
    const gate = createQueuedRemoveGate();
    press(gate, { detail: 1, nowMs: 1_000 });
    press(gate, { detail: 1, nowMs: 1_000 + QUEUE_ROW_ACTION_COOLDOWN_MS - 1 });
    expect(press(gate, { detail: 1, nowMs: 1_000 + QUEUE_ROW_ACTION_COOLDOWN_MS }).accepted).toBe(true);
  });

  test('a press refused for an action in flight does not start a cooldown', () => {
    const gate = createQueuedRemoveGate();
    press(gate, { detail: 1, nowMs: 1_000, pendingAction: 'retry' });
    expect(press(gate, { detail: 1, nowMs: 1_010 }).accepted).toBe(true);
  });

  test('the keyboard is never held back by the cooldown', () => {
    // Focus moves deliberately; blocking it would strand a keyboard user.
    const gate = createQueuedRemoveGate();
    press(gate, { detail: 1, nowMs: 1_000 });
    expect(press(gate, { detail: 0, nowMs: 1_010 })).toEqual({
      accepted: true,
      focusComposer: true,
    });
  });

  test('both Remove controls of a bubble press through the one shared gate', () => {
    const source = readFileSync(join(import.meta.dir, 'queued-prompt-bubbles.tsx'), 'utf8');
    expect(source.match(/pressQueuedRemove\(/g)?.length).toBe(3);
    expect(source).not.toContain('onClick={onRemove}');
  });
});
