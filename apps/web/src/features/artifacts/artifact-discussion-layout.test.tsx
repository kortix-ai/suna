import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

const browser = new Window({ url: 'http://localhost' });
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
  HTMLElement: browser.HTMLElement,
  HTMLInputElement: browser.HTMLInputElement,
  HTMLButtonElement: browser.HTMLButtonElement,
  Element: browser.Element,
  Node: browser.Node,
  NodeFilter: browser.NodeFilter,
  DocumentFragment: browser.DocumentFragment,
  MutationObserver: browser.MutationObserver,
  CustomEvent: browser.CustomEvent,
  KeyboardEvent: browser.KeyboardEvent,
  getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
})) {
  originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { configurable: true, value });
}
let narrow = false;
const matchMedia = browser.matchMedia.bind(browser);
browser.matchMedia = (query: string) => {
  const media = matchMedia(query);
  Object.defineProperty(media, 'matches', { get: () => narrow && query === '(max-width: 1023px)' });
  return media;
};
let Layout: typeof import('./artifact-discussion-layout').ArtifactDiscussionLayout;
const host = browser.document.createElement('div');
browser.document.body.append(host);
const root = createRoot(host as unknown as HTMLElement);
const closeChanges: boolean[] = [];
beforeAll(async () => {
  Layout = (await import('./artifact-discussion-layout')).ArtifactDiscussionLayout;
});
afterEach(async () => {
  await act(async () => root.render(null));
  narrow = false;
  closeChanges.length = 0;
});
afterAll(async () => {
  await act(async () => root.unmount());
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});
const discussion = (
  <div data-artifact-discussion-header>
    <button type="button">Comments</button>
    <button type="button">Activity</button>
  </div>
);
async function withDiscussion(embedded: boolean) {
  await act(async () =>
    root.render(
      <Layout
        embedded={embedded}
        open
        onOpenChange={(open) => closeChanges.push(open)}
        title="Discussion"
        closeLabel="Close"
        resizeLabel="Resize discussion"
        discussion={discussion}
      >
        <p>Artifact</p>
      </Layout>,
    ),
  );
}

test('embedded discussion reserves a close-button lane only in its overlay header and keeps native Close working', async () => {
  await withDiscussion(true);
  const header = browser.document.querySelector(
    '[role="dialog"] [data-artifact-discussion-header]',
  );
  expect(header).not.toBeNull();
  expect(
    header!.parentElement!.classList.contains('[&_[data-artifact-discussion-header]]:pr-14'),
  ).toBe(true);
  const close = [...browser.document.querySelectorAll('button')].find(
    (button) => button.textContent === 'Close',
  );
  expect(close).toBeDefined();
  await act(async () => close!.click());
  expect(closeChanges).toEqual([false]);
});

test('a narrow standalone discussion uses the same overlay header reservation', async () => {
  narrow = true;
  await withDiscussion(false);
  const header = browser.document.querySelector(
    '[role="dialog"] [data-artifact-discussion-header]',
  );
  expect(header).not.toBeNull();
  expect(
    header!.parentElement!.classList.contains('[&_[data-artifact-discussion-header]]:pr-14'),
  ).toBe(true);
});

test('a wide docked discussion retains its full-width tabs without overlay-only padding', async () => {
  await withDiscussion(false);
  expect(browser.document.querySelector('[role="dialog"]')).toBeNull();
  expect(host.querySelector('aside [data-artifact-discussion-header]')).not.toBeNull();
  expect(host.innerHTML).not.toContain('[&amp;_[data-artifact-discussion-header]]:pr-14');
});
