/**
 * The Review Center offers a verdict only to a viewer whose leaves the
 * verdict's route asserts (KRTX-1720, `reviewVerdictAllowed` in `@kortix/sdk`).
 *
 * The defect this pins: the live inbox withheld its act handlers from a viewer
 * without `project.review.act`. That switched the inbox into its prototype
 * mode, which still drew every verdict control and "applied" each one locally:
 * the item moved to Done, a success toast showed, and no request was sent. The
 * next poll put it back. Ship it showed to a merge-only role the same way. The
 * inbox now stays live, and each control and shortcut reads the shared rule.
 *
 * Runs the real inbox against `happy-dom`, the pattern of
 * `features/changes/diff-layout-toggle.test.tsx`.
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
/** A native output. */
const OUTPUT = mockItem('rv-output-1');
/** A change request: a `cr:` id merges through its own route. No `crId`, so no diff query. */
const CHANGE = { ...mockItem('rv-change-1'), id: 'cr:42' } as ReviewItem;
const CONFLICTED = { ...mockItem('rv-change-conflict'), id: 'cr:43' } as ReviewItem;

const { PROJECT_WRITE, PROJECT_GITOPS_PUSH, PROJECT_GITOPS_MERGE, PROJECT_REVIEW_ACT } =
  PROJECT_ACTIONS;
type Leaves = Record<string, { allowed: boolean }>;
const leaves = (...granted: string[]): Leaves =>
  Object.fromEntries(granted.map((leaf) => [leaf, { allowed: true }]));
/** A built-in member: review.read + review.submit, none of the verdict leaves. */
const MEMBER = leaves();
const MANAGER = leaves(
  PROJECT_WRITE,
  PROJECT_GITOPS_PUSH,
  PROJECT_GITOPS_MERGE,
  PROJECT_REVIEW_ACT,
);
/** A custom role that reviews and does not merge. */
const REVIEWER = leaves(PROJECT_WRITE, PROJECT_REVIEW_ACT);
/** A custom role that merges and does not review: gitops.merge implies no review.act. */
const MERGER = leaves(PROJECT_WRITE, PROJECT_GITOPS_MERGE);

let root: Root | null = null;
let host: HTMLElement | null = null;
const calls: string[] = [];

function mount(items: ReviewItem[], cans: Leaves) {
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
            onAct={(id, verdict) => calls.push(`act ${id} ${verdict}`)}
            onBulkAct={(ids, verdict) => calls.push(`bulk ${ids.join(',')} ${verdict}`)}
            verdictAllowed={(item, verdict) => reviewVerdictAllowed(item, verdict, cans)}
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
  calls.length = 0;
  document.body.innerHTML = '';
});

const press = (key: string) =>
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key }));
  });
/** The visible label of every enabled button on the page. */
const buttons = () =>
  [...document.querySelectorAll('button')]
    .filter((button) => !button.disabled)
    .map((button) => button.textContent?.trim() ?? '');
const text = () => document.body.textContent ?? '';

describe('the inbox shortcuts a, e and d', () => {
  test('a built-in member: no shortcut commits a verdict or calls a route', () => {
    mount([OUTPUT], MEMBER);
    for (const key of ['a', 'e', 'd']) press(key);
    expect(calls).toEqual([]);
    // Still waiting on someone in Needs you: nothing moved it to Done.
    expect(text()).toContain(OUTPUT.title);
  });

  test('a manager: d dismisses through the bulk route', () => {
    mount([OUTPUT], MANAGER);
    press('d');
    expect(calls).toEqual([`bulk ${OUTPUT.id} dismiss`]);
    expect(text()).not.toContain(OUTPUT.title);
  });
});

describe('the row menu', () => {
  /** Opens the ⋯ menu of the first row and returns its item labels. */
  function openRowMenu(): string[] {
    const trigger = document.querySelector<HTMLButtonElement>(
      `button[aria-label="More actions for ${OUTPUT.title}"]`,
    )!;
    act(() => {
      trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    });
    return [...document.querySelectorAll('[role="menuitem"]')].map(
      (item) => item.textContent?.replace(/[ed↵]$/, '').trim() ?? '',
    );
  }

  test('a built-in member gets Open, and no Ask for changes and no Dismiss', () => {
    mount([OUTPUT], MEMBER);
    const labels = openRowMenu();
    expect(labels).toContain('Open');
    expect(labels).not.toContain('Ask for changes');
    expect(labels).not.toContain('Dismiss');
  });

  test('a manager gets Ask for changes and Dismiss', () => {
    mount([OUTPUT], MANAGER);
    const labels = openRowMenu();
    expect(labels).toContain('Ask for changes');
    expect(labels).toContain('Dismiss');
  });
});

describe('the review page of one item', () => {
  test('a built-in member gets no verdict on a native output', () => {
    search = `id=${OUTPUT.id}`;
    mount([OUTPUT], MEMBER);
    expect(text()).toContain(OUTPUT.title);
    expect(buttons()).not.toContain('Approve & publish');
    expect(buttons()).not.toContain('Request changes');
  });

  test('a manager gets both verdicts on a native output', () => {
    search = `id=${OUTPUT.id}`;
    mount([OUTPUT], MANAGER);
    expect(buttons()).toContain('Approve & publish');
    expect(buttons()).toContain('Request changes');
  });

  test('a merge-only role gets Ship it and no Ask for changes on a change request', () => {
    search = `id=${CHANGE.id}`;
    mount([CHANGE], MERGER);
    expect(buttons()).toContain('Ship it');
    expect(buttons()).not.toContain('Ask for changes');
  });

  test('a reviewer gets Ask for changes and no Ship it on a change request', () => {
    search = `id=${CHANGE.id}`;
    mount([CHANGE], REVIEWER);
    expect(buttons()).toContain('Ask for changes');
    expect(buttons()).not.toContain('Ship it');
  });

  test('a built-in member gets neither on a change request', () => {
    search = `id=${CHANGE.id}`;
    mount([CHANGE], MEMBER);
    expect(buttons()).not.toContain('Ask for changes');
    expect(buttons()).not.toContain('Ship it');
  });

  // A connector call: the API lets a project manager or the session's launcher
  // decide it, and sends only them the call's arguments (`previewAuthorized`).
  const call = (previewAuthorized: boolean) =>
    ({
      ...mockItem('rv-approval-1'),
      id: 'call:exec-1',
      detail: {
        actions: [
          {
            id: 'exec-1',
            title: 'Send an email',
            connector: 'mail',
            action: 'send',
            consequence: 'Sends one email.',
            risk: 'medium',
            icon: 'email',
            argsPreview: previewAuthorized ? [{ key: 'subject', value: 'Weekly report' }] : [],
            actionPath: 'mail.send',
            rawArgsPreview: previewAuthorized ? { subject: 'Weekly report' } : undefined,
            reviewComplete: previewAuthorized,
            previewAuthorized,
            policySource: 'project policy',
          },
        ],
      },
    }) as ReviewItem;

  test('a connector call shows Approve and Deny to the viewer the API lets decide it, whatever leaves they hold', () => {
    search = 'id=call:exec-1';
    mount([call(true)], MEMBER);
    expect(buttons()).toContain('Approve this call');
    expect(buttons()).toContain('Deny');
  });

  test('a connector call the API withholds from this viewer shows no decision, even to a manager', () => {
    search = 'id=call:exec-1';
    mount([call(false)], MANAGER);
    expect(buttons()).not.toContain('Approve this call');
    expect(buttons()).not.toContain('Deny');
  });

  // KRTX-1724: the API says per call who may decide (`can_resolve`), and a
  // viewer it refuses finds the call under Waiting, still pending.
  test('a waiting call says who decides, and offers no decision', () => {
    search = 'id=call:exec-1';
    const waiting = { ...call(false), status: 'waiting' } as ReviewItem;
    (waiting.detail as { actions: Array<{ canResolve?: boolean }> }).actions[0].canResolve = false;
    mount([waiting], MANAGER);
    expect(buttons()).not.toContain('Approve this call');
    expect(buttons()).not.toContain('Deny');
    expect(text()).toContain(
      'Waiting for the person who started this session or anyone who manages this project to approve or deny it.',
    );
    expect(text()).not.toContain('Approved');
    // The dialog's screen-reader title and description say the same: no
    // request for a decision this viewer cannot make.
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).not.toContain('An agent needs your approval');
    expect(dialog?.textContent).not.toContain('Your decision applies to this call only.');
    const labelledBy = dialog?.getAttribute('aria-labelledby');
    expect(labelledBy ? document.getElementById(labelledBy)?.textContent : null).toBe(
      'Needs approval',
    );
  });

  test('a call in a session started with an API token: managers decide, the launcher is not named', () => {
    search = 'id=call:exec-1';
    const waiting = { ...call(false), status: 'waiting' } as ReviewItem;
    const action = (
      waiting.detail as {
        actions: Array<{ canResolve?: boolean; resolvers?: 'managers' | 'managers_and_launcher' }>;
      }
    ).actions[0];
    action.canResolve = false;
    action.resolvers = 'managers';
    mount([waiting], MEMBER);
    expect(text()).toContain('Waiting for anyone who manages this project to approve or deny it.');
    expect(text()).not.toContain('the person who started this session');
  });

  test('a resolver still gets the decision request, in the dialog title too', () => {
    search = 'id=call:exec-1';
    mount([call(true)], MEMBER);
    const dialog = document.querySelector('[role="dialog"]');
    const labelledBy = dialog?.getAttribute('aria-labelledby');
    expect(labelledBy ? document.getElementById(labelledBy)?.textContent : null).toBe(
      'An agent needs your approval',
    );
  });

  // Resolving the conflicts stands in for Ship it, the same rule as mobile.
  test('a conflicted change offers the conflict fix only to a viewer who may merge', () => {
    search = `id=${CONFLICTED.id}`;
    mount([CONFLICTED], REVIEWER);
    expect(buttons()).not.toContain('Solve with agent');
    expect(buttons()).toContain('Ask for changes');
    act(() => root?.unmount());
    document.body.innerHTML = '';
    mount([CONFLICTED], MANAGER);
    expect(buttons()).toContain('Solve with agent');
  });
});

describe('a pending approval row', () => {
  const APPROVAL = mockItem('rv-approval-1');
  const expiringIn = (ms: number) =>
    ({ ...APPROVAL, expiresAt: new Date(Date.now() + ms).toISOString() }) as ReviewItem;
  const expiryLabel = () =>
    [...document.querySelectorAll('span')].find((span) =>
      span.textContent?.startsWith('Expires in'),
    );

  /** The orange glyph in the row's meta line, beside the label. */
  const warningGlyph = () =>
    [...(expiryLabel()?.parentElement?.querySelectorAll('svg') ?? [])].find((svg) =>
      svg.getAttribute('class')?.includes('text-kortix-orange'),
    );

  test('says how long it can still be decided', () => {
    mount([expiringIn(3 * 3_600_000 + 60_000)], MANAGER);
    expect(expiryLabel()?.textContent).toBe('Expires in 3h');
    expect(warningGlyph()).toBeUndefined();
  });

  test('under one hour a warning clock leads it; the text stays muted', () => {
    // Half a minute of slack: the label floors, and the render takes time.
    mount([expiringIn(30 * 60_000 + 30_000)], MANAGER);
    expect(expiryLabel()?.textContent).toBe('Expires in 30m');
    // An accent paints a glyph, never text (kortix-brand color.md).
    expect(expiryLabel()?.className).not.toContain('text-kortix-orange');
    expect(warningGlyph()?.nextElementSibling).toBe(expiryLabel());
  });

  test('an approval with no expiry shows no label', () => {
    mount([APPROVAL], MANAGER);
    expect(expiryLabel()).toBeUndefined();
  });
});
