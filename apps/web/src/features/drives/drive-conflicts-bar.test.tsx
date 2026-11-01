import { afterEach, expect, jest, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { NextIntlClientProvider } from 'next-intl';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import messages from '../../../translations/en.json';

const win = new Window();
for (const key of [
  'window',
  'document',
  'navigator',
  'customElements',
  'HTMLElement',
  'Element',
  'Node',
  'MutationObserver',
  'CustomEvent',
  'Event',
  'MouseEvent',
  'PointerEvent',
  'FocusEvent',
  'KeyboardEvent',
  'NodeFilter',
  'HTMLInputElement',
]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: Reflect.get(win, key) });
}
Object.defineProperty(globalThis, 'getComputedStyle', {
  configurable: true,
  value: win.getComputedStyle.bind(win),
});
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
const conflict = {
  conflictId: 'synthetic-conflict',
  path: '/Shared/report.txt',
  detectedAt: '2026-10-01T00:00:00Z',
};
let entries = [conflict];
const dismiss = mock((_input: { driveId: string; conflictId: string }, _options: unknown) => {});
const files = await import('@kortix/ui/files');
mock.module('@kortix/ui/files', () => ({
  ...files,
  useDriveConflicts: () => ({ data: entries }),
  useDismissDriveConflict: () => ({ mutate: dismiss, isPending: false }),
}));
const { DriveConflictsBar } = await import('./drive-conflicts-bar');
const host = document.createElement('div');
document.body.append(host);
const root = createRoot(host);
const openFolder = mock(() => {});

async function mount() {
  await act(async () =>
    root.render(
      <NextIntlClientProvider
        locale="en"
        timeZone="UTC"
        messages={messages}
        now={new Date('2026-10-01T01:00:00Z')}
      >
        <DriveConflictsBar driveId="synthetic-drive" onOpenFolder={openFolder} />
      </NextIntlClientProvider>,
    ),
  );
}
function trigger() {
  const button = host.querySelector<HTMLButtonElement>('button[aria-expanded]');
  if (!button) throw new Error('Missing conflict trigger');
  return button;
}
function button(label: string) {
  const match = Array.from(document.querySelectorAll('button')).find(
    (node) => node.textContent === label,
  );
  if (!match) throw new Error(`Missing ${label}`);
  return match;
}
afterEach(async () => {
  await act(async () => root.render(null));
  entries = [conflict];
  dismiss.mockClear();
  openFolder.mockClear();
});

test('hover leaves the conflict details closed and the trigger unchanged', async () => {
  await mount();
  const before = trigger().outerHTML;
  await act(async () => trigger().dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
  expect(trigger().getAttribute('aria-expanded')).toBe('false');
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(trigger().outerHTML).toBe(before);
});

test('click opens an accessible popover, actions retain their inputs, and Escape restores focus', async () => {
  await mount();
  await act(async () => trigger().click());
  expect(trigger().getAttribute('aria-expanded')).toBe('true');
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('report.txt');
  await act(async () => button('Open folder').click());
  expect(openFolder).toHaveBeenCalledWith('/Shared');
  await act(async () => button('Dismiss').click());
  expect(dismiss.mock.calls[0]?.[0]).toEqual({
    driveId: 'synthetic-drive',
    conflictId: conflict.conflictId,
  });
  await act(async () =>
    document.activeElement?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    ),
  );
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(trigger());
});

test('outside pointer closes the popover', async () => {
  jest.useFakeTimers();
  await mount();
  await act(async () => trigger().click());
  await act(async () => jest.advanceTimersByTime(1));
  await act(async () => {
    document.body.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }),
    );
    document.body.click();
  });
  expect(trigger().getAttribute('aria-expanded')).toBe('false');
  jest.useRealTimers();
});

test('no conflicts renders no control', async () => {
  entries = [];
  await mount();
  expect(host.textContent).toBe('');
  expect(host.querySelector('button')).toBeNull();
});
