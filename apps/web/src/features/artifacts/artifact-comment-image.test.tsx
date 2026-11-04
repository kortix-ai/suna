import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';

const page = new Window({ url: 'http://localhost' });
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({
  window: page,
  document: page.document,
  navigator: page.navigator,
  HTMLElement: page.HTMLElement,
  HTMLInputElement: page.HTMLInputElement,
  HTMLButtonElement: page.HTMLButtonElement,
  Element: page.Element,
  Node: page.Node,
  NodeFilter: page.NodeFilter,
  DocumentFragment: page.DocumentFragment,
  MutationObserver: page.MutationObserver,
  CustomEvent: page.CustomEvent,
  KeyboardEvent: page.KeyboardEvent,
  PointerEvent: page.PointerEvent,
  getComputedStyle: page.getComputedStyle.bind(page),
  requestAnimationFrame: page.requestAnimationFrame.bind(page),
  cancelAnimationFrame: page.cancelAnimationFrame.bind(page),
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
let Image: typeof import('./artifact-comment-image').ArtifactCommentImage;
const host = page.document.createElement('div');
page.document.body.append(host);
const root = createRoot(host as unknown as Element);
const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;
const created: Blob[] = [];
const revoked: string[] = [];
beforeAll(async () => {
  URL.createObjectURL = (blob) => {
    created.push(blob as Blob);
    return `blob:owned-${created.length}`;
  };
  URL.revokeObjectURL = (url) => {
    revoked.push(url);
  };
  Image = (await import('./artifact-comment-image')).ArtifactCommentImage;
});
afterEach(async () => {
  await act(async () => root.render(null));
});
afterAll(async () => {
  await act(async () => root.unmount());
  await page.happyDOM.close();
  URL.createObjectURL = originalCreate;
  URL.revokeObjectURL = originalRevoke;
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});
test('a screenshot changes its object URL with its Blob and revokes each owned URL on removal', async () => {
  const first = new Blob(['first'], { type: 'image/png' });
  const second = new Blob(['second'], { type: 'image/webp' });
  await act(async () => root.render(createElement(Image, { image: first })));
  expect(host.querySelector('img')?.getAttribute('src')).toBe('blob:owned-1');
  await act(async () => root.render(createElement(Image, { image: second })));
  expect(host.querySelector('img')?.getAttribute('src')).toBe('blob:owned-2');
  expect(revoked).toEqual(['blob:owned-1']);
  await act(async () => root.render(createElement(Image, { image: undefined })));
  expect(host.querySelector('img')).toBeNull();
  expect(revoked).toEqual(['blob:owned-1', 'blob:owned-2']);
  expect(created).toEqual([first, second]);
});
