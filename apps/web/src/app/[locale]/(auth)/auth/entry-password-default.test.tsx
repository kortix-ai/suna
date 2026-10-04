// Continue on /auth must not burn an auth email for an account that already
// exists. When the existence check says the address has an account, the
// password form opens directly and the email link stays one explicit choice
// away ("Email me a link instead") — no auth email is sent until the customer
// asks for it. New addresses and a degraded existence check keep the
// magic-link default.
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
  createClient: () => ({ auth: {} }),
}));
let resolvedMode = 'unknown';
let emailCodeSends = 0;
mock.module('./actions', () => ({
  sendEmailCode: async () => {
    emailCodeSends += 1;
    return { success: true };
  },
  resolveAuthMode: async () => ({ mode: resolvedMode }),
  signInWithPassword: async () => ({}),
  signUpWithPassword: async () => ({}),
}));
mock.module('@/lib/env-config', () => ({
  getEnv: () => ({ AUTH_METHODS: 'magic,password', AUTH_PROVIDERS: '' }),
}));
mock.module('@/components/ui/toast', () => ({ errorToast: () => {} }));
const { default: AuthPage } = await import('./page');

async function continueWithEmail(
  address: string,
): Promise<NonNullable<ReturnType<typeof create>>> {
  let root: ReturnType<typeof create> | undefined;
  await act(async () => {
    root = create(
      createElement(NextIntlClientProvider, { locale: 'en', messages }, createElement(AuthPage)),
    );
  });
  if (!root) throw new Error('Auth page did not render');
  const tree = root;
  const email = tree.root.findByProps({ autoComplete: 'email' });
  await act(async () => email.props.onChange({ target: { value: address } }));
  await act(async () => tree.root.findByType('form').props.onSubmit({ preventDefault() {} }));
  return tree;
}

test('an existing account opens the password form and sends no email', async () => {
  resolvedMode = 'signin';
  emailCodeSends = 0;
  const root = await continueWithEmail('existing@example.test');
  try {
    expect(emailCodeSends).toBe(0);
    const password = root.root.findByProps({ autoComplete: 'current-password', type: 'password' });
    expect(password.props.name).toBe('password');
    expect(JSON.stringify(root.toJSON())).toContain('Welcome back');
  } finally {
    await act(async () => root.unmount());
  }
});

test('the password form still offers the email link as an explicit choice', async () => {
  resolvedMode = 'signin';
  emailCodeSends = 0;
  const root = await continueWithEmail('existing@example.test');
  try {
    expect(emailCodeSends).toBe(0);
    const linkButton = root.root.findAllByProps({ type: 'button' }).find((button) => {
      const children = button.props.children;
      return Array.isArray(children)
        ? children.some((child: unknown) => typeof child === 'string' && child.includes('Email me a link'))
        : typeof children === 'string' && children.includes('Email me a link');
    });
    expect(linkButton).toBeDefined();
    await act(async () => linkButton!.props.onClick());
    expect(emailCodeSends).toBe(1);
  } finally {
    await act(async () => root.unmount());
  }
});

test('a new address keeps the magic-link default', async () => {
  resolvedMode = 'signup';
  emailCodeSends = 0;
  const root = await continueWithEmail('new@example.test');
  try {
    expect(emailCodeSends).toBe(1);
    expect(JSON.stringify(root.toJSON())).toContain('sign-in link');
  } finally {
    await act(async () => root.unmount());
  }
});

test('a degraded existence check keeps the magic-link default', async () => {
  resolvedMode = 'unknown';
  emailCodeSends = 0;
  const root = await continueWithEmail('unknown@example.test');
  try {
    expect(emailCodeSends).toBe(1);
    expect(JSON.stringify(root.toJSON())).toContain('sign-in link');
  } finally {
    await act(async () => root.unmount());
  }
});

test('a closed signup address keeps the magic-link default (the action carries the refusal copy)', async () => {
  resolvedMode = 'closed';
  emailCodeSends = 0;
  const root = await continueWithEmail('closed@example.test');
  try {
    expect(emailCodeSends).toBe(1);
  } finally {
    await act(async () => root.unmount());
  }
});
