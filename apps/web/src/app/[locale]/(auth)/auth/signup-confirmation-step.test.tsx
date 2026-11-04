// A password sign-up that needs email confirmation lands on the check-your-
// inbox step with the resend countdown, not back on the password form: a live
// "Continue" there mailed the address again on every click. An "already sent"
// answer from either send action shows the server's seconds left and the spam
// hint, so a reload or a second tab cannot restart the countdown.
import { afterEach, expect, jest, mock, test } from 'bun:test';
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
  createClient: () => ({ auth: {} }),
}));
mock.module('./actions', () => ({ resolveAuthMode: async () => ({ mode: 'signup' }) }));
mock.module('@/lib/env-config', () => ({
  getEnv: () => ({ AUTH_METHODS: 'password', AUTH_PROVIDERS: '' }),
}));
mock.module('@kortix/ui/toast', () => ({ errorToast: () => {} }));

const submits: string[] = [];
let outcomes: Record<string, unknown>[] = [];
mock.module('@/lib/auth/submit-auth', () => ({
  AUTH_SUBMIT_TIMEOUT_MS: 30_000,
  AUTH_TIMEOUT_MESSAGE: 'This is taking longer than expected. Please try again.',
  AUTH_NETWORK_MESSAGE: 'The request could not be sent. Please try again.',
  AUTH_UNEXPECTED_MESSAGE: 'Something went wrong. Please try again.',
  submitAuthForm: async (path: string) => {
    submits.push(path);
    return { ok: true, result: outcomes.shift() ?? {} };
  },
}));

const { default: AuthPage } = await import('./page');
const ALREADY_SENT = messages.hardcodedUi.i18nComplete.authEmailAlreadySent;

afterEach(() => {
  submits.length = 0;
  outcomes = [];
  jest.useRealTimers();
});

/** Render, type the address, Continue to the password form (password-only), submit it. */
async function submitPasswordSignup() {
  let root: ReturnType<typeof create> | undefined;
  await act(async () => {
    root = create(
      <NextIntlClientProvider locale="en" messages={messages}>
        <AuthPage />
      </NextIntlClientProvider>,
    );
  });
  if (!root) throw new Error('Auth page did not render');
  const tree = root;
  await act(async () => tree.root.findByProps({ autoComplete: 'email' }).props.onChange({ target: { value: 'synthetic@example.test' } }));
  await act(async () => tree.root.findByType('form').props.onSubmit({ preventDefault() {} }));
  await act(async () =>
    tree.root.findByType('form').props.onSubmit({ preventDefault() {}, currentTarget: undefined }),
  );
  return tree;
}

test('a sign-up that needs confirmation shows the inbox step with the countdown and the spam hint', async () => {
  jest.useFakeTimers();
  outcomes = [{ success: true, email: 'synthetic@example.test', requiresEmailConfirmation: true, retryAfterSeconds: 60 }];
  const root = await submitPasswordSignup();
  try {
    const text = JSON.stringify(root.toJSON());
    expect(submits).toEqual(['/api/auth/password?intent=signup']);
    expect(text).toContain('We sent a confirmation email to');
    expect(text).toContain('Resend in 60');
    expect(text).toContain(messages.auth.unified.link.checkSpam);
    expect(text).not.toContain(ALREADY_SENT);
    // The password form is gone: there is no submit left that mails the address.
    expect(root.root.findAllByProps({ name: 'password' })).toHaveLength(0);
  } finally {
    await act(async () => root.unmount());
  }
});

test('an "already sent" answer shows the seconds the server reports, not a fresh minute', async () => {
  jest.useFakeTimers();
  outcomes = [{
    success: true,
    email: 'synthetic@example.test',
    requiresEmailConfirmation: true,
    alreadySent: true,
    retryAfterSeconds: 17,
    message: ALREADY_SENT,
  }];
  const root = await submitPasswordSignup();
  try {
    const text = JSON.stringify(root.toJSON());
    expect(text).toContain(ALREADY_SENT);
    expect(text).toContain('Resend in 17');
  } finally {
    await act(async () => root.unmount());
  }
});
