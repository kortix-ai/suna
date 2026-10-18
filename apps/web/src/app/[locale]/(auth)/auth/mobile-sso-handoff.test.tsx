import { expect, mock, test } from 'bun:test';
import { act, create } from 'react-test-renderer';
import { NextIntlClientProvider } from '@/i18n/use-translations';
import messages from '../../../../../translations/en.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const assigned: string[] = [];
Object.defineProperty(globalThis, 'window', {
  value: {
    location: {
      origin: 'http://localhost',
      href: 'http://localhost/auth',
      assign: (url: string) => assigned.push(url),
    },
  },
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
let authUser: Record<string, unknown> | null = null;
let signOuts: unknown[] = [];
const SESSION = { access_token: 'acc', refresh_token: 'ref', expires_at: 4102444800 };
mock.module('@/features/providers/auth-provider', () => ({
  useAuth: () => ({
    user: authUser,
    session: authUser ? SESSION : null,
    isLoading: authLoading,
    supabase: {
      auth: {
        signOut: async (options: unknown) => {
          signOuts.push(options);
          authUser = null;
          return { error: null };
        },
      },
    },
  }),
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
    root = create(<NextIntlClientProvider locale="en" messages={messages}><AuthPage /></NextIntlClientProvider>);
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

// KRTX-1716: the app asks for SSO after the API refused its session with
// `sso_required`. A password, email-code or social session this browser
// already holds is that refused identity: handing it back looped the app.
test('an existing non-SSO web session is signed out here, not handed to the app, and SSO starts', async () => {
  ssoCalls = [];
  signOuts = [];
  assigned.length = 0;
  authUser = { id: 'u1', email: 'user@example.test', app_metadata: { provider: 'email', providers: ['email'] } };
  search = `mobile_callback=1&state=s1&sso=1&email=${EMAIL}`;
  const root = await render();
  try {
    expect(signOuts).toEqual([{ scope: 'local' }]);
    expect(assigned.some((url) => url.startsWith('kortix://') || url.includes('/auth/mobile/'))).toBe(false);
    // SSO waits for the sign-out: it would otherwise clear SSO's PKCE verifier.
    await act(async () => root.update(<NextIntlClientProvider locale="en" messages={messages}><AuthPage /></NextIntlClientProvider>));
    expect(ssoCalls).toHaveLength(1);
    expect(ssoCalls[0].domain).toBe('example.test');
  } finally {
    authUser = null;
    await act(async () => root.unmount());
  }
});

test('an SSO web session for another email is not handed to the app either', async () => {
  ssoCalls = [];
  signOuts = [];
  assigned.length = 0;
  authUser = { id: 'u2', email: 'someone-else@example.test', is_sso_user: true, app_metadata: { provider: 'sso:p1' } };
  search = `mobile_callback=1&state=s1&sso=1&email=${EMAIL}`;
  const root = await render();
  try {
    expect(signOuts).toEqual([{ scope: 'local' }]);
    expect(assigned).toEqual([]);
  } finally {
    authUser = null;
    await act(async () => root.unmount());
  }
});

test("the same person's SSO web session is handed to the app without a second SSO round trip", async () => {
  ssoCalls = [];
  signOuts = [];
  assigned.length = 0;
  authUser = { id: 'u3', email: 'User@Example.test', app_metadata: { provider: 'sso:p1', providers: ['sso:p1'] } };
  search = `mobile_callback=1&state=s1&sso=1&email=${EMAIL}`;
  const root = await render();
  try {
    expect(signOuts).toEqual([]);
    expect(ssoCalls).toHaveLength(0);
    expect(assigned).toHaveLength(1);
  } finally {
    authUser = null;
    await act(async () => root.unmount());
  }
});
