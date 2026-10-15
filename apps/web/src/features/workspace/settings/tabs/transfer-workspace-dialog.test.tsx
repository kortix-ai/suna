import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const win = new Window({ width: 1440, height: 900 });
const globals = globalThis as Record<string, unknown>;
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
globals.window = win;
globals.document = win.document;
globals.navigator = win.navigator;
globals.Event = win.Event;
globals.CustomEvent = win.CustomEvent;
globals.getComputedStyle = win.getComputedStyle.bind(win);
globals.requestAnimationFrame = win.requestAnimationFrame.bind(win);
globals.cancelAnimationFrame = win.cancelAnimationFrame.bind(win);
for (const key of Object.getOwnPropertyNames(win)) {
  if (/^[A-Z]/.test(key) && !(key in globals)) globals[key] = Reflect.get(win, key);
}
// Radix uses layout APIs that happy-dom does not implement.
win.HTMLElement.prototype.scrollIntoView = () => {};
win.HTMLElement.prototype.hasPointerCapture = () => false;
win.HTMLElement.prototype.setPointerCapture = () => {};
win.HTMLElement.prototype.releasePointerCapture = () => {};

const accounts = [
  { account_id: 'current', name: 'Current organization' },
  { account_id: 'destination', name: 'Destination' },
];
let listAnswer = async () => accounts;
let transferAnswer: () => Promise<unknown> = async () => ({ success: true });
const listAccounts = mock(() => listAnswer());
const transferProject = mock((_projectId: string, _accountId: string) => transferAnswer());
const replace = mock((_path: string) => {});
const close = mock(() => {});
const forget = mock((_userId: string, _projectId: string) => {});
const success = mock((_message: string) => {});
const error = mock((_message: string) => {});
mock.module('@kortix/sdk', () => ({ listAccounts, transferProject }));
mock.module('@/features/providers/auth-provider', () => ({ useAuth: () => ({ user: { id: 'user-1' } }) }));
mock.module('next/navigation', () => ({ useRouter: () => ({ replace }) }));
mock.module('@/stores/settings-panel-store', () => ({ useSettingsPanelStore: { getState: () => ({ close }) } }));
mock.module('@/lib/onboarding/last-project-cookie', () => ({ forgetLastProjectId: forget }));
mock.module('@/components/ui/toast', () => ({ successToast: success, errorToast: error }));

const { TransferWorkspaceEntry } = await import('./transfer-workspace-dialog');
const { PROJECT_LANDING_PATH } = await import('@/lib/onboarding/landing-destination');
const { qk } = await import('@kortix/sdk/react');
let root: Root;
let client: QueryClient;
const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
const button = (label: string) => {
  const found = [...document.querySelectorAll('button')].find((el) => el.textContent?.trim() === label);
  if (!found) throw new Error(`Missing button: ${label}; ${document.body.textContent}`);
  return found;
};
async function click(label: string) {
  await act(async () => button(label).click());
  await flush();
}
async function chooseDestination() {
  const trigger = document.querySelector('[role="combobox"]')!;
  await act(async () => trigger.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }) as unknown as Event));
  await flush();
  const options = [...document.querySelectorAll('[role="option"]')];
  expect(options.map((option) => option.textContent)).toEqual(['Destination']);
  await act(async () => options[0].dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }) as unknown as Event));
  await flush();
}

beforeEach(() => {
  for (const fn of [listAccounts, transferProject, replace, close, forget, success, error]) fn.mockClear();
  listAnswer = async () => accounts;
  transferAnswer = async () => ({ success: true });
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<QueryClientProvider client={client}><TransferWorkspaceEntry projectId="project-1" currentAccountId="current" /></QueryClientProvider>));
});
afterEach(() => {
  act(() => root.unmount());
  client.clear();
  document.body.innerHTML = '';
});

test('accounts load only on open; an account failure is retryable without enabling transfer', async () => {
  expect(listAccounts).not.toHaveBeenCalled();
  listAnswer = async () => { throw new Error('accounts unavailable'); };
  await click('Transfer project');
  expect(button('Move project').disabled).toBe(true);
  expect(document.querySelector('[role="combobox"]')).toBeNull();
  listAnswer = async () => accounts;
  await click('Retry');
  expect(listAccounts).toHaveBeenCalledTimes(2);
  await chooseDestination();
  expect(button('Move to Destination').disabled).toBe(false);
  expect(transferProject).not.toHaveBeenCalled();
});

test('cancel closes the real dialog and resets the selected destination on reopen', async () => {
  await click('Transfer project');
  await chooseDestination();
  await click('Keep project');
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  await click('Transfer project');
  expect(button('Move project').disabled).toBe(true);
  expect(document.querySelector('[role="combobox"]')?.textContent).toContain('Choose an organization');
  expect(transferProject).not.toHaveBeenCalled();
});

test('confirmation sends SDK IDs, blocks duplicate/cancel while pending, invalidates all project lists and replaces navigation', async () => {
  let resolve!: (value: unknown) => void;
  transferAnswer = () => new Promise((done) => { resolve = done; });
  const invalidate = mock(client.invalidateQueries.bind(client));
  client.invalidateQueries = invalidate;
  await click('Transfer project');
  await chooseDestination();
  await click('Move to Destination');
  expect(transferProject).toHaveBeenCalledWith('project-1', 'destination');
  expect(button('Move to Destination…').disabled).toBe(true);
  expect(button('Keep project').disabled).toBe(true);
  expect(replace).not.toHaveBeenCalled();
  await act(async () => resolve({ success: true }));
  await flush();
  expect(transferProject).toHaveBeenCalledTimes(1);
  expect(success).toHaveBeenCalledWith('Project transferred');
  expect(forget).toHaveBeenCalledWith('user-1', 'project-1');
  expect(close).toHaveBeenCalledTimes(1);
  expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.projects.scope() });
  expect(replace).toHaveBeenCalledWith(PROJECT_LANDING_PATH);
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  expect(error).not.toHaveBeenCalled();
});

test('a rejected transfer reports the API error and keeps the destination available for retry without leaving', async () => {
  transferAnswer = async () => { throw new Error('Target project limit reached'); };
  await click('Transfer project');
  await chooseDestination();
  await click('Move to Destination');
  expect(error).toHaveBeenCalledWith('Target project limit reached');
  expect(button('Move to Destination').disabled).toBe(false);
  expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
  for (const fn of [success, forget, close, replace]) expect(fn).not.toHaveBeenCalled();
  transferAnswer = async () => ({ success: true });
  await click('Move to Destination');
  expect(transferProject).toHaveBeenCalledTimes(2);
  expect(replace).toHaveBeenCalledWith(PROJECT_LANDING_PATH);
});
