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
let usePanel: typeof import('./artifact-discussion-layout').useArtifactDiscussionPanel;
let minSize: typeof import('./artifact-discussion-layout').discussionPanelMinSize;
const host = browser.document.createElement('div');
browser.document.body.append(host);
const root = createRoot(host as unknown as HTMLElement);
const closeChanges: boolean[] = [];
beforeAll(async () => {
  const layout = await import('./artifact-discussion-layout');
  Layout = layout.ArtifactDiscussionLayout;
  usePanel = layout.useArtifactDiscussionPanel;
  minSize = layout.discussionPanelMinSize;
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
function Discussion() {
  const panel = usePanel();
  return (
    <div data-artifact-discussion-header data-mode={panel.mode}>
      <button type="button">Comments</button>
      {panel.close ? (
        <button type="button" onClick={panel.close}>
          {panel.closeLabel}
        </button>
      ) : null}
    </div>
  );
}
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
        discussion={<Discussion />}
      >
        <p data-artifact>Artifact</p>
      </Layout>,
    ),
  );
}

test('an embedded discussion is a non-modal sheet: the artifact stays interactive, Close and Escape close it', async () => {
  await withDiscussion(true);
  expect(browser.document.querySelector('[role="dialog"]')).toBeNull();
  const panel = host.querySelector('[data-slot="split-sheet-content"]')!;
  expect(panel.getAttribute('aria-label')).toBe('Discussion');
  expect(panel.querySelector('[data-artifact-discussion-header]')).not.toBeNull();
  const artifact = host.querySelector('[data-artifact]')!;
  expect(artifact.closest('[inert]')).toBeNull();
  expect(artifact.closest('[aria-hidden="true"]')).toBeNull();
  const close = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Close');
  expect(close).toBeDefined();
  await act(async () => close!.click());
  expect(closeChanges).toEqual([false]);
  await act(async () => {
    panel
      .querySelector('button')!
      .dispatchEvent(new browser.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  expect(closeChanges).toEqual([false, false]);
});

test('a narrow standalone discussion uses the same sheet', async () => {
  narrow = true;
  await withDiscussion(false);
  expect(host.querySelector('[data-slot="split-sheet-content"] [data-mode="split"]')).not.toBeNull();
});

test('a wide docked discussion has no close action inside it and no sheet', async () => {
  await withDiscussion(false);
  expect(host.querySelector('[data-slot="split-sheet-content"]')).toBeNull();
  expect(host.querySelector('aside [data-mode="docked"]')).not.toBeNull();
  expect([...host.querySelectorAll('button')].some((button) => button.textContent === 'Close')).toBe(
    false,
  );
});

test('the docked panel keeps 320 px within its 22–45% bounds', () => {
  expect(minSize(0)).toBe(22);
  expect(minSize(1440)).toBeCloseTo(22.22, 2);
  expect(minSize(1024)).toBe(31.25);
  expect(minSize(600)).toBe(45);
});
