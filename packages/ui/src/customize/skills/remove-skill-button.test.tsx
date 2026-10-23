import { afterAll, afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { configureKortix } from '@kortix/sdk';
import { qk } from '@kortix/sdk/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const win = new Window();
const previous = new Map<string, PropertyDescriptor | undefined>();
for (const key of ['window', 'document', 'navigator', 'getComputedStyle', 'HTMLElement', 'HTMLButtonElement', 'Node', 'NodeFilter', 'MutationObserver', 'Event', 'CustomEvent', 'FocusEvent', 'KeyboardEvent', 'MouseEvent', 'PointerEvent', 'IS_REACT_ACT_ENVIRONMENT']) {
  previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value: key === 'window' ? win : key === 'IS_REACT_ACT_ENVIRONMENT' ? true : key === 'getComputedStyle' ? win.getComputedStyle.bind(win) : Reflect.get(win, key),
  });
}
const { createRoot } = await import('react-dom/client');
const { RemoveSkillButton, removableSkillFolder } = await import('./remove-skill-button');
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

test('removableSkillFolder: the folder of a project skill; null for a platform kortix-* skill', () => {
  expect(removableSkillFolder('skills/notes/SKILL.md')).toBe('skills/notes');
  expect(removableSkillFolder('.kortix/skills/notes/SKILL.md')).toBe('.kortix/skills/notes');
  expect(removableSkillFolder('skills/kortix-browser/SKILL.md')).toBeNull();
  expect(removableSkillFolder('SKILL.md')).toBeNull();
});

const buttons = (label: string) =>
  [...document.querySelectorAll('button')].filter((button) => button.textContent?.trim() === label);

test('Remove asks first, then POSTs the folder with confirm and refetches the project config', async () => {
  const requests: Array<{ url: string; body: unknown }> = [];
  configureKortix({
    backendUrl: 'http://backend.test/v1',
    getToken: async () => 'synthetic-token',
    fetch: async (input, init) => {
      requests.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return Response.json({ ok: true, commitSha: 'abc123', removed: ['skills/notes/SKILL.md'] });
    },
  });
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  client = queryClient;
  queryClient.setQueryData(qk.project.detail('synthetic-project'), { config: { skills: [] } });
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root?.render(
    <QueryClientProvider client={queryClient}>
      <RemoveSkillButton projectId="synthetic-project" name="Notes" folder="skills/notes" />
    </QueryClientProvider>,
  ));

  const trigger = buttons('Remove')[0];
  if (!trigger) throw new Error('Expected the Remove button');
  await act(async () => trigger.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  // The click only opens the confirmation: nothing is sent yet.
  expect(requests).toEqual([]);
  expect(document.body.textContent).toContain('Remove Notes?');
  expect(document.body.textContent).toContain('skills/notes');

  const confirm = buttons('Remove skill')[0];
  if (!confirm) throw new Error('Expected the Remove skill confirmation');
  await act(async () => confirm.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

  expect(requests).toEqual([
    { url: 'http://backend.test/v1/projects/synthetic-project/skills/remove', body: { folder: 'skills/notes', confirm: true } },
  ]);
  expect(queryClient.getQueryState(qk.project.detail('synthetic-project'))?.isInvalidated).toBe(true);
});
