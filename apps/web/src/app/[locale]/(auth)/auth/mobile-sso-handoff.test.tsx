import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { NextIntlClientProvider } from '@/i18n/use-translations';
import messages from '../../../../../translations/en.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(globalThis, 'window', {
  value: { location: { origin: 'http://localhost', href: 'http://localhost/auth' } },
  configurable: true,
});
let search = '';
mock.module('next/navigation', () => ({
  useRouter: () => ({ replace: () => {}, push: () => {} }),
  usePathname: () => '/auth',
  useParams: () => ({}),
  useSearchParams: () => new URLSearchParams(search),
}));
let authLoading = false;
mock.module('@/features/providers/auth-provider', () => ({
  useAuth: () => ({ user: null, session: null, isLoading: authLoading, supabase: {} }),
}));
type SsoCall = { domain: string; options: { redirectTo: string; skipBrowserRedirect: boolean } };
let ssoCalls: SsoCall[] = [];
mock.module('@/lib/supabase/client', () => ({
  fetchSamlEnabled: async () => true,
  createClient: () => ({
    auth: {
      signInWithSSO: async (args: SsoCall) => {
        ssoCalls.push(args);
        return { data: { url: 'https://idp.example.test/x' }, error: null };
      },
    },
  }),
}));
mock.module('./actions', () => ({
  sendEmailCode: async () => ({ success: true }),
  resolveAuthMode: async () => ({ mode: 'sso' }),
  signInWithPassword: async () => ({}),
  signUpWithPassword: async () => ({}),
}));
mock.module('@/lib/env-config', () => ({
  getEnv: () => ({ AUTH_METHODS: 'magic,password', AUTH_PROVIDERS: '' }),
}));
mock.module('@/components/ui/toast', () => ({ errorToast: () => {} }));
const { default: AuthPage } = await import('./page');

const EMAIL = encodeURIComponent('user@example.test');

async function render() {
  let root: ReturnType<typeof create> | undefined;
  await act(async () => {
    root = create(createElement(NextIntlClientProvider, { locale: 'en', messages }, createElement(AuthPage)));
  });
  if (!root) throw new Error('Auth page did not render');
  return root;
}

test('the mobile SSO handoff starts SSO once for the prefilled email', async () => {
  ssoCalls = [];
  search = `mobile_callback=1&state=s1&sso=1&email=${EMAIL}`;
  const root = await render();
  try {
    expect(ssoCalls).toHaveLength(1);
    expect(ssoCalls[0].domain).toBe('example.test');
    const redirectTo = new URL(ssoCalls[0].options.redirectTo);
    expect(redirectTo.pathname).toBe('/auth/mobile/callback');
    expect(redirectTo.searchParams.get('mobile_callback')).toBe('1');
    expect(redirectTo.searchParams.get('state')).toBe('s1');
    expect(ssoCalls[0].options.redirectTo).toContain('/auth/mobile/callback?');
    expect(window.location.href).toBe('https://idp.example.test/x');
    expect(root.root.findByProps({ autoComplete: 'email' }).props.value).toBe('user@example.test');
  } finally {
    await act(async () => root.unmount());
  }
});

test('without sso=1 the mobile handoff ignores the email param', async () => {
  ssoCalls = [];
  search = `mobile_callback=1&state=s1&email=${EMAIL}`;
  const root = await render();
  try {
    expect(ssoCalls).toHaveLength(0);
    expect(root.root.findByProps({ autoComplete: 'email' }).props.value).toBe('');
  } finally {
    await act(async () => root.unmount());
  }
});

test('without mobile_callback the email and sso params are ignored', async () => {
  ssoCalls = [];
  search = `sso=1&email=${EMAIL}`;
  const root = await render();
  try {
    expect(ssoCalls).toHaveLength(0);
    expect(root.root.findByProps({ autoComplete: 'email' }).props.value).toBe('');
  } finally {
    await act(async () => root.unmount());
  }
});

test('the mobile SSO handoff waits until the auth check settles', async () => {
  ssoCalls = [];
  authLoading = true;
  search = `mobile_callback=1&state=s1&sso=1&email=${EMAIL}`;
  const root = await render();
  try {
    expect(ssoCalls).toHaveLength(0);
  } finally {
    authLoading = false;
    await act(async () => root.unmount());
  }
});
