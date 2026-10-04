import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as realReactQuery from '@tanstack/react-query';
import * as realUseMfa from '@/hooks/account/use-mfa';
import { createElement, useState } from 'react';
import { act, create } from 'react-test-renderer';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

/**
 * KRTX-1386: the two sensitive Security-tab actions — Remove factor and
 * Sign out other devices — sit behind the same TOTP step-up as sign-in.
 * While the session still owes the challenge (aal1 with a verified TOTP
 * factor), pressing either one opens the step-up dialog and the action runs
 * only after the code verifies. An already-verified session (aal2) runs the
 * action directly.
 *
 * `useMfa` is injected as a fixture (its own mutations pre-date this change
 * and are out of scope); this file pins the Security tab's WIRING: which
 * action is deferred, what event opens the dialog, and that the action runs
 * once.
 */

type Fixture = {
  challengeRequired: boolean;
  factors: Array<{ id: string; factor_type?: string; status?: string }>;
};

let fixture: Fixture;
const confirmRemoveCalls: string[] = [];
const signOutCalls: unknown[] = [];

// Spread the real module and override only `useMfa`: mfa-step-up also imports
// the query-key constants from it.
mock.module('@/hooks/account/use-mfa', () => ({
  ...realUseMfa,
  useMfa: () => {
    const [target, setTarget] = useState<string | null>(null);
    return {
      factors: fixture.factors,
      factorsLoading: false,
      factorsError: false,
      onRetryFactors: () => {},
      sessionVerified: !fixture.challengeRequired,
      challengeRequired: fixture.challengeRequired,
      enrolling: null,
      enrollCode: '',
      setEnrollCode: () => {},
      startEnroll: () => {},
      isStartingEnroll: false,
      verifyEnroll: () => {},
      isVerifyingEnroll: false,
      cancelEnroll: () => {},
      removeFactorTarget: target,
      setRemoveFactorTarget: setTarget,
      confirmRemoveFactor: () => {
        if (target) confirmRemoveCalls.push(target);
      },
      isRemovingFactor: false,
    };
  },
}));

mock.module('@/lib/supabase/client', () => ({
  createClient: () => ({
    // The container also mounts the signed-in-device query (KRTX-1392) on the
    // same client; give it a session record so it renders instead of erroring.
    auth: {
      signOut: async (options: unknown) => signOutCalls.push(options),
      getUser: async () => ({
        data: { user: { last_sign_in_at: '2026-01-01T00:00:00.000Z' } },
        error: null,
      }),
    },
  }),
}));

// Spread the real module and override only the hooks this file drives: the
// real mfa-step-up module is also loaded here (requestMfaStepUp) and imports
// the rest of the react-query surface by name.
mock.module('@tanstack/react-query', () => ({
  ...realReactQuery,
  // Only useMutation is stubbed (the sign-out mutation is driven by hand).
  // useQuery and useQueryClient stay real: the container's signed-in-device
  // query (KRTX-1392) and the invalidate call both need a live client.
  useMutation: (options: { mutationFn: (arg?: unknown) => Promise<unknown> }) => ({
    mutate: (arg?: unknown) => void options.mutationFn(arg),
    isPending: false,
  }),
}));

mock.module('@/i18n/use-translations', () => ({
  useTranslations:
    () => (key: string) =>
      ({
        twoFactorTitle: 'Two-factor authentication',
        authenticatorApp: 'Authenticator app',
        addAuthenticatorApp: 'Add authenticator app',
        removeFactor: 'Remove factor',
        devices: 'Devices',
        signOutOtherDevices: 'Sign out other devices',
        removeFactorTitle: 'Remove this factor?',
        removeFactorDescription: '…',
        removeFactorLabel: 'Remove factor',
      })[key] ?? key,
}));

mock.module('@/components/ui/toast', () => ({
  successToast: () => {},
  errorToast: () => {},
}));

// The real ConfirmDialog is a Radix portal; the wiring under test is what
// SecurityTab passes as onConfirm. A bare button keeps the tree assertable.
mock.module('@/components/ui/confirm-dialog', () => ({
  ConfirmDialog: ({
    open,
    onConfirm,
    confirmLabel,
  }: {
    open?: boolean;
    onConfirm?: () => void;
    confirmLabel?: string;
  }) =>
    open
      ? createElement(
          'button',
          { onClick: onConfirm, 'data-testid': 'confirm-remove' },
          confirmLabel ?? 'confirm',
        )
      : null,
}));

const { SecurityTab } = await import('./security-tab');

type TestInstance = {
  type?: unknown;
  props?: Record<string, unknown> | null;
  children?: Array<TestInstance | string>;
};

/** All descendent text of an instance, text nodes included. */
const textOf = (node: unknown): string => {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  const n = node as TestInstance;
  if (n == null) return '';
  return textOf(n.children ?? []);
};

const buttons = (renderer: unknown): TestInstance[] => {
  const found: TestInstance[] = [];
  const visit = (node: unknown): void => {
    const n = node as TestInstance;
    if (n == null || typeof n !== 'object') return;
    if (n.type === 'button') found.push(n);
    (n.children ?? []).forEach(visit);
  };
  const start = (renderer as { root?: unknown }).root ?? renderer;
  visit(start);
  return found;
};

const findButton = (
  renderer: unknown,
  match: (n: TestInstance) => boolean,
): TestInstance | undefined => buttons(renderer).find(match);

const byLabel = (label: string) => (n: TestInstance) => n.props?.['aria-label'] === label;
const byTestId = (id: string) => (n: TestInstance) => n.props?.['data-testid'] === id;
const byText = (text: string) => (n: TestInstance) => textOf(n).includes(text);

async function mountSecurityTab() {
  const client = new realReactQuery.QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  let root: ReturnType<typeof create> | undefined;
  await act(async () => {
    root = create(
      createElement(
        realReactQuery.QueryClientProvider,
        { client },
        createElement(SecurityTab),
      ),
    );
  });
  if (!root) throw new Error('SecurityTab did not render');
  return root;
}

async function click(
  root: ReturnType<typeof create>,
  button: TestInstance,
): Promise<void> {
  await act(async () => {
    (button.props?.onClick as () => void)();
  });
}

const events: string[] = [];
const record = (name: string) => () => events.push(name);

// bun test has no `window`; a fresh EventTarget per test also discards every
// `{ once: true }` step-up listener between cases.
const originalWindow = globalThis.window;
beforeEach(() => {
  globalThis.window = new EventTarget() as unknown as Window & typeof globalThis;
});
afterEach(() => {
  globalThis.window = originalWindow;
});
beforeEach(() => {
  fixture = {
    challengeRequired: true,
    factors: [{ id: 'f-totp', factor_type: 'totp', status: 'verified' }],
  };
  confirmRemoveCalls.length = 0;
  signOutCalls.length = 0;
  events.length = 0;
  window.addEventListener('kortix:mfa-required', record('required'));
  window.addEventListener('kortix:mfa-verified', record('verified'));
});

describe('SecurityTab — remove factor behind the TOTP step-up', () => {
  test('a session that owes the challenge opens the step-up first; the removal waits for the code', async () => {
    const root = await mountSecurityTab();

    await click(root, findButton(root, byLabel('Remove factor'))!);
    const confirm = findButton(root, byTestId('confirm-remove'));
    if (!confirm) throw new Error('confirm dialog did not open');
    await click(root, confirm);

    expect(events).toEqual(['required']);
    expect(confirmRemoveCalls).toEqual([]);

    window.dispatchEvent(new CustomEvent('kortix:mfa-verified'));
    expect(confirmRemoveCalls).toEqual(['f-totp']);
  });

  test('a verified session removes the factor directly', async () => {
    fixture.challengeRequired = false;
    const root = await mountSecurityTab();

    await click(root, findButton(root, byLabel('Remove factor'))!);
    const confirm = findButton(root, byTestId('confirm-remove'));
    if (!confirm) throw new Error('confirm dialog did not open');
    await click(root, confirm);

    expect(events).toEqual([]);
    expect(confirmRemoveCalls).toEqual(['f-totp']);
  });
});

describe('SecurityTab — sign out other devices behind the TOTP step-up', () => {
  test('a session that owes the challenge opens the step-up first; the sign-out waits for the code', async () => {
    const root = await mountSecurityTab();

    await click(root, findButton(root, byText('Sign out other devices'))!);

    expect(events).toEqual(['required']);
    expect(signOutCalls).toEqual([]);

    window.dispatchEvent(new CustomEvent('kortix:mfa-verified'));
    expect(signOutCalls).toEqual([{ scope: 'others' }]);
  });

  test('a verified session signs the other devices out directly', async () => {
    fixture.challengeRequired = false;
    const root = await mountSecurityTab();

    await click(root, findButton(root, byText('Sign out other devices'))!);

    expect(events).toEqual([]);
    expect(signOutCalls).toEqual([{ scope: 'others' }]);
  });
});
