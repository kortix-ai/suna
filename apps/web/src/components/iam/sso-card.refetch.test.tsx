// KRTX-2401: the SSO edit dialog re-read its five fields from the provider
// whenever the provider object changed, even while open. The provider query
// is invalidated from outside the dialog (the Enterprise demo card, the setup
// wizard), so a refetch that brought a changed provider wiped what an admin
// was typing. The dialog now takes the provider once, when it opens.
import { afterEach, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SsoProvider } from '@/lib/iam-client';
import { Window } from 'happy-dom';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

const win = new Window({ width: 1440, height: 900 });
const globals = globalThis as Record<string, unknown>;
globals.window = win;
globals.document = win.document;
globals.navigator = win.navigator;
globals.location = win.location;
globals.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);
globals.cancelAnimationFrame = (id: number) => clearTimeout(id);
globals.getComputedStyle = win.getComputedStyle.bind(win);
for (const key of Object.getOwnPropertyNames(win)) {
  // Radix dispatches happy-dom's own event classes, not Bun's.
  if (/^[A-Z]/.test(key) && (!(key in globals) || key.endsWith('Event'))) {
    globals[key] = Reflect.get(win, key);
  }
}

mock.module('@/features/providers/auth-provider', () => ({
  useAuth: () => ({ user: { email: 'admin@example.test' } }),
}));

// After the window exists: react-dom decides at load whether the DOM fires
// `input` events.
const { createRoot } = await import('react-dom/client');
const { EditProviderDialog } = await import('./sso-card');

const provider: SsoProvider = {
  sso_provider_id: 'sso-1',
  supabase_sso_provider_id: 'supabase-sso-1',
  name: 'Synthetic IdP',
  primary_domain: 'example.test',
  group_claim_name: 'groups',
  auto_create_members: true,
  auto_provision_groups: false,
  enforce_sso: false,
} as SsoProvider;

let root: Root | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

function dialog(existing: SsoProvider) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      <EditProviderDialog
        accountId="account-1"
        open
        onOpenChange={() => {}}
        existing={existing}
        onSaved={() => {}}
      />
    </QueryClientProvider>
  );
}

/** The dialog's first text field: the provider name. */
function nameField(): HTMLInputElement {
  const field = document.querySelector('input');
  if (!field) throw new Error('the edit dialog rendered no field');
  return field as unknown as HTMLInputElement;
}

test('an open edit dialog keeps what the admin typed when the provider refetches changed', async () => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host as unknown as Element);
  await act(async () => root!.render(dialog(provider)));
  expect(nameField().value).toBe('Synthetic IdP');

  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value')!.set!;
    setValue.call(nameField(), 'Synthetic IdP (production)');
    nameField().dispatchEvent(new win.Event('input', { bubbles: true }) as unknown as Event);
  });
  expect(nameField().value).toBe('Synthetic IdP (production)');

  // The provider query refetches and another surface changed the provider.
  await act(async () => root!.render(dialog({ ...provider, name: 'Renamed elsewhere' })));
  expect(nameField().value).toBe('Synthetic IdP (production)');
});
