import { afterAll, expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { NextIntlClientProvider } from '@/i18n/use-translations';
import { KORTIX_SUPABASE_AUTH_COOKIE } from '@/lib/supabase/constants';
import messages from '../../../../../translations/en.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The prod magic-link failure (KRTX-2095), as a page contract: the sendEmailCode
 * server action's Set-Cookie does not always reach the browser (observed live on
 * the prod edge deployment: a successful send left the cookie jar empty), so the
 * page must seed the verifier cookie itself from the value the action RETURNS —
 * the same pattern signInWithPassword already uses for the session tokens.
 *
 * The jar below starts EMPTY and the mocked action sets nothing: a pass proves
 * the cookie came from the page's seeding, not from a response header.
 */

const VERIFIER_COOKIE = `${KORTIX_SUPABASE_AUTH_COOKIE}-code-verifier`;
const VERIFIER = '876ff4524f0545307de48c0324c2e84e0d3c1663ab392c128be0d6e1dcc64eee';
const ENCODED = `base64-${btoa(JSON.stringify(VERIFIER))
  .replace(/\+/g, '-')
  .replace(/\//g, '_')
  .replace(/=+$/, '')}`;

let cookieJar = '';
const storageEntries = new Map<string, string>();
const fakeSessionStorage = {
  clear: () => storageEntries.clear(),
  getItem: (key: string) => storageEntries.get(key) ?? null,
  removeItem: (key: string) => storageEntries.delete(key),
  setItem: (key: string, value: string) => storageEntries.set(key, value),
};

function applyCookieWrite(value: string): void {
  const [pair] = value.split(';');
  const [name, val] = pair.split('=');
  if (val === undefined) return;
  if (val === '') {
    cookieJar = cookieJar
      .split('; ')
      .filter((existing) => !existing.startsWith(`${name}=`))
      .join('; ');
    return;
  }
  const kept = cookieJar.split('; ').filter((existing) => !existing.startsWith(`${name}=`));
  kept.push(`${name}=${val}`);
  cookieJar = kept.filter(Boolean).join('; ');
}

const fakeDocument = {
  get cookie() {
    return cookieJar;
  },
  set cookie(value: string) {
    applyCookieWrite(value);
  },
};
Object.defineProperty(globalThis, 'document', {
  configurable: true,
  get: () => fakeDocument,
});
Object.defineProperty(globalThis, 'window', {
  value: {
    location: { origin: 'http://localhost', protocol: 'https:' },
    sessionStorage: fakeSessionStorage,
  },
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
  createClient: () => ({ auth: {} }),
}));
let actionResult: Record<string, unknown> = { success: true };
mock.module('./actions', () => ({
  sendEmailCode: async () => actionResult,
  resolveAuthMode: async () => ({ mode: 'unknown' }),
  signInWithPassword: async () => ({}),
  signUpWithPassword: async () => ({}),
}));
mock.module('@/lib/env-config', () => ({
  getEnv: () => ({ AUTH_METHODS: 'magic,password', AUTH_PROVIDERS: '' }),
}));
mock.module('@/components/ui/toast', () => ({ errorToast: () => {} }));
const { default: AuthPage } = await import('./page');

test('a successful send seeds the verifier cookie the action could not set', async () => {
  actionResult = { success: true, email: 'synthetic@example.test', codeVerifier: ENCODED };
  expect(cookieJar).toBe('');
  let root: ReturnType<typeof create> | undefined;
  try {
    await act(async () => {
      root = create(createElement(NextIntlClientProvider, { locale: 'en', messages }, createElement(AuthPage)));
    });
    if (!root) throw new Error('Auth page did not render');
    const email = root.root.findByProps({ autoComplete: 'email' });
    await act(async () => email.props.onChange({ target: { value: 'synthetic@example.test' } }));
    await act(async () => root.root.findByType('form').props.onSubmit({ preventDefault() {} }));
    expect(JSON.stringify(root.toJSON())).toContain('Check your email');

    // The cookie the server action's response failed to deliver, seeded by the
    // page from the action result — byte-identical to what the ssr server write
    // produces, so the callback's exchange reads it unchanged.
    expect(cookieJar).toBe(`${VERIFIER_COOKIE}=${ENCODED}`);

    // And the resume stash snapshots the seeded value (the second layer).
    const stashed = storageEntries.get('kortix:pkce-verifier');
    expect(stashed).toBeTruthy();
    expect(JSON.parse(stashed!)).toMatchObject({ verifier: VERIFIER });
  } finally {
    actionResult = { success: true };
    if (root) await act(async () => root.unmount());
  }
});

// bun runs every test file in one process: put the real globals back so later
// suites never see this file's fakes.
afterAll(() => {
  Object.defineProperty(globalThis, 'document', {
    value: undefined,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, 'window', {
    value: undefined,
    configurable: true,
    writable: true,
  });
});
