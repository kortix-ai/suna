// The email link is the primary sign-in path on /auth: Continue emails a link
// and lands the user on the link step — for new addresses and returning
// accounts alike. The link signs in existing accounts and registers new ones,
// and it is the only default path that works for an account created
// passwordless: GoTrue stores a random password hash for those too, so "does
// the visitor still know a password for this address" is not observable
// server-side (supabase discussion #5741). Defaulting a returning account to
// the password form dead-ends a passwordless one on a form no password can
// pass — the regression pinned here. The password form stays one explicit
// choice away ("Use a password instead" on the link step); whatever the
// resolver says, the client hands off to the link action, which re-checks
// closed signups and SSO server-side.
//
// Every step also renders its failure inline: a failed send keeps the
// banner (role=alert) on screen after the toast expires, on the step that
// produced it — password form included, since it re-offers the link.
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
let emailFailure: string | null = null;
mock.module('./actions', () => ({
  resolveAuthMode: async () => ({ mode: resolvedMode }),
}));
mock.module('@/lib/auth/submit-auth', () => ({
  AUTH_SUBMIT_TIMEOUT_MS: 30_000,
  AUTH_TIMEOUT_MESSAGE: 'This is taking longer than expected. Please try again.',
  AUTH_NETWORK_MESSAGE: 'The request could not be sent. Please try again.',
  AUTH_UNEXPECTED_MESSAGE: 'Something went wrong. Please try again.',
  submitAuthForm: async (_path: string, _body: FormData) => {
    emailCodeSends += 1;
    return emailFailure
      ? { ok: true, result: { message: emailFailure } }
      : { ok: true, result: { success: true, email: 'synthetic@example.test' } };
  },
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

function expectNoPasswordInput(tree: NonNullable<ReturnType<typeof create>>) {
  let password: unknown = null;
  try {
    password = tree.root.findByProps({ autoComplete: 'current-password' });
  } catch {
    password = null;
  }
  expect(password).toBeNull();
}

function buttonByLabel(
  tree: NonNullable<ReturnType<typeof create>>,
  label: string,
): { props: { onClick: () => void; disabled?: boolean } } | undefined {
  return tree.root
    .findAllByProps({ type: 'button' })
    .find((button) => {
      const children = button.props.children;
      return Array.isArray(children)
        ? children.some((child: unknown) => typeof child === 'string' && child.includes(label))
        : typeof children === 'string' && children.includes(label);
    });
}

// The password form is one explicit hop from the link step.
async function goToPasswordForm(root: NonNullable<ReturnType<typeof create>>) {
  const passwordButton = buttonByLabel(root, 'Use a password instead');
  if (!passwordButton) throw new Error('Use-a-password button did not render');
  await act(async () => passwordButton.props.onClick());
}

test('a returning account lands on the link step and sends no password prompt', async () => {
  resolvedMode = 'signin';
  emailCodeSends = 0;
  const root = await continueWithEmail('returning@example.test');
  try {
    expect(emailCodeSends).toBe(1);
    expectNoPasswordInput(root);
    expect(JSON.stringify(root.toJSON())).toContain('Check your email');
  } finally {
    await act(async () => root.unmount());
  }
});

test('the password form stays one explicit choice away from the link step', async () => {
  resolvedMode = 'signin';
  emailCodeSends = 0;
  const root = await continueWithEmail('returning@example.test');
  try {
    await goToPasswordForm(root);
    const password = root.root.findByProps({ autoComplete: 'current-password', type: 'password' });
    expect(password.props.name).toBe('password');
    expect(JSON.stringify(root.toJSON())).toContain('Welcome back');
    expect(emailCodeSends).toBe(1);
  } finally {
    await act(async () => root.unmount());
  }
});

test('every resolution hands off to the link action — the server gates closed and SSO', async () => {
  for (const mode of ['signup', 'unknown', 'closed']) {
    resolvedMode = mode;
    emailCodeSends = 0;
    const root = await continueWithEmail(`${mode}@example.test`);
    try {
      expect(emailCodeSends).toBe(1);
      expect(JSON.stringify(root.toJSON())).toContain('sign-in link');
    } finally {
      await act(async () => root.unmount());
    }
  }
});

test('the password form still offers the email link as an explicit choice', async () => {
  resolvedMode = 'signin';
  emailCodeSends = 0;
  const root = await continueWithEmail('returning@example.test');
  try {
    await goToPasswordForm(root);
    const linkButton = buttonByLabel(root, 'Email me a link instead');
    expect(linkButton).toBeDefined();
    if (!linkButton) throw new Error('Email-link button did not render');
    await act(async () => linkButton.props.onClick());
    expect(emailCodeSends).toBe(2);
    expect(JSON.stringify(root.toJSON())).toContain('Open it to continue');
  } finally {
    await act(async () => root.unmount());
  }
});

for (const failure of ['Email rate limit exceeded. Try again later.', 'Could not send the link']) {
  test(`failed sign-in link stays visible on the password form: ${failure}`, async () => {
    resolvedMode = 'signin';
    emailCodeSends = 0;
    const root = await continueWithEmail('returning@example.test');
    try {
      await goToPasswordForm(root);
      emailFailure = failure;
      const linkButton = buttonByLabel(root, 'Email me a link instead');
      if (!linkButton) throw new Error('Email-link button did not render');
      await act(async () => linkButton.props.onClick());
      const alerts = root.root.findAllByProps({ role: 'alert' });
      expect(alerts).toHaveLength(1);
      expect(JSON.stringify(root.toJSON())).toContain(failure);
      expect(JSON.stringify(root.toJSON())).toContain('Welcome back');
      expect(linkButton.props.disabled).toBe(false);
      emailFailure = null;
      await act(async () => linkButton.props.onClick());
      expect(root.root.findAllByProps({ role: 'alert' })).toHaveLength(0);
      expect(JSON.stringify(root.toJSON())).toContain('Open it to continue');
    } finally {
      emailFailure = null;
      await act(async () => root.unmount());
    }
  });
}
