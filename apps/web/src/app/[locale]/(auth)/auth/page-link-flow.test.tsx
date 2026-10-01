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
mock.module('@/lib/supabase/client', () => ({
  fetchSamlEnabled: async () => false,
  createClient: () => ({}),
}));
mock.module('./actions', () => ({
  sendEmailCode: async () => ({ success: true }),
  resolveAuthMode: async () => ({ mode: 'unknown' }),
  signInWithPassword: async () => ({}),
  signUpWithPassword: async () => ({}),
  verifyOtp: async () => ({}),
}));
mock.module('@/lib/env-config', () => ({
  getEnv: () => ({ AUTH_METHODS: 'magic,password', AUTH_PROVIDERS: '' }),
}));
mock.module('@/components/ui/toast', () => ({ errorToast: () => {} }));
const { default: AuthPage } = await import('./page');

test('the /auth Continue flow shows the emailed link, not a code form', async () => {
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
  expect(text).toContain('sign-in link');
  expect(text).toContain('Open it to continue');
  expect(root.root.findAllByType('input').filter((input) => input.props.inputMode === 'numeric')).toHaveLength(0);
  expect(text).not.toContain('one-time-code');
  await act(async () => root.unmount());
});
