import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';

import { TooltipProvider } from '@/components/ui/tooltip';
import type { QueueRow } from '../queue-projection';
import {
  QUEUE_ROW_ACTION_COOLDOWN_MS,
  QueuedPromptList,
  acceptRowAction,
  focusMovesToComposer,
  focusedRowAfter,
  nextRowActionState,
  type QueuedPromptListProps,
} from './queued-prompt-list';

const row = (over: Partial<QueueRow> & { id: string }): QueueRow => ({
  clientMessageId: `c-${over.id}`,
  text: `text ${over.id}`,
  attachmentCount: 0,
  state: 'queued',
  removable: true,
  retryable: false,
  takeBackEligible: true,
  canSendNow: false,
  ...over,
});

/** Each `<button>` whole, so an attribute is read on the button that carries
 *  it — a `toContain` over the row matches either one. */
const buttons = (markup: string) =>
  Array.from(markup.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)).map((m) => m[0]);
const button = (markup: string, label: string) =>
  buttons(markup).find((html) => html.includes(`aria-label="${label}"`));

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
      rows: [
        row({
          id: 'f',
          state: 'failed',
          retryable: true,
          lastError: 'boom',
          takeBackEligible: false,
        }),
      ],
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


test('Queue List rows carry no waiting or sending caption', () => {
  const markup = render({ rows: [row({ id: 'waiting' }), row({ id: 'sending', state: 'delivering', removable: false, takeBackEligible: false })] });
  expect(markup).toContain('aria-label="Queue List"');
  expect(markup).not.toContain('Waiting');
  expect(markup).not.toContain('Sending');
  expect(markup).not.toContain('role="status"');
});

describe('acceptRowAction', () => {
  // A Remove takes its row off the list and the NEXT row slides up under the
  // pointer, with its own Remove in the same place. The second click of a
  // double-click lands on that row and removes a prompt nobody chose.
  const at = (nowMs: number) => ({ detail: 1, nowMs, lastShiftAtMs: 1_000 });

  const table = [
    ['the click that starts the cooldown', at(1_000), false],
    ['halfway through it', at(1_000 + QUEUE_ROW_ACTION_COOLDOWN_MS / 2), false],
    ['one ms before it ends', at(1_000 + QUEUE_ROW_ACTION_COOLDOWN_MS - 1), false],
    ['exactly when it ends', at(1_000 + QUEUE_ROW_ACTION_COOLDOWN_MS), true],
    ['well after it', at(1_000 + 5_000), true],
  ] as const;
  for (const [label, input, accepted] of table) {
    test(`a pointer activation ${label} → ${accepted}`, () => {
      expect(acceptRowAction(input)).toBe(accepted);
    });
  }

  test('the first action of a list is always accepted', () => {
    expect(acceptRowAction({ detail: 1, nowMs: 1_000, lastShiftAtMs: null })).toBe(true);
  });

  test('a keyboard activation is never blocked — the pointer is not over anything', () => {
    // Space and Enter on a focused button report `detail === 0`. Focus moves
    // deliberately, so the row under it is the row the user chose.
    expect(acceptRowAction({ detail: 0, nowMs: 1_000, lastShiftAtMs: 1_000 })).toBe(true);
  });

  test('a row whose own action is still running accepts nothing, from either input', () => {
    expect(
      acceptRowAction({ detail: 0, nowMs: 9_000, lastShiftAtMs: null, pendingAction: 'remove' }),
    ).toBe(false);
    expect(
      acceptRowAction({ detail: 1, nowMs: 9_000, lastShiftAtMs: null, pendingAction: 'retry' }),
    ).toBe(false);
  });

  test('the cooldown outlasts the platform double-click window', () => {
    // macOS and Windows both default the double-click interval to 500 ms. At
    // 400 ms two clicks 450 ms apart each landed: the second hit the row that
    // had slid under the pointer and removed a prompt nobody chose (measured in
    // a real browser, 2026-09-22: two DELETEs 475 ms apart, both 200).
    expect(QUEUE_ROW_ACTION_COOLDOWN_MS).toBeGreaterThan(500);
  });
});

describe('nextRowActionState', () => {
  // Remove and Send now take the row off the list (Send now moves it into the
  // Quick Queue). Edit keeps it in place while the composer holds its words,
  // and Retry re-queues it in place, so neither starts a cooldown.
  const table = [
    ['remove', 400, true],
    ['edit', 400, false],
    ['retry', 400, false],
    ['sendNow', 400, true],
  ] as const;
  for (const [action, expectedStamp, shifts] of table) {
    test(`${action} ${shifts ? 'starts' : 'does not start'} the cooldown`, () => {
      expect(
        nextRowActionState({ action, detail: 1, nowMs: 400, lastShiftAtMs: null }),
      ).toEqual({ accepted: true, lastShiftAtMs: shifts ? expectedStamp : null });
    });
  }

  const doubleClick = [
    ['remove', 'remove'],
    ['remove', 'edit'],
    ['remove', 'sendNow'],
    ['remove', 'retry'],
    ['sendNow', 'sendNow'],
    ['sendNow', 'remove'],
  ] as const;
  for (const [first, second] of doubleClick) {
    test(`a pointer ${second} 200 ms after a ${first} lands on the shifted list and is refused`, () => {
      const after = nextRowActionState({
        action: first,
        detail: 1,
        nowMs: 1_000,
        lastShiftAtMs: null,
      });
      expect(after.accepted).toBe(true);
      expect(
        nextRowActionState({
          action: second,
          detail: 1,
          nowMs: 1_200,
          lastShiftAtMs: after.lastShiftAtMs,
        }),
      ).toEqual({ accepted: false, lastShiftAtMs: 1_000 });
    });
  }

  test('a refused activation never re-arms the cooldown', () => {
    // Otherwise a held-down double-click would extend the block indefinitely.
    expect(
      nextRowActionState({ action: 'remove', detail: 1, nowMs: 1_399, lastShiftAtMs: 1_000 }),
    ).toEqual({ accepted: false, lastShiftAtMs: 1_000 });
  });

  test('a keyboard Remove right after a pointer Remove is accepted, and re-stamps', () => {
    expect(
      nextRowActionState({ action: 'remove', detail: 0, nowMs: 1_010, lastShiftAtMs: 1_000 }),
    ).toEqual({ accepted: true, lastShiftAtMs: 1_010 });
  });

  test('a row with its own action in flight accepts nothing and stamps nothing', () => {
    expect(
      nextRowActionState({
        action: 'edit',
        detail: 1,
        nowMs: 9_000,
        lastShiftAtMs: null,
        pendingAction: 'remove',
      }),
    ).toEqual({ accepted: false, lastShiftAtMs: null });
  });
});

describe('a row with an action in flight', () => {
  test('is marked, so the gate and a test can both see it', () => {
    const markup = render({
      rows: [row({ id: 'a', pendingAction: 'remove' }), row({ id: 'b' })],
    });
    expect(markup).toContain('data-queued-pending="remove"');
    expect(count(markup, 'data-queued-pending=')).toBe(1);
  });
});

describe('a failed row', () => {
  const failed = (over: Partial<QueueRow> = {}) =>
    render({
      rows: [
        row({
          id: 'f',
          state: 'failed',
          retryable: true,
          takeBackEligible: false,
          ...over,
        }),
      ],
    });

  test('a named cause reads as one sentence; the server prose only hovers', () => {
    const markup = failed({
      failureCode: 'out_of_credits',
      lastError: 'Out of credits. Top up to continue.',
    });
    expect(markup).toContain('Not sent. Out of credits.');
    expect(markup).not.toContain('— Out of credits');
    expect(markup).toContain('title="Out of credits. Top up to continue."');
  });

  test('a cause with no code of its own still shows the reason it has', () => {
    const markup = failed({ lastError: 'admission check failed: no driver' });
    expect(markup).toContain('Not sent — admission check failed: no driver');
  });

  test('the sentence is a live region the buttons point at', () => {
    const markup = failed({ failureCode: 'network' });
    expect(markup).toContain('id="queued-failure-f"');
    expect(markup).toContain('role="status"');
    for (const label of ['Retry', 'Remove from queue']) {
      expect(button(markup, label)).toContain('aria-describedby="queued-failure-f"');
    }
  });

  test('a session that no longer exists offers no Retry, only Remove', () => {
    const markup = failed({ failureCode: 'session_gone', retryable: false });
    expect(markup).toContain('Not sent. This session no longer exists.');
    expect(button(markup, 'Retry')).toBeUndefined();
    expect(button(markup, 'Remove from queue')).toBeDefined();
  });

  test('a retry in flight marks the row busy and shows Loading in Retry alone', () => {
    // `aria-disabled`, never `disabled`: disabling the focused button drops
    // focus to <body> and the user loses their place mid-action.
    const markup = failed({ failureCode: 'network', pendingAction: 'retry' });
    expect(markup).toContain('aria-busy="true"');
    const retry = button(markup, 'Retry')!;
    const remove = button(markup, 'Remove from queue')!;
    expect(retry).toContain('aria-disabled="true"');
    expect(remove).toContain('aria-disabled="true"');
    expect(retry).not.toContain('disabled=""');
    expect(remove).not.toContain('disabled=""');
    // Loading is the orbit spinner; Remove keeps its trash icon, not a spinner.
    expect(retry).toContain('animate-spinner-orbit');
    expect(remove).not.toContain('animate-spinner-orbit');
  });

  test('a removal in flight shows Loading in Remove alone', () => {
    const markup = failed({ failureCode: 'network', pendingAction: 'remove' });
    expect(button(markup, 'Remove from queue')!).toContain('animate-spinner-orbit');
    expect(button(markup, 'Retry')!).not.toContain('animate-spinner-orbit');
  });

  test('a row with nothing running is not busy', () => {
    expect(failed({ failureCode: 'network' })).not.toContain('aria-busy');
  });
});

describe('focusMovesToComposer', () => {
  // A failed row's Retry removes the row it lives on. Without this the focused
  // button unmounts, focus falls to <body>, and the next keystroke goes nowhere.
  const rows = [row({ id: 'a', state: 'failed', retryable: true }), row({ id: 'b' })];

  test('the row holding focus left the list', () => {
    expect(focusMovesToComposer({ focusedRowId: 'gone', rows, activeElementIsBody: true })).toBe(
      true,
    );
  });

  test('the row holding focus stopped being failed, so its buttons went', () => {
    expect(focusMovesToComposer({ focusedRowId: 'b', rows, activeElementIsBody: true })).toBe(true);
  });

  test('the row is still failed, so its buttons are still there', () => {
    expect(focusMovesToComposer({ focusedRowId: 'a', rows, activeElementIsBody: true })).toBe(
      false,
    );
  });

  test('nothing in the list had focus', () => {
    expect(focusMovesToComposer({ focusedRowId: null, rows, activeElementIsBody: true })).toBe(
      false,
    );
  });

  test('focus went somewhere the user chose, so it is not taken away again', () => {
    expect(focusMovesToComposer({ focusedRowId: 'gone', rows, activeElementIsBody: false })).toBe(
      false,
    );
  });
});

describe('focusedRowAfter', () => {
  // The latch may only survive a focus loss caused by the row's OWN unmount.
  // Kept across an ordinary blur it goes stale, and any later `rows` change
  // while focus happens to sit on <body> yanks the caret into the composer.
  test('a focused row becomes the latch', () => {
    expect(focusedRowAfter(null, { type: 'focus', rowId: 'a' })).toBe('a');
    expect(focusedRowAfter('a', { type: 'focus', rowId: 'b' })).toBe('b');
  });

  test('the row losing focus drops the latch', () => {
    expect(focusedRowAfter('a', { type: 'blur', rowId: 'a' })).toBeNull();
  });

  test('another row losing focus leaves the latch alone', () => {
    expect(focusedRowAfter('a', { type: 'blur', rowId: 'b' })).toBe('a');
  });

  test('moving between two buttons of ONE row ends up back on that row', () => {
    // focusout bubbles from the old button before focusin bubbles from the new
    // one, so the pair has to be a no-op overall.
    const afterBlur = focusedRowAfter('a', { type: 'blur', rowId: 'a' });
    expect(focusedRowAfter(afterBlur, { type: 'focus', rowId: 'a' })).toBe('a');
  });
});

describe('the queue list disclosure header', () => {
  const rows = [row({ id: 'a' }), row({ id: 'b' }), row({ id: 'c' })];

  test('open: "N Queued" and a close button, with no Start Multitasking', () => {
    const markup = render({ rows });
    expect(markup).toContain('3 Queued');
    const close = button(markup, 'Collapse queue');
    expect(close).toBeDefined();
    expect(close).toContain('aria-expanded="true"');
    expect(markup).not.toContain('Multitasking');
    expect(count(markup, 'data-queued-prompt-id=')).toBe(3);
  });

  test('closed: the header keeps the count, offers an expand chevron, and hides the rows', () => {
    const markup = render({ rows, defaultCollapsed: true });
    expect(markup).toContain('3 Queued');
    const expand = button(markup, 'Expand queue');
    expect(expand).toBeDefined();
    expect(expand).toContain('aria-expanded="false"');
    expect(button(markup, 'Collapse queue')).toBeUndefined();
    expect(count(markup, 'data-queued-prompt-id=')).toBe(0);
  });

  test('a held queue with no rows keeps its Resume line and draws no header', () => {
    const markup = render({ heldCount: 2 });
    expect(markup).not.toContain('Queued</');
    expect(button(markup, 'Collapse queue')).toBeUndefined();
  });
});

describe('queued row actions', () => {
  test('a queued row offers Send now, Edit and Remove, and no overflow menu', () => {
    const markup = render({
      rows: [row({ id: 'a', canSendNow: true })],
      onSendNow: () => {},
      onEdit: () => {},
    });
    const html = buttons(markup);
    expect(html.some((b) => />Send now</.test(b))).toBe(true);
    expect(button(markup, 'Edit')).toBeDefined();
    expect(button(markup, 'Remove from queue')).toBeDefined();
    expect(button(markup, 'More actions')).toBeUndefined();
  });

  test('Send now only on a row the server still holds in line', () => {
    const markup = render({
      rows: [
        row({ id: 'queued', canSendNow: true }),
        row({ id: 'delivering', state: 'delivering', removable: false, canSendNow: false }),
      ],
      onSendNow: () => {},
    });
    expect(count(markup, '>Send now<')).toBe(1);
  });

  test('the row being edited is outlined, says Editing, and offers no actions', () => {
    const markup = render({
      rows: [row({ id: 'a', canSendNow: true }), row({ id: 'b', canSendNow: true })],
      editingId: 'a',
      onSendNow: () => {},
      onEdit: () => {},
    });
    const editing = markup.slice(
      markup.indexOf('data-queued-prompt-id="a"'),
      markup.indexOf('data-queued-prompt-id="b"'),
    );
    expect(editing).toContain('data-queued-editing="true"');
    expect(editing).toContain('Editing');
    expect(editing).not.toContain('>Send now<');
    expect(editing).not.toContain('aria-label="Edit"');
    expect(editing).not.toContain('aria-label="Remove from queue"');
    const other = markup.slice(markup.indexOf('data-queued-prompt-id="b"'));
    expect(other).toContain('>Send now<');
  });
});


describe('a paused queue with rows', () => {
  test('the header reads Queue paused, with Resume before the chevron, and no second line', () => {
    const markup = render({ rows: [row({ id: 'a' }), row({ id: 'b' })], heldCount: 2 });
    expect(markup).toContain('Queue paused');
    expect(markup).not.toContain('2 Queued');
    expect(count(markup, 'Queue paused')).toBe(1);
    const resume = markup.indexOf('Resume');
    const chevron = markup.indexOf('aria-label="Collapse queue"');
    expect(resume).toBeGreaterThan(-1);
    expect(resume).toBeLessThan(chevron);
  });

  test('a queue that is not paused keeps its count and offers no Resume', () => {
    const markup = render({ rows: [row({ id: 'a' }), row({ id: 'b' })] });
    expect(markup).toContain('2 Queued');
    expect(markup).not.toContain('Resume');
  });
});
