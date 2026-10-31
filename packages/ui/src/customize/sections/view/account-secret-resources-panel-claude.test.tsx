/**
 * A Claude account is added the way a ChatGPT account is: a name, who may use
 * it (private by default), then the provider's sign-in. Claude's sign-in opens
 * claude.com and takes the code it shows (`claude setup-token` on the server).
 *
 * Runs the real panel against `happy-dom`; the SDK calls, the member list, the
 * auth context and the permission probe are stubs.
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
const starts: unknown[] = [];
const completes: unknown[] = [];
const opened: string[] = [];
let completeError: Error | null = null;

const sdk = await import('@kortix/sdk');
mock.module('@kortix/sdk', () => ({
  ...sdk,
  listAccountMembers: async () => [],
  startClaudeSubscriptionLogin: async (projectId: string, target: unknown) => {
    starts.push([projectId, target]);
    return { flow_id: 'flow-1', authorize_url: 'https://claude.com/cai/oauth/authorize?x=1', expires_at: '2026-10-31T00:10:00.000Z' };
  },
  completeClaudeSubscriptionLogin: async (projectId: string, input: unknown) => {
    completes.push([projectId, input]);
    if (completeError) throw completeError;
    return { connected: true, secret_id: 'secret-1' };
  },
}));
const sdkReact = await import('@kortix/sdk/react');
mock.module('@kortix/sdk/react', () => ({
  ...sdkReact,
  refreshProjectProviderState: () => undefined,
  useAccountSecretResources: () => ({
    data: { secrets: [] }, isSuccess: true, isLoading: false, isError: false, isFetching: false,
    dataUpdatedAt: Date.parse('2026-10-31T00:00:00.000Z'), refetch: async () => ({ data: { secrets: [] } }),
  }),
}));
const realUiProvider = { ...(await import('../../../providers/ui-provider')) };
mock.module('../../../providers/ui-provider', () => ({ ...realUiProvider, useUiViewer: () => ({ id: ME }) }));
const projectCan = await import('../../../internal/lib/use-project-can');
mock.module('../../../internal/lib/use-project-can', () => ({ ...projectCan, useProjectCan: () => ({ allowed: true }) }));

const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { IntlTestProvider: NextIntlClientProvider } = await import('../../../test-utils/intl');
const messages = (await import('../../../../../../apps/web/translations/en.json')).default;
const { AccountSecretResourcesPanel } = await import('./account-secret-resources-panel');

let root: Root | null = null;
let host: HTMLElement | null = null;

function mount() {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  (window as unknown as { open: (url: string) => unknown }).open = (url: string) => {
    opened.push(url);
    return { closed: false, close: () => undefined, location: { set href(next: string) { opened.push(next); } } };
  };
  act(() => {
    root!.render(
      <QueryClientProvider client={new QueryClient()}>
        <NextIntlClientProvider locale="en" messages={messages} onError={() => {}}>
          <AccountSecretResourcesPanel accountId="account-1" projectId="p1" providerId="claude-agent" providerName="Claude Pro/Max"
            envVar="CLAUDE_CODE_OAUTH_TOKEN" canWrite oauth={{ projectId: 'p1', onConnected: () => undefined, kind: 'claude' }} />
        </NextIntlClientProvider>
      </QueryClientProvider>,
    );
  });
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null; host = null;
  starts.length = 0; completes.length = 0; opened.length = 0; completeError = null;
  document.body.innerHTML = '';
});

const settle = (ms = 0) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));
const button = (label: string) => [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined;
function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new (window as unknown as { Event: typeof Event }).Event('input', { bubbles: true }));
  });
}

async function startSignIn() {
  mount();
  expect(document.body.textContent).toContain('No Claude accounts yet');
  act(() => button('Sign in with Claude')!.click());
  await settle();
  type(document.querySelector('#provider-key-label-claude-agent') as HTMLInputElement, 'Work Max');
  act(() => button('Connect account')!.click());
  await settle(10);
}

describe('a Claude account, connected like a ChatGPT account', () => {
  test('signs in on claude.com with the name and a private sharing choice, then stores the pasted code', async () => {
    await startSignIn();
    expect(starts).toEqual([['p1', { resourceLabel: 'Work Max', sharing: { mode: 'private', ownerId: ME } }]]);
    // The tab opens inside the click, then moves to the sign-in link.
    expect(opened).toEqual(['about:blank', 'https://claude.com/cai/oauth/authorize?x=1']);
    const code = document.querySelector('input[aria-label="Code from claude.com"], [data-provider-claude-code] input') as HTMLInputElement;
    expect(code).toBeTruthy();
    type(code, 'abc#def');
    act(() => (document.querySelector('[data-provider-claude-code] form') as HTMLFormElement).requestSubmit());
    await settle(10);
    expect(completes).toEqual([['p1', { flowId: 'flow-1', code: 'abc#def' }]]);
  });

  test('a refused code shows the reason and offers the sign-in again', async () => {
    completeError = new Error('Claude did not accept that code. Sign in with Claude again and paste the new code.');
    await startSignIn();
    const code = document.querySelector('[data-provider-claude-code] input') as HTMLInputElement;
    type(code, 'nope');
    act(() => (document.querySelector('[data-provider-claude-code] form') as HTMLFormElement).requestSubmit());
    await settle(10);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Claude did not accept that code');
    expect(document.querySelector('[data-provider-claude-code]')).toBeNull();
    expect(button('Try again')).toBeTruthy();
  });
});
