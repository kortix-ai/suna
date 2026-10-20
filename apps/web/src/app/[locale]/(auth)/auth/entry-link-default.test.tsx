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
import { expect, jest, mock, test } from 'bun:test';
import { NextIntlClientProvider } from '@/i18n/use-translations';
import { type ReactTestInstance, act, create } from 'react-test-renderer';
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
let emailFailureStatus: number | null = null;
// The mode the send action answers with (the server-side existence check that
// decides which email GoTrue mints). Null = an older action answer without it.
let emailCodeMode: string | null = null;
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
    if (emailFailure) {
      return {
        ok: false,
        reason: 'server' as const,
        message: emailFailure,
        status: emailFailureStatus ?? 400,
      };
    }
    return {
          ok: true,
          result: {
            success: true,
            email: 'synthetic@example.test',
            ...(emailCodeMode ? { mode: emailCodeMode } : {}),
          },
        };
  },
}));
mock.module('@/lib/env-config', () => ({
  getEnv: () => ({ AUTH_METHODS: 'magic,password', AUTH_PROVIDERS: '' }),
}));
const uiToastMock = () => ({ errorToast: () => {} });
mock.module('@/components/ui/toast', uiToastMock);
mock.module('@kortix/ui/toast', uiToastMock);
const { default: AuthPage } = await import('./page');

async function continueWithEmail(
  address: string,
): Promise<NonNullable<ReturnType<typeof create>>> {
  let root: ReturnType<typeof create> | undefined;
  await act(async () => {
    root = create(
      <NextIntlClientProvider locale="en" messages={messages}><AuthPage /></NextIntlClientProvider>,
    );
  });
  if (!root) throw new Error('Auth page did not render');
  const tree = root;
  const email = tree.root.findByProps({ autoComplete: 'email' });
  await act(async () => email.props.onChange({ target: { value: address } }));
  await act(async () => tree.root.findByType('form').props.onSubmit({ preventDefault() {} }));
  return tree;
}

// The cooldown ticks one second at a time (each tick schedules the next),
// so drive the fake clock second by second — bun's advanceTimersByTime does
// not reliably fire timers scheduled by an earlier timer in the same call.
async function cooldownElapsed(
  root: NonNullable<ReturnType<typeof create>>,
  seconds: number,
) {
  for (let i = 0; i < seconds; i++) {
    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
  }
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
): ReactTestInstance | undefined {
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
    emailCodeMode = null;
    emailCodeSends = 0;
    const root = await continueWithEmail(`${mode}@example.test`);
    try {
      expect(emailCodeSends).toBe(1);
      expect(JSON.stringify(root.toJSON())).toContain('We sent a link to');
    } finally {
      await act(async () => root.unmount());
    }
  }
});

// KRTX-2195: a NEW address receives GoTrue's signup email ("Confirm your
// email"), so the link step must say the same thing the mail says — a user
// told to expect "a link" read the confirmation mail as the wrong message.
test('a new address is told a confirmation email is on its way, not a link', async () => {
  resolvedMode = 'signup';
  emailCodeMode = 'signup';
  emailCodeSends = 0;
  const root = await continueWithEmail('new-account@example.test');
  try {
    expect(emailCodeSends).toBe(1);
    expect(JSON.stringify(root.toJSON())).toContain('We sent a confirmation email to');
    expect(JSON.stringify(root.toJSON())).toContain('Confirm your email to continue');
    expect(JSON.stringify(root.toJSON())).not.toContain('We sent a link');
  } finally {
    emailCodeMode = null;
    await act(async () => root.unmount());
  }
});

test('a returning account keeps the sign-in link copy the mailbox matches', async () => {
  resolvedMode = 'signin';
  emailCodeMode = 'signin';
  emailCodeSends = 0;
  const root = await continueWithEmail('returning@example.test');
  try {
    expect(JSON.stringify(root.toJSON())).toContain('We sent a link to');
    expect(JSON.stringify(root.toJSON())).not.toContain('confirmation email');
  } finally {
    emailCodeMode = null;
    await act(async () => root.unmount());
  }
});

test('the password form still offers the email link as an explicit choice', async () => {
  jest.useFakeTimers();
  resolvedMode = 'signin';
  emailCodeSends = 0;
  const root = await continueWithEmail('returning@example.test');
  try {
    await goToPasswordForm(root);
    // The entry send armed the per-address cooldown that the password form's
    // link button now honors; let it lapse before the explicit choice.
    await cooldownElapsed(root, 30);
    const linkButton = buttonByLabel(root, 'Email me a link instead');
    expect(linkButton).toBeDefined();
    if (!linkButton) throw new Error('Email-link button did not render');
    expect(linkButton.props.disabled).toBe(false);
    await act(async () => linkButton.props.onClick());
    expect(emailCodeSends).toBe(2);
    expect(JSON.stringify(root.toJSON())).toContain('Open it to continue');
  } finally {
    jest.useRealTimers();
    await act(async () => root.unmount());
  }
});

test('a non-rate-limit send failure stays visible and the retry stays available', async () => {
  jest.useFakeTimers();
  resolvedMode = 'signin';
  emailCodeSends = 0;
  const root = await continueWithEmail('returning@example.test');
  const linkButton = () => {
    const button = buttonByLabel(root, 'Email me a link instead');
    if (!button) throw new Error('Email-link button did not render');
    return button;
  };
  try {
    await goToPasswordForm(root);
    // The entry send armed the per-address cooldown; let it lapse so the
    // click under test is the first send from this step.
    await cooldownElapsed(root, 30);
    expect(linkButton().props.disabled).toBe(false);
    emailFailure = 'Could not send the link';
    emailFailureStatus = 400;
    await act(async () => linkButton().props.onClick());
    const alerts = root.root.findAllByProps({ role: 'alert' });
    expect(alerts).toHaveLength(1);
    expect(JSON.stringify(root.toJSON())).toContain('Could not send the link');
    expect(JSON.stringify(root.toJSON())).toContain('Welcome back');
    // An ordinary rejection is worth one immediate retry — no cooldown.
    expect(linkButton().props.disabled).toBe(false);
    emailFailure = null;
    await act(async () => linkButton().props.onClick());
    expect(root.root.findAllByProps({ role: 'alert' })).toHaveLength(0);
    expect(JSON.stringify(root.toJSON())).toContain('Open it to continue');
  } finally {
    emailFailure = null;
    emailFailureStatus = null;
    jest.useRealTimers();
    await act(async () => root.unmount());
  }
});

// A refused send is rate-limited, not broken: re-firing it seconds later
// fails the same way (the dogfood run clicked through five doomed attempts).
// The 429 must cool the password form's link button down — disabled, with a
// visible countdown — until the window has passed.
test('a rate-limited send cools the password form link button down', async () => {
  jest.useFakeTimers();
  resolvedMode = 'signin';
  emailCodeSends = 0;
  const root = await continueWithEmail('returning@example.test');
  const linkButton = () => {
    const button = buttonByLabel(root, 'Email me a link instead');
    if (!button) throw new Error('Email-link button did not render');
    return button;
  };
  try {
    await goToPasswordForm(root);
    // The entry send armed the same per-address cooldown; let it lapse so the
    // click under test is the first send from this step.
    await cooldownElapsed(root, 30);
    expect(linkButton().props.disabled).toBe(false);

    emailFailure = 'Email rate limit exceeded. Try again later.';
    emailFailureStatus = 429;
    await act(async () => linkButton().props.onClick());
    expect(emailCodeSends).toBe(2);
    const alerts = root.root.findAllByProps({ role: 'alert' });
    expect(alerts).toHaveLength(1);
    expect(JSON.stringify(root.toJSON())).toContain('Email rate limit exceeded');
    expect(JSON.stringify(root.toJSON())).toContain('Welcome back');
    expect(linkButton().props.disabled).toBe(true);
    expect(JSON.stringify(root.toJSON())).toContain('Resend in');

    // The countdown ticks while the visitor stays on the password form.
    await cooldownElapsed(root, 15);
    expect(JSON.stringify(root.toJSON())).toContain('Resend in');
    expect(linkButton().props.disabled).toBe(true);
    await cooldownElapsed(root, 15);
    expect(JSON.stringify(root.toJSON())).not.toContain('Resend in');
    expect(linkButton().props.disabled).toBe(false);

    // After the cooldown a retry is a real, working affordance again.
    emailFailure = null;
    emailFailureStatus = null;
    await act(async () => linkButton().props.onClick());
    expect(emailCodeSends).toBe(3);
    expect(JSON.stringify(root.toJSON())).toContain('Open it to continue');
  } finally {
    emailFailure = null;
    emailFailureStatus = null;
    jest.useRealTimers();
    await act(async () => root.unmount());
  }
});

// KRTX-2812: the first Continue on the entry step answered 429 (the shared
// email budget), and a few seconds later the form looked untouched: the only
// signal was a toast. The refusal must stay on the form as an alert.
test('a rate-limited first send on the entry step leaves a lasting alert on the form', async () => {
  jest.useFakeTimers();
  resolvedMode = 'signin';
  emailCodeSends = 0;
  emailFailure = 'Email rate limit exceeded. Try again later.';
  emailFailureStatus = 429;
  const root = await continueWithEmail('returning@example.test');
  try {
    await cooldownElapsed(root, 5);
    const alerts = root.root.findAllByProps({ role: 'alert' });
    expect(alerts).toHaveLength(1);
    expect(JSON.stringify(root.toJSON())).toContain('Email rate limit exceeded');
  } finally {
    emailFailure = null;
    emailFailureStatus = null;
    jest.useRealTimers();
    await act(async () => root.unmount());
  }
});
