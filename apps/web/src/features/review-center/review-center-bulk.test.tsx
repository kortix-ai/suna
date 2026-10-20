/**
 * Review Center select mode: a row checkbox or `x` selects rows in Needs you,
 * and the floating bar approves, denies or dismisses them through one bulk
 * request. Only the ids each verb supports are sent; only the ids the server
 * reports ok leave the list.
 *
 * Runs the real inbox against `happy-dom`, like review-center-verdicts.test.tsx.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

const win = new Window({ width: 1440, height: 900 });
const globals = globalThis as Record<string, unknown>;
globals.window = win;
globals.document = win.document;
globals.navigator = win.navigator;
globals.location = win.location;
globals.history = win.history;
// The change page's diff view registers a custom element on import.
globals.customElements = win.customElements;
globals.getComputedStyle = win.getComputedStyle.bind(win);
globals.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);
globals.cancelAnimationFrame = (id: number) => clearTimeout(id);
for (const key of Object.getOwnPropertyNames(win)) {
  if (/^[A-Z]/.test(key) && !(key in globals)) globals[key] = Reflect.get(win, key);
}
// Bun has its own event classes. The menu's focus and dismiss layers create
// events by bare global name, and happy-dom dispatches only its own.
for (const key of [
  'Event',
  'CustomEvent',
  'FocusEvent',
  'KeyboardEvent',
  'MouseEvent',
  'PointerEvent',
]) {
  globals[key] = Reflect.get(win, key);
}

// The open item lives in `?id=`.
let search = '';
mock.module('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(search),
  usePathname: () => '/projects/p/review',
  useRouter: () => ({ push() {}, replace() {}, prefetch() {} }),
}));
const realUiProvider = { ...(await import('@kortix/ui/providers/ui-provider')) };
mock.module('@kortix/ui/providers/ui-provider', () => ({
  ...realUiProvider,
  useUiSearchParams: () => new URLSearchParams(search),
  useUiPathname: () => '/projects/p/review',
  useUiRouter: () => ({ push() {}, replace() {}, prefetch() {}, back() {} }),
}));

const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { NextIntlClientProvider } = await import('@/i18n/use-translations');
const { PROJECT_ACTIONS, reviewVerdictAllowed } = await import('@kortix/sdk');
const messages = (await import('../../../translations/en.json')).default;
const { MOCK_ITEMS } = await import('@kortix/ui/workspace/review/mock-data');
const { ReviewCenter } = await import('@kortix/ui/workspace/review/review-center');
type ReviewItem = (typeof MOCK_ITEMS)[number];

const mockItem = (id: string) => MOCK_ITEMS.find((item) => item.id === id)!;


const { PROJECT_WRITE, PROJECT_REVIEW_ACT } = PROJECT_ACTIONS;
const MANAGER = { [PROJECT_WRITE]: { allowed: true }, [PROJECT_REVIEW_ACT]: { allowed: true } };

const OUTPUT = mockItem('rv-output-1');
const native = mockItem('rv-approval-1');
/** A connector approval: one call, readable, decidable. */
const call = (n: number, risk: 'low' | 'high' = 'low') =>
  ({
    ...native,
    id: `call:e${n}`,
    title: `Send report ${n}`,
    risk,
    expiresAt: undefined,
    detail: {
      actions: [
        {
          ...(native.kind === 'approval' ? native.detail.actions[0] : {}),
          actionPath: `gmail.send_email_${n}`,
          rawArgsPreview: { token: '[redacted]', subject: `Weekly ${n}`, to: 'team' },
          reviewComplete: true,
        },
      ],
    },
  }) as ReviewItem;

let root: Root | null = null;
let host: HTMLElement | null = null;
let bulkCalls: string[] = [];
let opened: string[] = [];
let nextResults: (ids: string[]) => { id: string; ok: boolean; code?: string }[] = (ids) =>
  ids.map((id) => ({ id, ok: true }));

function mount(items: ReviewItem[]) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <QueryClientProvider client={new QueryClient()}>
        <NextIntlClientProvider locale="en" messages={messages} onError={() => {}}>
          <ReviewCenter
            initialItems={items}
            isFetched
            recoveringCrId={null}
            onAct={(id) => opened.push(id)}
            onBulkAct={async (ids, verdict) => {
              bulkCalls.push(`${verdict} ${ids.join(',')}`);
              return nextResults(ids);
            }}
            verdictAllowed={(item, verdict) => reviewVerdictAllowed(item, verdict, MANAGER)}
          />
        </NextIntlClientProvider>
      </QueryClientProvider>,
    );
  });
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  search = '';
  bulkCalls = [];
  opened = [];
  nextResults = (ids) => ids.map((id) => ({ id, ok: true }));
  document.body.innerHTML = '';
});

const press = (key: string, init: KeyboardEventInit = {}) =>
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, ...init }));
  });
const click = (el: Element, init: MouseEventInit = {}) =>
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init }));
  });
const text = () => document.body.textContent ?? '';
const rowCheckbox = (title: string) =>
  document.querySelector(`button[role="checkbox"][aria-label="Select ${title}"]`)!;
const option = (title: string) =>
  [...document.querySelectorAll('[role="option"]')].find((o) => o.textContent?.includes(title))!;
// The bar's actions are text buttons inside its button group.
const barButton = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('[data-slot="button-group"] button')].find(
    (b) => b.textContent?.trim() === label,
  ) ?? null;
const flush = () => act(async () => {});

describe('selecting rows', () => {
  test('a row checkbox selects without opening the item and starts select mode', () => {
    mount([call(1), call(2), OUTPUT]);
    click(rowCheckbox('Send report 1'));
    expect(search).toBe('');
    expect(text()).toContain('1 selected');
    expect(document.querySelector('[role="listbox"]')?.getAttribute('aria-multiselectable')).toBe(
      'true',
    );
    expect(option('Send report 1').getAttribute('aria-selected')).toBe('true');
  });

  test('shift-click selects the range from the last toggled row', () => {
    mount([call(1), call(2), call(3), call(4)]);
    click(rowCheckbox('Send report 1'));
    click(option('Send report 3'), { shiftKey: true });
    expect(text()).toContain('3 selected');
    expect(option('Send report 4').getAttribute('aria-selected')).toBe('false');
  });

  test('x toggles the focused row; Esc leaves select mode', () => {
    mount([call(1), call(2)]);
    press('x');
    expect(text()).toContain('1 selected');
    press('j');
    press('x');
    expect(text()).toContain('2 selected');
    press('Escape');
    expect(text()).not.toContain('selected');
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });

  test('switching lists drops the selection and the bar', () => {
    mount([call(1), call(2)]);
    press('x');
    press('2');
    press('1');
    expect(text()).not.toContain('selected');
  });

  test('the row menu Select enters select mode on that row (touch and Tab path)', () => {
    mount([call(1), call(2)]);
    const trigger = document.querySelector<HTMLButtonElement>(
      'button[aria-label="More actions for Send report 2"]',
    )!;
    act(() => {
      trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    });
    const item = [...document.querySelectorAll('[role="menuitem"]')].find((el) =>
      el.textContent?.startsWith('Select'),
    )!;
    click(item);
    expect(text()).toContain('1 selected');
    expect(option('Send report 2').getAttribute('aria-selected')).toBe('true');
    // Focus lands on the row, not on the unmounted menu trigger.
    expect(document.activeElement).toBe(option('Send report 2'));
  });

  test('in select mode j moves DOM focus to the next row', () => {
    mount([call(1), call(2)]);
    press('x');
    expect(document.activeElement).toBe(option('Send report 1'));
    press('j');
    expect(document.activeElement).toBe(option('Send report 2'));
  });

  test('the selection stops at 50', () => {
    mount(Array.from({ length: 52 }, (_, n) => call(n + 1)));
    click(rowCheckbox('Send report 1'));
    click(barButton('Select all')!);
    expect(text()).toContain('50 selected');
    expect(text()).toContain('Up to 50 at a time');
    // The list sorts by title, so "Send report 9" is the last row: past the cap.
    expect(option('Send report 9').getAttribute('aria-selected')).toBe('false');
    click(option('Send report 9'));
    expect(text()).toContain('50 selected');
    expect(option('Send report 9').getAttribute('aria-selected')).toBe('false');
  });

  test('a change request shows no checkbox', () => {
    const cr = { ...mockItem('rv-change-1'), id: 'cr:9' } as ReviewItem;
    mount([cr]);
    expect(document.querySelector('button[role="checkbox"]')).toBeNull();
  });
});

describe('the bar enables a verb only for rows that support it', () => {
  test('an output: Dismiss only', () => {
    mount([OUTPUT, call(1)]);
    click(rowCheckbox(OUTPUT.title));
    expect(barButton('Approve')?.disabled).toBe(true);
    expect(barButton('Deny')?.disabled).toBe(true);
    expect(barButton('Dismiss')?.disabled).toBe(false);
  });

  test('a connector approval: Approve and Deny, no Dismiss', () => {
    mount([OUTPUT, call(1)]);
    click(rowCheckbox('Send report 1'));
    expect(barButton('Approve')?.disabled).toBe(false);
    expect(barButton('Deny')?.disabled).toBe(false);
    expect(barButton('Dismiss')?.disabled).toBe(true);
  });
});

describe('bulk Approve', () => {
  test('confirms with each approval, its call and risk, then sends only approvable ids', async () => {
    nextResults = (ids) => ids.map((id) => ({ id, ok: id !== 'call:e2', code: 'expired' }));
    mount([call(1), call(2, 'high'), OUTPUT]);
    click(rowCheckbox('Send report 1'));
    click(option('Send report 2'));
    click(option(OUTPUT.title));
    click(barButton('Approve')!);
    const dialog = document.querySelector('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain('Approve 2 actions?');
    // Rows read the app and action, not the tool id.
    expect(dialog.textContent).toContain('Send email 1');
    expect(dialog.textContent).toContain('Send email 2');
    expect(dialog.textContent).not.toContain('gmail.send_email_1');
    // Each row's arguments, recipient first, the redacted field left out.
    expect(dialog.textContent).toContain('team · Weekly 1');
    expect(dialog.textContent).toContain('team · Weekly 2');
    expect(dialog.textContent).not.toContain('[redacted]');
    expect(dialog.textContent).toContain('High risk');
    expect(dialog.textContent).toContain('Low risk');
    expect(bulkCalls).toEqual([]);
    const confirm = [...dialog.querySelectorAll('button')].find(
      (b) => b.textContent === 'Approve 2',
    )!;
    click(confirm);
    await flush();
    expect(bulkCalls).toEqual(['approve call:e1,call:e2']);
    // Only the ok id leaves Needs you; the refused one stays, still selected.
    expect(text()).not.toContain('Send report 1');
    expect(text()).toContain('Send report 2');
    expect(text()).toContain('2 selected');
  });
});

describe('bulk Deny', () => {
  test('five or fewer: no confirm, sent as reject', async () => {
    mount([call(1), call(2)]);
    press('x');
    press('j');
    press('x');
    click(barButton('Deny')!);
    await flush();
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(bulkCalls).toEqual(['reject call:e1,call:e2']);
  });

  test('more than five: confirms first', () => {
    mount([1, 2, 3, 4, 5, 6].map((n) => call(n)));
    click(rowCheckbox('Send report 1'));
    click(barButton('Select all')!);
    click(barButton('Deny')!);
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(
      'Deny 6 actions?',
    );
    expect(bulkCalls).toEqual([]);
  });
});
