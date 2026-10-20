import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Keep the page, menu, modal and form real; replace only external data/auth/navigation.
const win = new Window();
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'CustomEvent', 'MutationObserver', 'HTMLInputElement', 'HTMLTextAreaElement', 'DocumentFragment', 'NodeFilter', 'HTMLButtonElement', 'MouseEvent', 'PointerEvent', 'getComputedStyle'] as const) {
  Object.defineProperty(globalThis, key, { value: key === 'window' ? win : key === 'getComputedStyle' ? win.getComputedStyle.bind(win) : win[key], configurable: true });
}
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
const push = mock(() => {});
const updateAgentConfig = mock(async () => ({ agent: 'server-agent' }));
const invalidateProject = mock(async () => {});
const start = mock(() => {});
let allowed = true;
let manifest = 'kortix_version: 2';
mock.module('next/navigation', () => ({ useRouter: () => ({ push }) }));
const sdk = await import('@kortix/sdk');
mock.module('@kortix/sdk', () => ({
  ...sdk,
  updateAgentConfig,
  getProjectDetail: async () => ({ config: { manifest_raw: manifest, agents: [] } }),
  listProjectTriggers: async () => ({ triggers: [] }),
  listProjectResourceGrants: async () => ({ grants: [] }),
  updateProjectDefaultAgent: mock(() => {}),
}));
mock.module('@kortix/sdk/react', () => ({
  invalidateProject,
  useProjectAccountId: () => 'account-test',
  contract: () => ({ staleTime: Infinity }),
  qk: { project: { detail: (id: string) => ['project-detail', id], triggers: (id: string) => ['triggers', id], resourceGrants: (id: string) => ['grants', id] } },
}));
mock.module('@/lib/use-project-can', () => ({ useProjectCan: () => ({ allowed }) }));
mock.module('@/features/workspace/customize/use-configure-thread', () => ({
  useConfigureThread: () => ({ pending: false, start }), newConfigPrompt: () => 'Create an agent',
}));
const { createRoot } = await import('react-dom/client');
const { AgentsPage } = await import('./agents-page');
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
let client: QueryClient;

beforeEach(() => {
  allowed = true;
  manifest = 'kortix_version: 2';
  for (const fn of [push, updateAgentConfig, invalidateProject, start]) fn.mockClear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  host.remove();
});
async function renderPage() {
  await act(async () => { root.render(<QueryClientProvider client={client}><AgentsPage projectId="project-test" /></QueryClientProvider>); });
  // Flush React Query's scheduled observer notification without a real-clock sleep.
  await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
}
async function openManual() {
  const trigger = Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'New');
  if (!trigger) throw new Error('Expected New menu trigger');
  await act(async () => { trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, ctrlKey: false })); });
  const manual = Array.from(document.querySelectorAll('[role="menuitem"]')).find((item) => item.textContent?.includes('Set up manually'));
  if (!manual) throw new Error('Expected Set up manually menu item');
  await act(async () => { manual.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); });
}

test('New → Set up manually opens a form, creates only, and navigates to the returned agent', async () => {
  await renderPage();
  await openManual();
  const dialog = document.querySelector('[role="dialog"]');
  expect(dialog).not.toBeNull();
  expect(push).not.toHaveBeenCalled();
  const name = dialog?.querySelector('input');
  const instructions = dialog?.querySelector('textarea');
  const form = dialog?.querySelector('form');
  if (!name || !instructions || !form) throw new Error('Manual menu must open the actual creation form, not Files');
  for (const [field, value] of [[name, 'new-agent'], [instructions, 'Reply pong.']] as const) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')?.set?.call(field, value);
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }
  await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  expect(updateAgentConfig).toHaveBeenCalledTimes(1);
  expect(updateAgentConfig).toHaveBeenCalledWith('project-test', 'new-agent', { behavior: { mode: 'primary', prompt: 'Reply pong.' } }, { createOnly: true });
  expect(invalidateProject).toHaveBeenCalledWith(client, 'project-test');
  expect(push).toHaveBeenCalledWith('/projects/project-test/customize/agents/server-agent');
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(start).not.toHaveBeenCalled();
});

test('read-only members get neither header nor empty-state create controls', async () => {
  allowed = false;
  await renderPage();
  expect(host.textContent).toContain('No agents');
  expect(host.querySelector('[aria-haspopup="menu"]')).toBeNull();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(updateAgentConfig).not.toHaveBeenCalled();
});

test('v1 manual setup explains the required upgrade instead of submitting an agent', async () => {
  manifest = 'kortix_version = 1';
  await renderPage();
  await openManual();
  const dialog = document.querySelector('[role="dialog"]');
  expect(dialog).not.toBeNull();
  expect(dialog?.textContent).toContain('Upgrade');
  expect(dialog?.querySelector('form')).toBeNull();
  expect(updateAgentConfig).not.toHaveBeenCalled();
  expect(push).not.toHaveBeenCalled();
});
