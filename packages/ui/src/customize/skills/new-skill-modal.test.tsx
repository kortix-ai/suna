import { afterAll, afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { configureKortix } from '@kortix/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const win = new Window();
const previous = new Map<string, PropertyDescriptor | undefined>();
for (const key of ['window', 'document', 'navigator', 'getComputedStyle', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'Node', 'NodeFilter', 'MutationObserver', 'Event', 'CustomEvent', 'FocusEvent', 'KeyboardEvent', 'MouseEvent', 'PointerEvent', 'IS_REACT_ACT_ENVIRONMENT']) {
  previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value: key === 'window' ? win : key === 'IS_REACT_ACT_ENVIRONMENT' ? true : key === 'getComputedStyle' ? win.getComputedStyle.bind(win) : Reflect.get(win, key),
  });
}
const { createRoot } = await import('react-dom/client');
const { NewSkillModal } = await import('./new-skill-modal');
let root: Root | undefined;
let client: QueryClient | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  client?.clear();
  document.body.innerHTML = '';
});
afterAll(() => {
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  configureKortix({ backendUrl: '', getToken: async () => null });
  void win.happyDOM.close();
});

for (const body of ['# Instructions\n\n  Keep Markdown indentation.\n', '']) {
  test(`create skill with ${body ? 'custom' : 'omitted'} body`, async () => {
    const requests: unknown[] = [];
    let closed = false;
    configureKortix({
      backendUrl: 'http://backend.test/v1',
      getToken: async () => 'synthetic-token',
      fetch: async (_input, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return Response.json({ ok: true, slug: 'notes', path: 'skills/notes/SKILL.md' }, { status: 201 });
      },
    });
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    client = queryClient;
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root?.render(
      <QueryClientProvider client={queryClient}>
        <NewSkillModal projectId="synthetic-project" open onOpenChange={(open) => { closed = !open; }} />
      </QueryClientProvider>,
    ));
    const name = document.querySelector('input');
    const content = document.querySelector('textarea');
    expect(content).not.toBeNull();
    if (!name || !content) throw new Error('Expected name and optional body fields');
    expect(content.required).toBe(false);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(name, 'Notes');
      name.dispatchEvent(new Event('input', { bubbles: true }));
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(content, body);
      content.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const form = document.querySelector('form');
    if (!form) throw new Error('Expected create form');
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(requests).toEqual([{ name: 'Notes', ...(body ? { body } : {}) }]);
    // React Query schedules its observer notification on the next task.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(closed).toBe(true);
    expect(content.value).toBe('');
  });
}
