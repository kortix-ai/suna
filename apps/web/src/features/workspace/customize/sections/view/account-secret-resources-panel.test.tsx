/**
 * KRTX-1719: an account key or ChatGPT login Kortix can no longer decrypt
 * (`status: 'undecryptable'`) is skipped by the gateway without a word. The
 * provider panel used to list it as a healthy row. It now shows the
 * Undecryptable badge, and the remedy to whoever may apply it: Re-enter key
 * (the rotate dialog, `PUT …/value`) for a key, Reconnect for a login.
 *
 * Runs the real panel against `happy-dom`; the list hook, the member list, the
 * auth context, the permission probe and the rotate call are stubs.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import type { Root } from 'react-dom/client';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

const win = new Window({ width: 1440, height: 900 });
const globals = globalThis as Record<string, unknown>;
globals.window = win;
globals.document = win.document;
globals.navigator = win.navigator;
globals.location = win.location;
globals.history = win.history;
globals.localStorage = win.localStorage;
globals.getComputedStyle = win.getComputedStyle.bind(win);
globals.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);
globals.cancelAnimationFrame = (id: number) => clearTimeout(id);
for (const key of Object.getOwnPropertyNames(win)) {
  if (/^[A-Z]/.test(key) && !(key in globals)) globals[key] = Reflect.get(win, key);
}
// The dialog's focus and dismiss layers create events by bare global name,
// and happy-dom dispatches only its own.
for (const key of ['Event', 'CustomEvent', 'FocusEvent', 'KeyboardEvent', 'MouseEvent', 'PointerEvent']) {
  globals[key] = Reflect.get(win, key);
}

// After the globals: react-dom decides at load whether the DOM has `input` events.
const { createRoot } = await import('react-dom/client');

const ME = 'user-1';
type Row = { secret_id: string; label: string; status?: 'ok' | 'undecryptable'; created_by?: string };
let rows: Row[] = [];
const rotations: Array<[string, string, string]> = [];

function resource(row: Row) {
  return {
    provider_id: 'anthropic',
    name: 'ANTHROPIC_API_KEY',
    access_mode: 'project',
    project_id: 'p1',
    active: true,
    created_by: ME,
    created_at: '2026-10-13T00:00:00.000Z',
    updated_at: '2026-10-13T00:00:00.000Z',
    granted_user_ids: [],
    can_use: true,
    cooldown_until: null,
    needs_reauth_at: null,
    ...row,
  };
}

const sdk = await import('@kortix/sdk');
mock.module('@kortix/sdk', () => ({
  ...sdk,
  listAccountMembers: async () => [],
  rotateAccountSecretResource: async (accountId: string, secretId: string, value: string) => {
    rotations.push([accountId, secretId, value]);
    return resource({ secret_id: secretId, label: 'Primary', status: 'ok' });
  },
}));
const sdkReact = await import('@kortix/sdk/react');
mock.module('@kortix/sdk/react', () => ({
  ...sdkReact,
  refreshProjectProviderState: () => undefined,
  useAccountSecretResources: () => ({
    data: { secrets: rows.map(resource) },
    isSuccess: true,
    isLoading: false,
    isError: false,
    isFetching: false,
    dataUpdatedAt: Date.parse('2026-10-13T00:00:00.000Z'),
    refetch: async () => ({ data: { secrets: rows.map(resource) } }),
  }),
}));
mock.module('@/features/providers/auth-provider', () => ({ useAuth: () => ({ user: { id: ME } }) }));
const projectCan = await import('@/lib/use-project-can');
mock.module('@/lib/use-project-can', () => ({ ...projectCan, useProjectCan: () => ({ allowed: true }) }));

const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { NextIntlClientProvider } = await import('@/i18n/use-translations');
const messages = (await import('../../../../../../translations/en.json')).default;
const { AccountSecretResourcesPanel } = await import('./account-secret-resources-panel');

let root: Root | null = null;
let host: HTMLElement | null = null;

function mount(canWrite = true, oauth = false) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <QueryClientProvider client={new QueryClient()}>
        <NextIntlClientProvider locale="en" messages={messages} onError={() => {}}>
          <AccountSecretResourcesPanel
            accountId="account-1"
            projectId="p1"
            providerId="anthropic"
            providerName="Anthropic"
            envVar="ANTHROPIC_API_KEY"
            canWrite={canWrite}
            {...(oauth ? { oauth: { projectId: 'p1', onConnected: () => undefined } } : {})}
          />
        </NextIntlClientProvider>
      </QueryClientProvider>,
    );
  });
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  rows = [];
  rotations.length = 0;
  document.body.innerHTML = '';
});

const settle = (ms = 0) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));
const listItems = () => [...document.querySelectorAll('li')];
const buttonsIn = (element: Element) => [...element.querySelectorAll('button')].map((b) => b.textContent?.trim() ?? '');
const click = (element: Element) =>
  act(() => {
    element.dispatchEvent(new win.MouseEvent('click', { bubbles: true }) as unknown as Event);
  });

describe('an account key Kortix cannot decrypt', () => {
  test('shows the badge and Re-enter key; a decryptable key shows neither', () => {
    rows = [
      { secret_id: 'lost', label: 'Primary', status: 'undecryptable' },
      { secret_id: 'fine', label: 'Backup', status: 'ok' },
    ];
    mount();
    const [lost, fine] = listItems();
    expect(lost?.textContent).toContain('Undecryptable');
    expect(buttonsIn(lost!)).toContain('Re-enter key');
    expect(fine?.textContent).not.toContain('Undecryptable');
    expect(buttonsIn(fine!)).not.toContain('Re-enter key');
  });

  test('Re-enter key opens the rotate dialog and saves the new value to that key', async () => {
    rows = [{ secret_id: 'lost', label: 'Primary', status: 'undecryptable' }];
    mount();
    const reenter = [...listItems()[0]!.querySelectorAll('button')].find((b) => b.textContent === 'Re-enter key');
    await act(async () => reenter!.click());
    await settle();
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain('Rotate Primary');

    const input = dialog!.querySelector<HTMLInputElement>('input[type="password"]')!;
    const setValue = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setValue.call(input, 'synthetic-new-key');
      input.dispatchEvent(new win.Event('input', { bubbles: true }) as unknown as Event);
    });
    await settle();
    const save = [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === 'Save key');
    await act(async () => (save as HTMLButtonElement).click());
    await settle(20);
    expect(rotations).toEqual([['account-1', 'lost', 'synthetic-new-key']]);
  });

  test('a viewer who cannot manage the key sees the badge and no remedy', () => {
    rows = [{ secret_id: 'lost', label: 'Primary', status: 'undecryptable', created_by: 'someone-else' }];
    mount(false);
    const [lost] = listItems();
    expect(lost?.textContent).toContain('Undecryptable');
    expect(buttonsIn(lost!)).not.toContain('Re-enter key');
  });
});

describe('a ChatGPT login Kortix cannot decrypt', () => {
  test('its owner sees the badge and Reconnect, and no Re-enter key', () => {
    rows = [{ secret_id: 'login', label: 'My ChatGPT', status: 'undecryptable' }];
    mount(true, true);
    const [login] = listItems();
    expect(login?.textContent).toContain('Undecryptable');
    expect(buttonsIn(login!)).toContain('Reconnect');
    expect(buttonsIn(login!)).not.toContain('Re-enter key');
  });
});
