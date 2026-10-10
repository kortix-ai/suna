import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { NextIntlClientProvider } from '@/i18n/use-translations';
import messages from '../../../../../translations/en.json';

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
mock.module('@/features/providers/auth-provider', () => ({
  useAuth: () => ({ user: null, session: null, isLoading: false, supabase: {} }),
}));
let ssoProbes = 0;
mock.module('@/lib/supabase/client', () => ({
  fetchSamlEnabled: async () => true,
  createClient: () => ({
    auth: {
      signInWithSSO: async () => {
        ssoProbes += 1;
        return { data: null, error: { message: 'SAML provider unavailable' } };
      },
    },
  }),
}));
let emailFailure: string | null = null;
mock.module('./actions', () => ({
  resolveAuthMode: async () => ({ mode: 'unknown' }),
}));
mock.module('@/lib/auth/submit-auth', () => ({
  AUTH_SUBMIT_TIMEOUT_MS: 30_000,
  submitAuthForm: async () =>
    emailFailure
      ? { ok: false, reason: 'server' as const, message: emailFailure }
      : { ok: true, result: { success: true, email: 'synthetic@example.test' } },
}));
mock.module('@/lib/env-config', () => ({
  getEnv: () => ({ AUTH_METHODS: 'magic,password', AUTH_PROVIDERS: '' }),
}));
mock.module('@/components/ui/toast', () => ({ errorToast: () => {} }));
const { default: AuthPage } = await import('./page');

test('unavailable SSO falls back to email and keeps a refusal visible until the address changes', async () => {
  ssoProbes = 0;
  emailFailure = 'Your organization requires single sign-on. Continue with SSO instead.';
  let root: ReturnType<typeof create> | undefined;
  try {
    await act(async () => {
      root = create(createElement(NextIntlClientProvider, { locale: 'en', messages }, createElement(AuthPage)));
    });
    if (!root) throw new Error('Auth page did not render');
    const email = root.root.findByProps({ autoComplete: 'email' });
    await act(async () => email.props.onChange({ target: { value: 'synthetic@example.test' } }));
    await act(async () => root.root.findByType('form').props.onSubmit({ preventDefault() {} }));
    expect(ssoProbes).toBe(1);
    const alerts = root.root.findAllByProps({ role: 'alert' });
    expect(alerts.length).toBeGreaterThan(0);
    expect(JSON.stringify(root.toJSON())).toContain(emailFailure);
    await act(async () => email.props.onChange({ target: { value: 'other@example.test' } }));
    expect(root.root.findAllByProps({ role: 'alert' })).toHaveLength(0);
    expect(JSON.stringify(root.toJSON())).not.toContain(emailFailure);
  } finally {
    emailFailure = null;
    if (root) await act(async () => root.unmount());
  }
});

test('unavailable SSO still permits the supported email sign-in link', async () => {
  ssoProbes = 0;
  let root: ReturnType<typeof create> | undefined;
  await act(async () => {
    root = create(createElement(NextIntlClientProvider, { locale: 'en', messages }, createElement(AuthPage)));
  });
  if (!root) throw new Error('Auth page did not render');
  const email = root.root.findByProps({ autoComplete: 'email' });
  await act(async () => email.props.onChange({ target: { value: 'synthetic@example.test' } }));
  const form = root.root.findByType('form');
  await act(async () => form.props.onSubmit({ preventDefault() {} }));
  const text = JSON.stringify(root.toJSON());
  expect(ssoProbes).toBe(1);
  expect(text).toContain('sign-in link');
  expect(text).toContain('Open it to continue');
  expect(root.root.findAllByType('input').filter((input) => input.props.inputMode === 'numeric')).toHaveLength(0);
  expect(text).not.toContain('one-time-code');
  await act(async () => root.unmount());
});
