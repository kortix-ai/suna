import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { NextIntlClientProvider } from '@/i18n/use-translations';
import messages from '../../../../../translations/en.json';

/**
 * The sign-in submit must wait for the auth bootstrap to settle.
 *
 * Live report (prod, 2026-10-03): a fresh emailed sign-in link bounced to
 * `/auth?expired=true` with no session. The browser held a session the auth
 * server rejects (its account was deleted), and the /auth form is usable while
 * `AuthProvider` is still validating that session. When the validation's
 * definitive rejection (`getUser` → `AuthSessionMissingError` → signOut)
 * resolves AFTER the visitor submitted the form, auth-js's teardown
 * (`removeAllPKCEVerifiers`) deletes the PKCE verifier cookies the send-email
 * action had just written — the emailed link then exchanges with no verifier,
 * GoTrue answers 400, and the callback reports an expired link.
 *
 * Every teardown runs strictly inside the bootstrap (before `isLoading`
 * clears), so a submit that waits for `isLoading` can never race it.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(globalThis, 'window', {
  value: { location: { origin: 'http://localhost' } },
  configurable: true,
});
mock.module('next/navigation', () => ({
  useRouter: () => ({ replace: () => {}, push: () => {} }),
  usePathname: () => '/auth',
  useParams: () => ({}),
  useSearchParams: () => new URLSearchParams(),
}));

let authState = { user: null, session: null, isLoading: true, supabase: {} };
mock.module('@/features/providers/auth-provider', () => ({
  useAuth: () => authState,
}));

let sendEmailCalls = 0;
mock.module('./actions', () => ({
  sendEmailCode: async () => {
    sendEmailCalls += 1;
    return { success: true, email: 'synthetic@example.test' };
  },
  resolveAuthMode: async () => ({ mode: 'unknown' }),
  signInWithPassword: async () => ({}),
  signUpWithPassword: async () => ({}),
}));
mock.module('@/lib/supabase/client', () => ({
  fetchSamlEnabled: async () => false,
  createClient: () => ({}),
}));
mock.module('@/lib/env-config', () => ({
  getEnv: () => ({ AUTH_METHODS: 'magic', AUTH_PROVIDERS: '' }),
}));
mock.module('@/components/ui/toast', () => ({ errorToast: () => {} }));
const { default: AuthPage } = await import('./page');

async function submitEntry(root: NonNullable<ReturnType<typeof create>>) {
  const email = root.root.findByProps({ autoComplete: 'email' });
  await act(async () => email.props.onChange({ target: { value: 'synthetic@example.test' } }));
  await act(async () => root.root.findByType('form').props.onSubmit({ preventDefault() {} }));
}

test('the sign-in submit waits for the auth bootstrap to settle', async () => {
  sendEmailCalls = 0;

  // The bootstrap is still validating the session this browser holds.
  authState = { user: null, session: null, isLoading: true, supabase: {} };
  let root: ReturnType<typeof create> | undefined;
  try {
    await act(async () => {
      root = create(
        createElement(NextIntlClientProvider, { locale: 'en', messages }, createElement(AuthPage)),
      );
    });
    if (!root) throw new Error('Auth page did not render');
    // The form itself renders immediately; only the submit waits.
    expect(root.root.findByProps({ autoComplete: 'email' })).toBeDefined();

    await submitEntry(root);
    expect(sendEmailCalls).toBe(0);
  } finally {
    if (root) await act(async () => root.unmount());
  }

  // Bootstrap settled (here: no session to validate, so it answers at once).
  authState = { user: null, session: null, isLoading: false, supabase: {} };
  await act(async () => {
    root = create(
      createElement(NextIntlClientProvider, { locale: 'en', messages }, createElement(AuthPage)),
    );
  });
  try {
    if (!root) throw new Error('Auth page did not render');
    await submitEntry(root);
    expect(sendEmailCalls).toBe(1);
  } finally {
    if (root) await act(async () => root.unmount());
  }
});

test('the submit button is disabled while the bootstrap runs, enabled after', async () => {
  authState = { user: null, session: null, isLoading: true, supabase: {} };
  let root: ReturnType<typeof create> | undefined;
  try {
    await act(async () => {
      root = create(
        createElement(NextIntlClientProvider, { locale: 'en', messages }, createElement(AuthPage)),
      );
    });
    if (!root) throw new Error('Auth page did not render');
    const submit = root.root.findByProps({ type: 'submit' });
    expect(submit.props.disabled).toBe(true);
  } finally {
    if (root) await act(async () => root.unmount());
  }

  authState = { user: null, session: null, isLoading: false, supabase: {} };
  try {
    await act(async () => {
      root = create(
        createElement(NextIntlClientProvider, { locale: 'en', messages }, createElement(AuthPage)),
      );
    });
    if (!root) throw new Error('Auth page did not render');
    const submit = root.root.findByProps({ type: 'submit' });
    expect(submit.props.disabled).toBe(false);
  } finally {
    if (root) await act(async () => root.unmount());
  }
});
