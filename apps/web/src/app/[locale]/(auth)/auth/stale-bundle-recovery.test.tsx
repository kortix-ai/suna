// A browser holding the previous build's client bundle calls server actions by
// an id the running server no longer knows. The action answers 404
// (x-nextjs-action-not-found: 1) and Next 16 throws `UnrecognizedActionError`
// into the caller — which used to die as an unhandled rejection on the /auth
// entry step: the submit did nothing, with no error and no toast, until the
// visitor reloaded by hand. These tests pin the recovery: the first failure
// reloads the document once with the address stashed, the stash prefills the
// form after the reload, a failure that outlives the reload shows the visible
// error instead of looping, and every other error keeps surfacing.
//
// The tests share one module state on purpose: `reloadedForStaleBundle` is a
// per-document flag, and this file IS the document. Order matters.
import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { NextIntlClientProvider } from '@/i18n/use-translations';
import messages from '../../../../../translations/en.json';

const STALE_BUNDLE_EMAIL_KEY = 'kortix:stale-bundle-email';
const UNEXPECTED = 'An unexpected error occurred';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sessionStore = new Map<string, string>();
let reloads = 0;
let toasts: string[] = [];
let resolveAuthModeError: Error | null = null;

Object.defineProperty(globalThis, 'window', {
  value: {
    location: {
      origin: 'http://localhost',
      reload: () => {
        reloads += 1;
      },
    },
    sessionStorage: {
      getItem: (key: string) => sessionStore.get(key) ?? null,
      setItem: (key: string, value: string) => sessionStore.set(key, value),
      removeItem: (key: string) => sessionStore.delete(key),
    },
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
mock.module('@/lib/env-config', () => ({
  getEnv: () => ({ AUTH_METHODS: 'password', AUTH_PROVIDERS: '' }),
}));
mock.module('@/components/ui/toast', () => ({
  errorToast: (message: string) => toasts.push(message),
}));

/** The exact client-visible shape of Next 16's missing-server-action failure. */
const staleBundleError = () =>
  Object.assign(
    new Error(
      'Server Action "7f1a2b" was not found on the server. Read more: https://nextjs.org/docs/messages/failed-to-find-server-action',
    ),
    { name: 'UnrecognizedActionError' },
  );

mock.module('./actions', () => ({
  sendEmailCode: async () => ({ success: true }),
  resolveAuthMode: async () => {
    if (resolveAuthModeError) throw resolveAuthModeError;
    return { mode: 'unknown' };
  },
  signInWithPassword: async () => ({}),
  signUpWithPassword: async () => ({}),
}));

const { default: AuthPage } = await import('./page');

async function createPage(): Promise<ReactTestRenderer> {
  let root: ReactTestRenderer | undefined;
  await act(async () => {
    root = create(
      createElement(NextIntlClientProvider, { locale: 'en', messages }, createElement(AuthPage)),
    );
  });
  if (!root) throw new Error('Auth page did not render');
  return root;
}

async function typeAndSubmit(root: ReactTestRenderer, address: string): Promise<void> {
  const email = root.root.findByProps({ autoComplete: 'email' });
  await act(async () => email.props.onChange({ target: { value: address } }));
  await act(async () => root.root.findByType('form').props.onSubmit({ preventDefault() {} }));
}

test('a stale-bundle failure on the first submit reloads once with the address stashed and shows no error', async () => {
  reloads = 0;
  toasts = [];
  resolveAuthModeError = staleBundleError();
  const root = await createPage();
  try {
    await typeAndSubmit(root, 'stale@example.test');
    expect(reloads).toBe(1);
    expect(sessionStore.get(STALE_BUNDLE_EMAIL_KEY)).toBe('stale@example.test');
    expect(toasts).toEqual([]);
    expect(JSON.stringify(root.toJSON())).not.toContain(UNEXPECTED);
  } finally {
    await act(async () => root.unmount());
  }
});

test('the recovery load prefills the stashed address and consumes the stash', async () => {
  sessionStore.set(STALE_BUNDLE_EMAIL_KEY, 'stale@example.test');
  const root = await createPage();
  try {
    const email = root.root.findByProps({ autoComplete: 'email' });
    expect(email.props.value).toBe('stale@example.test');
    expect(sessionStore.has(STALE_BUNDLE_EMAIL_KEY)).toBe(false);
  } finally {
    await act(async () => root.unmount());
  }
});

test('a stale-bundle failure that outlives the reload shows the visible error instead of reloading again', async () => {
  reloads = 0;
  toasts = [];
  resolveAuthModeError = staleBundleError();
  const root = await createPage();
  try {
    await typeAndSubmit(root, 'stale@example.test');
    expect(reloads).toBe(0);
    expect(toasts).toEqual([UNEXPECTED]);
    expect(JSON.stringify(root.toJSON())).toContain(UNEXPECTED);
    expect(JSON.stringify(root.toJSON())).not.toContain('failed-to-find-server-action');
  } finally {
    await act(async () => root.unmount());
  }
});

test('a plain failure keeps surfacing the error and never reloads', async () => {
  reloads = 0;
  toasts = [];
  resolveAuthModeError = new Error('backend unreachable');
  const root = await createPage();
  try {
    await typeAndSubmit(root, 'plain@example.test');
    expect(reloads).toBe(0);
    expect(toasts).toEqual([UNEXPECTED]);
    expect(JSON.stringify(root.toJSON())).toContain(UNEXPECTED);
  } finally {
    await act(async () => root.unmount());
  }
});
