import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

const browser = new Window({ url: 'http://localhost' });
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({
  window: browser, document: browser.document, navigator: browser.navigator,
  HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node,
  getComputedStyle: browser.getComputedStyle.bind(browser),
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { configurable: true, value });
}

const deleted: string[] = [];
const sdk = await import('@kortix/sdk');
mock.module('@kortix/sdk', () => ({
  ...sdk,
  deleteProjectSession: async (_projectId: string, sessionId: string) => {
    deleted.push(sessionId);
    return { ok: true };
  },
}));
// The dialog chrome is Radix's: render its confirm action only.
mock.module('../../primitives/confirm-dialog', () => ({
  ConfirmDialog: ({ onConfirm }: { onConfirm: () => void }) => (
    <button type="button" onClick={onConfirm}>
      confirm
    </button>
  ),
}));
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { SessionDeleteModal } = await import('./session-delete-modal');
const { TestUiHost } = await import('../../test-utils/ui-host');
const { IntlTestProvider } = await import('../../test-utils/intl');
const { defaultUiMessages } = await import('../../i18n');

const host = document.createElement('div');
document.body.append(host);
const root = createRoot(host);
afterEach(async () => {
  await act(async () => root.render(null));
  deleted.length = 0;
});
afterAll(async () => {
  await act(async () => root.unmount());
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

/** Opens the dialog for `target` on the page of session `open`, confirms, and returns the router pushes. */
async function confirmDelete(target: string, open: string, onDeleted?: () => void) {
  const pushes: string[] = [];
  const router = { push: (href: string) => pushes.push(href), replace() {}, prefetch() {}, back() {} };
  await act(async () =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <IntlTestProvider locale="en" messages={defaultUiMessages} onError={() => {}}>
          <TestUiHost params={{ id: 'p-1', sessionId: open }} router={router}>
            <SessionDeleteModal
              projectId="p-1"
              sessionId={target}
              sessionLabel="Synthetic session"
              open
              onOpenChange={() => {}}
              onDeleted={onDeleted}
            />
          </TestUiHost>
        </IntlTestProvider>
      </QueryClientProvider>,
    ),
  );
  const confirm = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'confirm');
  expect(confirm).toBeDefined();
  await act(async () => {
    confirm?.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(deleted).toEqual([target]);
  return pushes;
}

test('deleting the open session leaves its page for the project home', async () => {
  expect(await confirmDelete('s-open', 's-open')).toEqual(['/projects/p-1']);
});

test('deleting another session stays on the page', async () => {
  expect(await confirmDelete('s-other', 's-open')).toEqual([]);
});

test('a caller with onDeleted decides where to go', async () => {
  let called = 0;
  expect(await confirmDelete('s-open', 's-open', () => called++)).toEqual([]);
  expect(called).toBe(1);
});
