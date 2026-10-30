/**
 * The email screen's SSO-required mode (app/auth/email.tsx, KRTX-1716). Every
 * email door (password, email code, sign-up, password reset) asks
 * `POST /v1/access/check-email` first, and calls GoTrue only when the answer
 * is not `sso`. The SSO form holds the SSO entry point alone, and it applies
 * only to the address it was opened for.
 *
 * The SDK is real: a stubbed `fetch` answers the check.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

type HostProps = React.PropsWithChildren<Record<string, unknown>>;
const host =
  (name: string) =>
  ({ children, ...props }: HostProps) =>
    React.createElement(name, props, children);
const none = () => null;

const ENFORCED = 'member@sso.example.test';
const OPEN = 'member@open.example.test';

let params: Record<string, string> = {};
const goTrue: string[] = [];
const checked: string[] = [];
const ok = async (name: string, input: { email: string }) => {
  goTrue.push(`${name} ${input.email}`);
  return { success: true };
};

mock.module('react-native', () => ({
  View: host('view'),
  BackHandler: { addEventListener: () => ({ remove: none }) },
}));
mock.module('expo-router', () => ({
  Stack: { Screen: none },
  useLocalSearchParams: () => params,
  useRouter: () => ({ replace: none, back: none, canGoBack: () => true }),
}));
mock.module('expo-status-bar', () => ({ StatusBar: none }));
mock.module('expo-haptics', () => ({ selectionAsync: async () => {} }));
mock.module('nativewind', () => ({ useColorScheme: () => ({ colorScheme: 'light' }) }));
mock.module('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
mock.module('react-native-keyboard-controller', () => ({
  KeyboardAwareScrollView: host('scroll'),
}));
mock.module('@/lib/icons', () => ({ CaretLeftIcon: none }));
mock.module('@/components/kortix/pill-input', () => ({ PillInput: host('input') }));
mock.module('@/lib/ui/use-field-refocus', () => ({ useFieldRefocus: () => none }));
mock.module('@/components/kortix/settings-list', () => ({ SettingsGroup: host('group') }));
mock.module('@/components/ui/button', () => ({ Button: host('button') }));
mock.module('@/components/ui/icon', () => ({ Icon: none }));
mock.module('@/components/ui/text', () => ({ Text: host('text') }));
mock.module('@/api/config', () => ({ API_URL: 'http://backend.test/v1' }));
mock.module('@/api/supabase', () => ({ supabase: { auth: {} } }));
mock.module('@/lib/auth/auth-config', () => ({ magicLinkEnabled: true, passwordEnabled: true }));
mock.module('@/lib/logger', () => ({ log: { error: none, warn: none, info: none, log: none } }));
mock.module('@/contexts', () => ({
  useLanguage: () => ({ t: (_key: string, fallback: string) => fallback }),
  useAuthContext: () => ({
    signIn: (input: { email: string }) => ok('signIn', input),
    signUp: (input: { email: string }) => ok('signUp', input),
    signInWithMagicLink: (input: { email: string }) => ok('signInWithMagicLink', input),
    resetPassword: (input: { email: string }) => ok('resetPassword', input),
    signInWithSSO: async (email: string) => {
      goTrue.push(`signInWithSSO ${email}`);
      return { success: true };
    },
  }),
}));

let EmailAuthScreen: typeof import('../../app/auth/email').default;
const realFetch = globalThis.fetch;
beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  ({ default: EmailAuthScreen } = await import('../../app/auth/email'));
});

beforeEach(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe('http://backend.test/v1/access/check-email');
    const { email } = JSON.parse(String(init?.body)) as { email: string };
    checked.push(email);
    const mode = email.endsWith('@sso.example.test') ? 'sso' : 'signin';
    return new Response(JSON.stringify({ allowed: true, mode }), { status: 200 });
  }) as typeof fetch;
});

let tree: ReactTestRenderer | undefined;
afterEach(() => {
  act(() => tree?.unmount());
  tree = undefined;
  globalThis.fetch = realFetch;
  params = {};
  goTrue.length = 0;
  checked.length = 0;
});

function render() {
  act(() => {
    tree = create(<EmailAuthScreen />);
  });
}

const textOf = (node: ReactTestInstance | string): string =>
  typeof node === 'string' ? node : node.children.map(textOf).join('');

const buttons = (label: string) =>
  tree!.root.findAll((n) => n.type === 'button' && textOf(n) === label);
const fields = (label: string) =>
  tree!.root.findAll((n) => n.type === 'input' && n.props.accessibilityLabel === label);
/** What the screen shows, by label: a boolean, so a failure prints a line, not a fiber. */
const hasButton = (label: string) => buttons(label).length > 0;
const hasField = (label: string) => fields(label).length > 0;
const hasNotice = () =>
  tree!.root.findAll((n) => n.type === 'text' && textOf(n).startsWith('Your organization requires'))
    .length > 0;
const emailValue = () => fields('Email address')[0]?.props.value;

function type(label: string, value: string) {
  act(() => fields(label)[0].props.onChangeText(value));
}

async function press(label: string) {
  expect(hasButton(label)).toBe(true);
  const target = buttons(label)[0];
  await act(async () => {
    target.props.onPress();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** The SSO form: the reason, the email, Continue with SSO. No other door. */
function expectSsoForm(email: string) {
  expect({
    notice: hasNotice(),
    email: emailValue(),
    sso: hasButton('Continue with SSO'),
    password: hasField('Password'),
    forgot: hasButton('Forgot password?'),
    createAccount: hasButton('Create account'),
    emailCode: hasButton('Use email code'),
  }).toEqual({
    notice: true,
    email,
    sso: true,
    password: false,
    forgot: false,
    createAccount: false,
    emailCode: false,
  });
}

/** The ordinary sign-in form with its password door. */
function expectPasswordForm() {
  expect({
    notice: hasNotice(),
    password: hasField('Password'),
    signIn: hasButton('Sign in'),
    forgot: hasButton('Forgot password?'),
    createAccount: hasButton('Create account'),
  }).toEqual({ notice: false, password: true, signIn: true, forgot: true, createAccount: true });
}

describe('the pre-check before every email door', () => {
  test('password sign-in for an enforced email opens the SSO form and never calls GoTrue', async () => {
    render();
    type('Email address', ENFORCED);
    type('Password', 'synthetic-password');
    await press('Sign in');
    expect(checked).toEqual([ENFORCED]);
    expect(goTrue).toEqual([]);
    expectSsoForm(ENFORCED);
  });

  test('password sign-in for an email outside the domain goes to GoTrue', async () => {
    render();
    type('Email address', OPEN);
    type('Password', 'synthetic-password');
    await press('Sign in');
    expect(checked).toEqual([OPEN]);
    expect(goTrue).toEqual([`signIn ${OPEN}`]);
  });

  test('an email code for an enforced email is never sent', async () => {
    render();
    await press('Use email code');
    type('Email address', ENFORCED);
    await press('Continue');
    expect(goTrue).toEqual([]);
    expectSsoForm(ENFORCED);
  });

  test('sign-up for an enforced email never creates a GoTrue user', async () => {
    render();
    await press('Create account');
    type('Email address', ENFORCED);
    type('Password', 'synthetic-password');
    await press('Create account');
    expect(goTrue).toEqual([]);
    expectSsoForm(ENFORCED);
  });

  test('a password reset for an enforced email sends no recovery email', async () => {
    render();
    type('Email address', ENFORCED);
    await press('Forgot password?');
    expect(checked).toEqual([ENFORCED]);
    expect(goTrue).toEqual([]);
    expectSsoForm(ENFORCED);
  });

  test('a password reset outside the domain still sends the recovery email', async () => {
    render();
    type('Email address', OPEN);
    await press('Forgot password?');
    expect(goTrue).toEqual([`resetPassword ${OPEN}`]);
  });
});

describe('the SSO-required form', () => {
  test('after the sign-out it opens with the email and offers no password door', async () => {
    params = { reason: 'sso_required', email: ENFORCED };
    render();
    expectSsoForm(ENFORCED);
    await press('Continue with SSO');
    expect(goTrue).toEqual([`signInWithSSO ${ENFORCED}`]);
  });

  test('editing the email away from the enforced address brings the password form back', async () => {
    render();
    type('Email address', ENFORCED);
    type('Password', 'synthetic-password');
    await press('Sign in');
    expectSsoForm(ENFORCED);

    type('Email address', OPEN);
    expectPasswordForm();

    // Back to the enforced address (case and spaces do not matter): SSO again.
    type('Email address', ' Member@SSO.example.test ');
    expect({ notice: hasNotice(), password: hasField('Password') }).toEqual({
      notice: true,
      password: false,
    });
  });

  test('the sign-out entry also lets a corrected email use its password', () => {
    params = { reason: 'sso_required', email: ENFORCED };
    render();
    type('Email address', OPEN);
    expectPasswordForm();
  });

  test('?method=sso stays the SSO form for any email, without the reason', () => {
    params = { method: 'sso' };
    render();
    type('Email address', OPEN);
    expect({
      notice: hasNotice(),
      sso: hasButton('Continue with SSO'),
      password: hasField('Password'),
      forgot: hasButton('Forgot password?'),
    }).toEqual({ notice: false, sso: true, password: false, forgot: false });
  });
});
