import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { act, create } from 'react-test-renderer';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

/**
 * KRTX-1386: a verified TOTP factor must be enforced. These tests pin the two
 * enforcement surfaces:
 *
 * - `MfaGate` — mounted in the `(app)` shell. An aal1 session with a verified
 *   TOTP factor gets the challenge INSTEAD of the app; nothing of the app
 *   renders or fetches until the code verifies.
 * - `MfaStepUpProvider` — the existing per-action step-up dialog, unchanged:
 *   it opens on `kortix:mfa-required` and stays dismissible.
 * - `requestMfaStepUp` — the shared "run now, or after the code verifies"
 *   helper the Security tab uses for remove-factor / sign-out-other-devices.
 *
 * The Supabase client is mocked and the REAL `supabaseMFAService` runs, so the
 * gate decision goes through the real `getAAL` answer and the verify through
 * the real `challengeAndVerify` call shape (`factorId` + `code`).
 */

// ─── Holders ────────────────────────────────────────────────────────────────
let authState: { session: unknown; user: unknown; isLoading: boolean };
let session: unknown;
let user: { created_at?: string; factors?: Array<Record<string, unknown>> } | null;
let aal: {
  data?: { currentLevel?: string | null; nextLevel?: string | null } | null;
  error?: { message: string } | null;
};
let challengeAndVerifyResponse: { data: unknown; error: { message: string } | null };
const challengeAndVerifyCalls: Array<{ factorId: string; code: string }> = [];
const signOutCalls: string[] = [];

mock.module('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: {
      getSession: async () => ({ data: { session } }),
      getUser: async () => ({ data: { user }, error: null }),
      mfa: {
        getAuthenticatorAssuranceLevel: async () => aal,
        challengeAndVerify: async (args: { factorId: string; code: string }) => {
          challengeAndVerifyCalls.push(args);
          // The real verify mints the aal2 session BEFORE it resolves, so the
          // onSuccess refetch of the AAL answer must see aal2 here.
          aal = { data: { currentLevel: 'aal2', nextLevel: 'aal2' }, error: null };
          return challengeAndVerifyResponse;
        },
      },
    },
  }),
}));

mock.module('@/features/providers/auth-provider', () => ({ useAuth: () => authState }));
mock.module('@/lib/auth-token', () => ({ invalidateTokenCache: () => {} }));
mock.module('@/lib/auth/perform-sign-out', () => ({
  performSignOut: async () => {
    signOutCalls.push('performed');
  },
}));

const COPY: Record<string, string> = {
  text4d8f4755ac09: 'Verify it is you',
  text3ba20a470a12: 'Enter a code from your authenticator app to verify this session.',
  text0d1fa0dfcc9e: '6-digit code',
  text19766ed6ccb2: 'Cancel',
  texteea2745e2867: 'Verify',
  text48f0d3d397d4: 'Sign out',
  text4f7838402f37: 'Verified',
  texte7307911656c: 'Code did not verify',
  text669350bd2952: 'No second factor enrolled',
  textf3a4ff3c0ae3: 'Enroll an authenticator app under Settings → Security.',
};
mock.module('@/i18n/use-translations', () => ({
  useTranslations: () => Object.assign((key: string) => COPY[key] ?? key, { raw: (key: string) => COPY[key] ?? key }),
}));

const toasts: string[] = [];
mock.module('@/components/ui/toast', () => ({
  successToast: (message: string) => toasts.push(`success:${message}`),
  errorToast: (message: string) => toasts.push(`error:${message}`),
}));

// The real Dialog reaches through Radix portals and the z-stack; these tests
// assert the gate's decisions, not the overlay. A conditional render keeps the
// tree assertable.
const host = (tag: string) =>
  function Host({ children, ...props }: { children?: React.ReactNode; [key: string]: unknown }) {
    return createElement(tag, props, children);
  };
mock.module('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open?: boolean; children?: React.ReactNode }) =>
    open ? createElement('div', { 'data-dialog': 'open' }, children) : null,
  DialogContent: host('section'),
  DialogDescription: host('p'),
  DialogFooter: host('footer'),
  DialogHeader: host('header'),
  DialogTitle: host('h2'),
}));
mock.module('@/components/ui/button', () => ({
  Button: ({ children, ...props }: { children?: React.ReactNode; [key: string]: unknown }) =>
    createElement('button', props, children),
}));
mock.module('@/components/ui/input', () => ({
  Input: (props: Record<string, unknown>) => createElement('input', props),
}));
mock.module('@/components/ui/label', () => ({ Label: host('label') }));
mock.module('@/components/ui/loading', () => ({ default: host('span') }));
mock.module('@/components/ui/info-banner', () => ({
  InfoBanner: ({ children, title }: { children?: React.ReactNode; title?: React.ReactNode }) =>
    createElement('aside', null, title, children),
}));
mock.module('@phosphor-icons/react', () => ({
  ShieldCheckIcon: host('svg'),
  ShieldWarningIcon: host('svg'),
}));

const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { MfaStepUpProvider, MfaGate, requestMfaStepUp } = await import('./mfa-step-up');

// ─── Render helpers ─────────────────────────────────────────────────────────
// bun test has no `window`; the repo pattern installs a minimal shim. A fresh
// EventTarget per test also discards every `{ once: true }` step-up listener.
const originalWindow = globalThis.window;
beforeEach(() => {
  globalThis.window = new EventTarget() as unknown as Window & typeof globalThis;
});
afterEach(() => {
  globalThis.window = originalWindow;
});

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

const serialize = (root: unknown): string => JSON.stringify(root);

/** Every button descendent, via the instance tree so `props.onClick` stays callable. */
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

const input = (renderer: unknown): TestInstance | undefined => {
  const found: TestInstance[] = [];
  const visit = (node: unknown): void => {
    const n = node as TestInstance;
    if (n == null || typeof n !== 'object') return;
    if (n.type === 'input') found.push(n);
    (n.children ?? []).forEach(visit);
  };
  const start = (renderer as { root?: unknown }).root ?? renderer;
  visit(start);
  return found[0];
};

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount(
  element: React.ReactElement,
): Promise<{ root: NonNullable<ReturnType<typeof create>>; client: QueryClient }> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let root: ReturnType<typeof create> | undefined;
  await act(async () => {
    root = create(createElement(QueryClientProvider, { client }, element));
  });
  await settle();
  if (!root) throw new Error('mount produced no root');
  return { root, client };
}

const APP = createElement('p', null, 'APP CONTENT');

const verifiedTotpAal = () => {
  session = { access_token: 't' };
  user = { created_at: '2020-01-01T00:00:00.000Z', factors: [{ id: 'f-totp', factor_type: 'totp', status: 'verified' }] };
  aal = { data: { currentLevel: 'aal1', nextLevel: 'aal2' }, error: null };
};
const aal2 = () => {
  aal = { data: { currentLevel: 'aal2', nextLevel: 'aal2' }, error: null };
};

beforeEach(() => {
  authState = { session: { user: { id: 'u' } }, user: { id: 'u' }, isLoading: false };
  session = null;
  user = null;
  aal = { data: null, error: null };
  challengeAndVerifyResponse = { data: {}, error: null };
  challengeAndVerifyCalls.length = 0;
  signOutCalls.length = 0;
  toasts.length = 0;
});

// ─── MfaGate ────────────────────────────────────────────────────────────────
describe('MfaGate', () => {
  test('an aal1 session with a verified TOTP factor gets the challenge instead of the app', async () => {
    verifiedTotpAal();
    const { root } = await mount(createElement(MfaGate, null, APP));

    expect(serialize(root)).not.toContain('APP CONTENT');
    expect(input(root)).toBeDefined();
    // Non-dismissible: no Cancel, but the sign-out escape hatch stays.
    expect(buttons(root).map((b) => textOf(b.props?.children))).not.toContain('Cancel');
    expect(buttons(root).map((b) => textOf(b.props?.children))).toContain('Sign out');
  });

  test('the sign-out escape hatch signs the session out', async () => {
    verifiedTotpAal();
    const { root } = await mount(createElement(MfaGate, null, APP));
    const signOut = buttons(root).find((b) => textOf(b.props?.children) === 'Sign out');
    if (!signOut) throw new Error('no Sign out button');
    await act(async () => {
      (signOut.props?.onClick as () => void)();
    });
    expect(signOutCalls).toEqual(['performed']);
  });

  test('entering the code challenges the TOTP factor, then the app renders', async () => {
    verifiedTotpAal();
    const { root } = await mount(createElement(MfaGate, null, APP));

    const code = input(root);
    if (!code) throw new Error('no code input');
    await act(async () => {
      (code.props?.onChange as (e: { target: { value: string } }) => void)({
        target: { value: '654321' },
      });
    });
    const verify = buttons(root).find((b) => textOf(b.props?.children) === 'Verify');
    if (!verify) throw new Error('no Verify button');
    await act(async () => {
      (verify.props?.onClick as () => void)();
    });
    await settle();

    expect(challengeAndVerifyCalls).toEqual([{ factorId: 'f-totp', code: '654321' }]);
    expect(signOutCalls).toEqual([]);

    // The verify minted an aal2 session (the mock does); the onSuccess
    // invalidation refetched the AAL answer, which is what releases the gate.
    await settle();
    expect(serialize(root)).toContain('APP CONTENT');
  });

  test('an aal2 session renders the app with no dialog', async () => {
    session = { access_token: 't' };
    user = { created_at: '2020-01-01T00:00:00.000Z', factors: [{ id: 'f-totp', factor_type: 'totp', status: 'verified' }] };
    aal = { data: { currentLevel: 'aal2', nextLevel: 'aal2' }, error: null };
    const { root } = await mount(createElement(MfaGate, null, APP));

    expect(serialize(root)).toContain('APP CONTENT');
    expect(input(root)).toBeUndefined();
  });

  test('an aal1 session with nothing verified enrolled renders the app (enrollment path)', async () => {
    session = { access_token: 't' };
    user = { created_at: '2020-01-01T00:00:00.000Z', factors: [{ id: 'f-totp', factor_type: 'totp', status: 'unverified' }] };
    aal = { data: { currentLevel: 'aal1', nextLevel: 'aal1' }, error: null };
    const { root } = await mount(createElement(MfaGate, null, APP));

    expect(serialize(root)).toContain('APP CONTENT');
    expect(input(root)).toBeUndefined();
  });

  test('a verified phone factor alone does not gate (its challenge needs an SMS round trip)', async () => {
    session = { access_token: 't' };
    user = { created_at: '2020-01-01T00:00:00.000Z', factors: [{ id: 'f-phone', factor_type: 'phone', status: 'verified' }] };
    aal = { data: { currentLevel: 'aal1', nextLevel: 'aal2' }, error: null };
    const { root } = await mount(createElement(MfaGate, null, APP));

    expect(serialize(root)).toContain('APP CONTENT');
  });
});

// ─── MfaStepUpProvider (the per-action step-up, behavior unchanged) ─────────
describe('MfaStepUpProvider', () => {
  test('opens the dismissible dialog on kortix:mfa-required and keeps the app rendered', async () => {
    session = { access_token: 't' };
    user = { created_at: '2020-01-01T00:00:00.000Z', factors: [{ id: 'f-totp', factor_type: 'totp', status: 'verified' }] };
    aal = { data: { currentLevel: 'aal1', nextLevel: 'aal2' }, error: null };
    const { root } = await mount(createElement(MfaStepUpProvider, null, APP));

    expect(serialize(root)).toContain('APP CONTENT');
    expect(input(root)).toBeUndefined();

    await act(async () => {
      window.dispatchEvent(new CustomEvent('kortix:mfa-required'));
    });
    await settle();

    expect(serialize(root)).toContain('APP CONTENT');
    expect(input(root)).toBeDefined();
    expect(buttons(root).map((b) => textOf(b.props?.children))).toContain('Cancel');
  });

  test('Cancel closes the dialog without verifying', async () => {
    session = { access_token: 't' };
    user = { created_at: '2020-01-01T00:00:00.000Z', factors: [{ id: 'f-totp', factor_type: 'totp', status: 'verified' }] };
    aal = { data: { currentLevel: 'aal1', nextLevel: 'aal2' }, error: null };
    const { root } = await mount(createElement(MfaStepUpProvider, null, APP));
    await act(async () => {
      window.dispatchEvent(new CustomEvent('kortix:mfa-required'));
    });
    await settle();

    const cancel = buttons(root).find((b) => textOf(b.props?.children) === 'Cancel');
    if (!cancel) throw new Error('no Cancel button');
    await act(async () => {
      (cancel.props?.onClick as () => void)();
    });
    await settle();

    expect(input(root)).toBeUndefined();
    expect(challengeAndVerifyCalls).toEqual([]);
  });
});

// ─── requestMfaStepUp ───────────────────────────────────────────────────────
describe('requestMfaStepUp', () => {
  const events: string[] = [];
  const record = (name: string) => () => events.push(name);

  beforeEach(() => {
    events.length = 0;
    window.addEventListener('kortix:mfa-required', record('required'));
    window.addEventListener('kortix:mfa-verified', record('verified'));
  });
  test('runs the action immediately when no challenge is owed', () => {
    const ran: string[] = [];
    requestMfaStepUp(false, () => ran.push('now'));
    expect(ran).toEqual(['now']);
    expect(events).toEqual([]);
  });

  test('opens the step-up first and runs the action once the code verifies', () => {
    const ran: string[] = [];
    requestMfaStepUp(true, () => ran.push('after'));
    expect(events).toEqual(['required']);
    expect(ran).toEqual([]);

    window.dispatchEvent(new CustomEvent('kortix:mfa-verified'));
    expect(ran).toEqual(['after']);
    // The listener is once-only: a second verified event runs nothing.
    window.dispatchEvent(new CustomEvent('kortix:mfa-verified'));
    expect(ran).toEqual(['after']);
  });
});
