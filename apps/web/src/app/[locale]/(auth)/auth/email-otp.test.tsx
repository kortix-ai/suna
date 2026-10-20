import { expect, mock, test } from 'bun:test';
import { act, create } from 'react-test-renderer';
import { NextIntlClientProvider } from '@/i18n/use-translations';
import messages from '../../../../../translations/en.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(globalThis, 'window', {
  value: { location: { origin: 'http://localhost', assign: (url: string) => { destination = url; } } },
  configurable: true,
});
mock.module('next/navigation', () => ({
  useRouter: () => ({ replace: () => {}, push: () => {} }),
  usePathname: () => '/auth',
  useParams: () => ({}),
  useSearchParams: () => new URLSearchParams(query),
}));
mock.module('@/features/providers/auth-provider', () => ({
  useAuth: () => ({ user: null, session: null, isLoading: false, supabase: {} }),
}));
let query = '';
let calls: unknown[] = [];
let failure: false | 'invalid' | 'missing' | 'network' = false;
let destination = '';
let resolvedDestination: string | undefined;
mock.module('@/lib/supabase/client', () => ({
  fetchSamlEnabled: async () => true,
  createClient: () => ({
    auth: {
      verifyOtp: async (payload: unknown) => {
        calls.push(payload);
        if (failure === 'network') throw new Error('private transport detail');
        if (failure === 'missing') return { data: { session: null }, error: null };
        if (failure === 'invalid') return { data: {}, error: { message: 'private upstream detail' } };
        return { data: { session: { access_token: 'synthetic-access', refresh_token: 'synthetic-refresh' } }, error: null };
      },
      setSession: async (tokens: unknown) => { calls.push(tokens); return { error: null }; },
      signInWithSSO: async () => ({ data: null, error: { message: 'SAML provider unavailable' } }),
    },
  }),
}));
mock.module('./actions', () => ({
  resolveAuthMode: async () => ({ mode: 'unknown' }),
  sendEmailCode: async () => ({ success: true, email: 'synthetic@example.test', redirectTo: resolvedDestination }),
}));
mock.module('@/lib/auth/submit-auth', () => ({
  AUTH_SUBMIT_TIMEOUT_MS: 30_000,
  AUTH_TIMEOUT_MESSAGE: 'This is taking longer than expected. Please try again.',
  AUTH_NETWORK_MESSAGE: 'The request could not be sent. Please try again.',
  AUTH_UNEXPECTED_MESSAGE: 'Something went wrong. Please try again.',
  submitAuthForm: async () => ({ ok: true, result: { success: true, email: 'synthetic@example.test', redirectTo: resolvedDestination } }),
}));
mock.module('@/lib/env-config', () => ({
  getEnv: () => ({ AUTH_METHODS: 'magic,password', AUTH_PROVIDERS: '' }),
}));
const uiToastMock = () => ({ errorToast: () => {} });
mock.module('@kortix/ui/toast', uiToastMock);
const { default: AuthPage } = await import('./page');


async function renderPage() {
  let tree!: ReturnType<typeof create>;
  await act(async () => { tree = create(<NextIntlClientProvider locale="en" messages={messages}><AuthPage /></NextIntlClientProvider>); });
  return tree;
}

test('email code verifies the sent address, establishes returned tokens, and navigates safely', async () => {
  calls = []; destination = ''; failure = false; query = 'returnUrl=https://evil.test';
  const tree = await renderPage();
  try {
    await act(async () => tree.root.findByProps({ autoComplete: 'email' }).props.onChange({ target: { value: 'synthetic@example.test' } }));
    await act(async () => tree.root.findByType('form').props.onSubmit({ preventDefault() {} }));
    const digits = tree.root.findAllByType('input').filter(n => n.props.inputMode === 'numeric');
    expect(digits).toHaveLength(6);
    await act(async () => digits[0].props.onChange({ target: { value: '123456' } }));
    await act(async () => tree.root.findByType('form').props.onSubmit({ preventDefault() {} }));
    expect(calls[0]).toEqual({ email: 'synthetic@example.test', token: '123456', type: 'email' });
    expect(calls[1]).toEqual({ access_token: 'synthetic-access', refresh_token: 'synthetic-refresh' });
    expect(destination).toBe('/projects/start');
  } finally { await act(async () => tree.unmount()); }
});

for (const mode of ['invalid', 'missing', 'network'] as const) {
test(`${mode} code failure stays on the form with safe copy and permits retry`, async () => {
  calls = []; destination = ''; failure = mode; query = '';
  const tree = await renderPage();
  try {
    await act(async () => tree.root.findByProps({ autoComplete: 'email' }).props.onChange({ target: { value: 'synthetic@example.test' } }));
    await act(async () => tree.root.findByType('form').props.onSubmit({ preventDefault() {} }));
    const digits = tree.root.findAllByType('input').filter(n => n.props.inputMode === 'numeric');
    expect(digits).toHaveLength(6);
    await act(async () => digits[0].props.onChange({ target: { value: '123456' } }));
    await act(async () => tree.root.findByType('form').props.onSubmit({ preventDefault() {} }));
    expect(JSON.stringify(tree.toJSON())).toContain(mode === 'network' ? 'The request could not be sent' : 'Invalid or expired code');
    expect(JSON.stringify(tree.toJSON())).not.toContain('private upstream detail');
    expect(destination).toBe('');
    expect(tree.root.findAllByType('input').filter(n => n.props.inputMode === 'numeric').every(n => !n.props.disabled)).toBe(true);
  } finally { failure = false; await act(async () => tree.unmount()); }
});

}

for (const flags of ['expired=true', 'error=private-query-detail']) {
  test(`callback notice is safe for ${flags.split('=')[0]}`, async () => {
    query = flags;
    const tree = await renderPage();
    try {
      expect(tree.root.findAllByProps({ role: 'alert' }).length).toBeGreaterThan(0);
      expect(JSON.stringify(tree.toJSON())).toContain('The link is invalid or expired.');
      expect(JSON.stringify(tree.toJSON())).not.toContain('Invalid or expired code');
      expect(JSON.stringify(tree.toJSON())).not.toContain('private-query-detail');
    } finally { await act(async () => tree.unmount()); }
  });
}

for (const target of ['/projects/existing', '/invites/synthetic', '/projects/start']) {
  test(`OTP preserves the server-resolved destination ${target}`, async () => {
    query = 'returnUrl=/projects/existing'; calls = []; destination = ''; resolvedDestination = target;
    const tree = await renderPage();
    try {
      await act(async () => tree.root.findByProps({ autoComplete: 'email' }).props.onChange({ target: { value: 'synthetic@example.test' } }));
      await act(async () => tree.root.findByType('form').props.onSubmit({ preventDefault() {} }));
      const digits = () => tree.root.findAllByType('input').filter(n => n.props.inputMode === 'numeric');
      await act(async () => digits()[0].props.onChange({ target: { value: '01234' } }));
      await act(async () => tree.root.findByType('form').props.onSubmit({ preventDefault() {} }));
      expect(calls).toHaveLength(0);
      await act(async () => digits()[5].props.onChange({ target: { value: '5' } }));
      await act(async () => tree.root.findByType('form').props.onSubmit({ preventDefault() {} }));
      expect(calls[0]).toEqual({ email: 'synthetic@example.test', token: '012345', type: 'email' });
      expect(destination).toBe(target);
    } finally { resolvedDestination = undefined; await act(async () => tree.unmount()); }
  });
}
