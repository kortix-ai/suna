import { afterAll, afterEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const win = new Window();
const globals = {
  window: win, document: win.document, navigator: win.navigator,
  HTMLElement: win.HTMLElement, HTMLInputElement: win.HTMLInputElement,
  Element: win.Element, Node: win.Node, NodeFilter: win.NodeFilter,
  MutationObserver: win.MutationObserver, CustomEvent: win.CustomEvent,
  getComputedStyle: win.getComputedStyle.bind(win),
  requestAnimationFrame: win.requestAnimationFrame.bind(win),
  cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const descriptors = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
const { SetupLinkButton } = await import('./setup-link-button');
const originalFetch = globalThis.fetch;
let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.innerHTML = '';
  globalThis.fetch = originalFetch;
});
afterAll(() => {
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  win.happyDOM.abort();
});

test.each(['connector', 'runtime', undefined] as const)('secret modal makes no unconditional privacy promise for %s delivery', async scope => {
  globalThis.fetch = Object.assign(async () => Response.json({
    project_name: 'Synthetic project', fields: [{ name: 'DEMO_KEY', label: null, description: null }],
    expires_at: '2099-01-01T00:00:00Z', scope,
  }), { preconnect: originalFetch.preconnect });
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root?.render(<SetupLinkButton kind="secret" token="synthetic-token">Add secret</SetupLinkButton>));
  const button = container.querySelector('button');
  expect(button).not.toBeNull();
  await act(async () => button?.click());
  const dialog = document.querySelector('[role="dialog"]');
  expect(dialog).not.toBeNull();
  expect(dialog?.textContent).toContain('Add a project secret');
  expect(dialog?.textContent).toContain('DEMO_KEY');
  expect(dialog?.textContent).not.toContain('never sees the value');
  expect(dialog?.textContent).toContain(scope ? `Delivery: ${scope}` : 'Delivery scope is unavailable');
  if (scope === 'runtime') expect(dialog?.textContent).toContain('Agent code can read it');
  if (scope === 'connector') expect(dialog?.textContent).toContain('never enters the sandbox environment');
});
