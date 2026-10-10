// A sign-up submit that hangs must not leave a disabled button behind: after
// the client deadline the page shows a visible error and a working retry
// (the submit goes through a bounded POST, so a retry is a fresh fetch, not
// a call queued behind the hung one). While a submit is in flight, further
// clicks must not fire a second request.
import { afterEach, expect, mock, test } from 'bun:test';
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
  fetchSamlEnabled: async () => true,
  createClient: () => ({ auth: { signInWithSSO: async () => ({ data: null, error: { message: 'no SAML' } }) } }),
}));
mock.module('./actions', () => ({
  resolveAuthMode: async () => ({ mode: 'unknown' }),
}));
mock.module('@/lib/env-config', () => ({
  getEnv: () => ({ AUTH_METHODS: 'magic,password', AUTH_PROVIDERS: '' }),
}));
mock.module('@/components/ui/toast', () => ({ errorToast: () => {} }));

type Outcome = { ok: true; result: Record<string, unknown> } | { ok: false; message: string };
const submits: { path: string; body: FormData }[] = [];
let outcomes: Outcome[] = [];
let hangSubmits = false;
const hangResolvers: ((outcome: Outcome) => void)[] = [];

mock.module('@/lib/auth/submit-auth', () => ({
  AUTH_SUBMIT_TIMEOUT_MS: 30_000,
  submitAuthForm: async (path: string, body: FormData) => {
    submits.push({ path, body });
    if (hangSubmits) {
      return new Promise<Outcome>((resolve) => hangResolvers.push(resolve));
    }
    return outcomes.shift() ?? { ok: false, message: 'This is taking longer than expected. Please try again.' };
  },
}));

const { default: AuthPage } = await import('./page');

async function renderPage() {
  let root: ReturnType<typeof create> | undefined;
  await act(async () => {
    root = create(
      createElement(NextIntlClientProvider, { locale: 'en', messages }, createElement(AuthPage)),
    );
  });
  if (!root) throw new Error('Auth page did not render');
  return root;
}

async function continueWithEmail(root: NonNullable<ReturnType<typeof create>>, address: string) {
  const email = root.root.findByProps({ autoComplete: 'email' });
  await act(async () => email.props.onChange({ target: { value: address } }));
  await act(async () => root.root.findByType('form').props.onSubmit({ preventDefault() {} }));
}

afterEach(() => {
  submits.length = 0;
  outcomes = [];
  hangSubmits = false;
  hangResolvers.length = 0;
});

test('after the deadline the error is visible, the button is re-enabled, and a retry re-fires', async () => {
  outcomes = [
    { ok: false, message: 'This is taking longer than expected. Please try again.' },
    { ok: true, result: { success: true, email: 'synthetic@example.test' } },
  ];
  const root = await renderPage();
  try {
    const email = root.root.findByProps({ autoComplete: 'email' });
    await act(async () => email.props.onChange({ target: { value: 'synthetic@example.test' } }));
    await act(async () => root.root.findByType('form').props.onSubmit({ preventDefault() {} }));
    const text = JSON.stringify(root.toJSON());
    expect(text).toContain('This is taking longer than expected. Please try again.');
    const submit = root.root.findByProps({ type: 'submit' });
    expect(submit.props.disabled).toBe(false);
    expect(submits).toHaveLength(1);
    expect(submits[0].path).toBe('/api/auth/send-code');
    expect(submits[0].body.get('email')).toBe('synthetic@example.test');

    await act(async () => root.root.findByType('form').props.onSubmit({ preventDefault() {} }));
    expect(submits).toHaveLength(2);
    expect(JSON.stringify(root.toJSON())).toContain('Check your email');
  } finally {
    await act(async () => root.unmount());
  }
});

test('a submit in flight blocks a second submission until it settles', async () => {
  hangSubmits = true;
  const root = await renderPage();
  try {
    const email = root.root.findByProps({ autoComplete: 'email' });
    await act(async () => email.props.onChange({ target: { value: 'synthetic@example.test' } }));
    // One act: the first submit starts the in-flight window, the second is
    // blocked by it, and only the release settles the flow.
    await act(async () => {
      root.root.findByType('form').props.onSubmit({ preventDefault() {} });
      root.root.findByType('form').props.onSubmit({ preventDefault() {} });
      // Let the first submit walk its mocked pre-steps until it parks on the
      // hung send.
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
      hangResolvers.shift()?.({ ok: true, result: { success: true, email: 'synthetic@example.test' } });
    });
    // The settled submit's continuation flushes in its own act scope.
    await act(async () => {});
    expect(submits).toHaveLength(1);
    expect(JSON.stringify(root.toJSON())).toContain('Check your email');
  } finally {
    hangSubmits = false;
    hangResolvers.length = 0;
    await act(async () => root.unmount());
  }
});
