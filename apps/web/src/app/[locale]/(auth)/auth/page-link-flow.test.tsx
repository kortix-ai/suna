import { expect, jest, mock, test } from 'bun:test';
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
let ssoProbeMode: 'fail' | 'url' = 'fail';
mock.module('@/lib/supabase/client', () => ({
  fetchSamlEnabled: async () => true,
  createClient: () => ({
    auth: {
      signInWithSSO: async () => {
        ssoProbes += 1;
        if (ssoProbeMode === 'url') {
          return { data: { url: 'https://idp.example.test/sso' }, error: null };
        }
        return { data: null, error: { message: 'SAML provider unavailable' } };
      },
    },
  }),
}));
let emailFailure: string | null = null;
let emailFailureStatus: number | null = null;
mock.module('./actions', () => ({
  resolveAuthMode: async () => ({ mode: 'unknown' }),
}));
mock.module('@/lib/auth/submit-auth', () => ({
  AUTH_SUBMIT_TIMEOUT_MS: 30_000,
  AUTH_TIMEOUT_MESSAGE: 'This is taking longer than expected. Please try again.',
  AUTH_NETWORK_MESSAGE: 'The request could not be sent. Please try again.',
  AUTH_UNEXPECTED_MESSAGE: 'Something went wrong. Please try again.',
  submitAuthForm: async () =>
    emailFailure
      ? {
          ok: false,
          reason: 'server' as const,
          message: emailFailure,
          status: emailFailureStatus ?? 400,
        }
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
  let rendered: ReturnType<typeof create> | undefined;
  try {
    await act(async () => {
      rendered = create(<NextIntlClientProvider locale="en" messages={messages}><AuthPage /></NextIntlClientProvider>);
    });
    if (!rendered) throw new Error('Auth page did not render');
    const root = rendered;
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
    if (rendered) await act(async () => rendered?.unmount());
  }
});

test('unavailable SSO still permits the supported email sign-in link', async () => {
  ssoProbes = 0;
  let rendered: ReturnType<typeof create> | undefined;
  await act(async () => {
    rendered = create(<NextIntlClientProvider locale="en" messages={messages}><AuthPage /></NextIntlClientProvider>);
  });
  if (!rendered) throw new Error('Auth page did not render');
  const root = rendered;
  const email = root.root.findByProps({ autoComplete: 'email' });
  await act(async () => email.props.onChange({ target: { value: 'synthetic@example.test' } }));
  const form = root.root.findByType('form');
  await act(async () => form.props.onSubmit({ preventDefault() {} }));
  const text = JSON.stringify(root.toJSON());
  expect(ssoProbes).toBe(1);
  expect(text).toContain('We sent a link to');
  expect(text).toContain('Open it to continue');
  expect(root.root.findAllByType('input').filter((input) => input.props.inputMode === 'numeric')).toHaveLength(0);
  expect(text).not.toContain('one-time-code');
  await act(async () => root.unmount());
});

// The SSO interstitial's "Email me a link instead" fires the same send-magic
// action as the password form's button — a refused send must cool it down
// there too, not leave it re-firing the doomed action on every click.
test('a rate-limited send cools the SSO interstitial link button down', async () => {
  jest.useFakeTimers();
  ssoProbes = 0;
  ssoProbeMode = 'url';
  emailFailure = 'Email rate limit exceeded. Try again later.';
  emailFailureStatus = 429;
  let rendered: ReturnType<typeof create> | undefined;
  try {
    await act(async () => {
      rendered = create(<NextIntlClientProvider locale="en" messages={messages}><AuthPage /></NextIntlClientProvider>);
    });
    if (!rendered) throw new Error('Auth page did not render');
    const root = rendered;
    const email = root.root.findByProps({ autoComplete: 'email' });
    await act(async () => email.props.onChange({ target: { value: 'synthetic@example.test' } }));
    await act(async () => root.root.findByType('form').props.onSubmit({ preventDefault() {} }));
    expect(ssoProbes).toBe(1);
    expect(JSON.stringify(root.toJSON())).toContain('single sign-on');
    const linkButton = root.root
      .findAllByProps({ type: 'button' })
      .find((button) => {
        const children = button.props.children;
        return typeof children === 'string' && children.includes('Email me a link instead');
      });
    if (!linkButton) throw new Error('SSO interstitial link button did not render');
    await act(async () => linkButton.props.onClick());
    expect(JSON.stringify(root.toJSON())).toContain('Email rate limit exceeded');
    expect(linkButton.props.disabled).toBe(true);
    expect(JSON.stringify(root.toJSON())).toContain('Resend in');
    for (let i = 0; i < 30; i++) {
      await act(async () => {
        jest.advanceTimersByTime(1000);
      });
    }
    expect(linkButton.props.disabled).toBe(false);
    expect(JSON.stringify(root.toJSON())).not.toContain('Resend in');
  } finally {
    emailFailure = null;
    emailFailureStatus = null;
    ssoProbeMode = 'fail';
    jest.useRealTimers();
    if (rendered) await act(async () => rendered?.unmount());
  }
});
