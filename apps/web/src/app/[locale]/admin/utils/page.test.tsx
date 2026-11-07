import { afterEach, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const win = new Window({ url: 'http://localhost:13000/admin/utils' });
Object.defineProperties(globalThis, {
  window: { value: win, configurable: true },
  document: { value: win.document, configurable: true },
  navigator: { value: win.navigator, configurable: true },
  HTMLElement: { value: win.HTMLElement, configurable: true },
  Element: { value: win.Element, configurable: true },
  getComputedStyle: { value: win.getComputedStyle.bind(win), configurable: true },
  MutationObserver: { value: win.MutationObserver, configurable: true },
  HTMLInputElement: { value: win.HTMLInputElement, configurable: true },
  Event: { value: win.Event, configurable: true },
  CustomEvent: { value: win.CustomEvent, configurable: true },
  NodeFilter: { value: win.NodeFilter, configurable: true },
  Node: { value: win.Node, configurable: true },
  IS_REACT_ACT_ENVIRONMENT: { value: true, configurable: true },
});

// The page and form stay real; only the surrounding admin layout is omitted.
mock.module('../_components/admin-page-shell', () => ({
  AdminPageShell: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}));
const { createRoot } = await import('react-dom/client');
const { default: AdminUtilsPage } = await import('./page');
const originalFetch = globalThis.fetch;
const host = document.createElement('div');
document.body.append(host);
const root = createRoot(host);
const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
const initial = { level: 'warning', title: 'Warning banner', message: 'Scheduled work', startTime: null, endTime: null, statusUrl: null, affectedServices: [] };

async function click(text: string) {
  const button = Array.from(document.querySelectorAll('button')).find((el) => el.textContent?.includes(text));
  if (!button) throw new Error(`Missing button: ${text}`);
  await act(async () => { button.click(); });
}

async function edit(id: string, value: string) {
  const field = win.document.getElementById(id);
  if (!(field instanceof win.HTMLInputElement || field instanceof win.HTMLTextAreaElement)) throw new Error(`Missing field: ${id}`);
  await act(async () => {
    const prototype = field instanceof win.HTMLTextAreaElement ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(field, value);
    field.dispatchEvent(new win.Event('input', { bubbles: true }));
  });
}

afterEach(async () => {
  await act(async () => root.render(null));
  client.clear();
  globalThis.fetch = originalFetch;
});

test('maintenance edits, replacement config, active payload, failed save and none reset', async () => {
  const writes: unknown[] = [];
  let fail = false;
  globalThis.fetch = Object.assign(async (_input: URL | RequestInfo, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      const body = JSON.parse(String(init.body));
      writes.push(body);
      return Response.json(fail ? { error: 'Synthetic save failure' } : body, { status: fail ? 500 : 200 });
    }
    return Response.json(initial);
  }, { preconnect: originalFetch.preconnect });
  client.setQueryData(['admin-maintenance-config'], initial);
  await act(async () => root.render(<QueryClientProvider client={client}><AdminUtilsPage /></QueryClientProvider>));
  await click('Critical banner');
  expect(document.getElementById('m-title')?.getAttribute('value') ?? document.getElementById('m-title')?.outerHTML).toContain('Critical banner');
  await edit('m-message', 'Synthetic outage');
  await edit('m-status-url', 'https://status.example.test');
  const service = win.document.querySelector('button[role=checkbox]');
  if (!(service instanceof win.HTMLElement)) throw new Error('Missing service checkbox');
  await act(async () => { service.click(); });
  await click('Activate');
  expect(writes.at(-1)).toEqual({ affectedServices: ['Agent Runner'], level: 'critical', title: 'Critical banner', message: 'Synthetic outage', startTime: null, endTime: null, statusUrl: 'https://status.example.test' });
  await act(async () => { await new Promise<void>((resolve) => queueMicrotask(resolve)); });
  await act(async () => client.setQueryData(['admin-maintenance-config'], { ...initial, title: 'Custom title', message: 'Replacement' }));
  await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
  await click('Info banner');
  expect(document.getElementById('m-title')?.outerHTML).toContain('Custom title');
  await click('Activate');
  expect(writes.at(-1)).toEqual({ level: 'info', title: 'Custom title', message: 'Replacement', startTime: null, endTime: null, statusUrl: null });
  await click('Info banner');
  fail = true;
  await click('Activate');
  expect(document.getElementById('m-message')).not.toBeNull();
  fail = false;
  await click('Cancel');
  await click('Off');
  await click('Clear notifications');
  expect(writes.at(-1)).toEqual({ level: 'none', title: '', message: '', startTime: null, endTime: null, statusUrl: null, affectedServices: [] });
});
