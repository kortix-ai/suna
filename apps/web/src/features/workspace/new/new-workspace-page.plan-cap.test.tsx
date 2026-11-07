import { expect, mock, test } from 'bun:test';
import { configureKortix } from '@kortix/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { UiProvider, defaultUiNavigation } from '@kortix/ui/providers/ui-provider';
import { createElement, forwardRef, type ReactNode } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

/**
 * `/workspaces/new`: the create and its landing.
 *
 * The page used to pre-check the target account's one-project cap
 * (KRTX-2495). Every create now makes a new workspace (Workspaces D3), so
 * the cap never applies to it: the form shows no cap line and Create stays
 * enabled. The quota hook stays mocked so a read of it is visible.
 * Creation runs the real hook, orchestration and SDK transport; only the
 * configured HTTP fetch returns synthetic provision responses.
 */

let creates = 0;
let provisioned = false;
let query = '';
const destinations: string[] = [];
let failCreate = false;
const payloads: string[] = [];
configureKortix({
  backendUrl: 'https://pairing.example.test/v1',
  getToken: async () => 'synthetic-token',
  fetch: async (input, init) => {
    const path = new URL(String(input)).pathname;
    // `POST /v1/workspaces` (the SDK's createWorkspace, streamed): a new
    // workspace with its own account.
    if (path === '/v1/workspaces' && init?.method === 'POST') {
      creates += 1;
      payloads.push(String(init?.body));
      if (failCreate) return Response.json({ error: 'Temporary outage' }, { status: 502 });
      provisioned = true;
      return new Response('data: {"type":"done","project":{"project_id":"created-project","account_id":"user-1"}}\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
    }
    throw new Error(`Unexpected request: ${path}`);
  },
});

/** The quota payload the mocked `useProjectQuota` returns; undefined = in flight. */
let quotaData: { capped: boolean; message: string | null } | undefined;
/** Account ids the page asked the quota for, in order. */
const quotaCalls: (string | null | undefined)[] = [];

mock.module('@kortix/ui/workspace/new/use-project-quota', () => ({
  useProjectQuota: (accountId: string | null | undefined) => {
    quotaCalls.push(accountId);
    return { data: quotaData };
  },
}));

mock.module('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: (path: string) => { destinations.push(path); }, back: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(query),
  useParams: () => ({}),
  usePathname: () => '/workspaces/new',
}));
mock.module('@/features/providers/auth-provider', () => ({
  useAuth: () => ({
    user: { id: 'user-1', email: 'pr-demo@example.test', user_metadata: { name: 'Demo' } },
    isLoading: false,
  }),
}));
mock.module('@/lib/auth/use-signed-out-redirect', () => ({ useSignedOutRedirect: () => {} }));
mock.module('@kortix/ui/internal/hooks/account/use-accounts-list', () => ({
  useAccountsList: () => ({
    data: [
      { account_id: 'user-1', name: 'Personal', account_role: 'owner', is_primary_owner: true },
    ],
    isLoading: false,
  }),
}));
// The caller owns one workspace: the GitHub source account (`githubSourceAccount`).
mock.module('@kortix/ui/workspace/sidebar/use-workspace-directory', () => ({
  useWorkspaceDirectory: () => ({
    accounts: [{ account_id: 'user-1', name: 'Personal', account_role: 'owner' }],
    workspaces: [],
    loading: false,
    failedAccountIds: [],
    reusableAccount: null,
    githubSourceAccount: { account_id: 'user-1', name: 'Personal', account_role: 'owner' },
    retryFailed: () => {},
  }),
}));
mock.module('@kortix/ui/internal/hooks/admin/use-admin-role', () => ({ useAdminRole: () => ({ data: null }) }));
// The upgrade modal's content runs react-query git/billing queries against no
// provider; which plans it offers is not what these tests assert. The dialog
// STORE stays real — the Upgrade click is asserted through it.
mock.module('@/features/billing/global-upgrade-modal', () => ({
  GlobalUpgradeModal: () => createElement('div', { 'data-testid': 'upgrade-modal-stub' }),
}));
// The top bar and the Advanced (GitHub source) field are not what these tests
// assert; the Advanced field also runs react-query git-account queries. Stubs
// keep the render surface on the name field, the cap state and the submit path.
mock.module('@/features/workspace/account-top-bar', () => ({
  AccountTopBar: () => createElement('header'),
}));
mock.module('@kortix/ui/workspace/new/advanced-fields', () => ({
  AdvancedFields: () => createElement('div', { 'data-testid': 'advanced-stub' }),
}));

// motion/react with no DOM: render the same tag with the animation-only props
// stripped, and always claim reduced motion so no animation timing runs.
const MOTION_ONLY_PROPS = new Set([
  'initial',
  'animate',
  'exit',
  'transition',
  'variants',
  'whileHover',
  'whileTap',
  'whileInView',
  'viewport',
  'layout',
  'layoutId',
]);
const motionComponents = new Proxy(
  {},
  {
    get: (_target, tag: string) =>
      forwardRef(function MotionStub(motionProps: Record<string, unknown>, ref) {
        const domProps = Object.fromEntries(
          Object.entries(motionProps).filter(([key]) => !MOTION_ONLY_PROPS.has(key)),
        );
        return createElement(tag, { ...domProps, ref });
      }),
  },
);
const motionValue = (initial: number) => ({
  get: () => initial,
  set: () => {},
  on: () => () => {},
  addEventListener: () => () => {},
  hasListeners: () => false,
  remove: () => {},
  destroy: () => {},
});
mock.module('motion/react', () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) => <>{children}</>,
  // @kortix/ui's UiProvider wraps its tree in LazyMotion.
  LazyMotion: ({ children }: { children: ReactNode }) => <>{children}</>,
  m: motionComponents,
  animate: () => Promise.resolve(),
  useMotionValue: (initial: number) => motionValue(initial),
  useReducedMotion: () => true,
}));

const { NewWorkspacePage } = await import('./new-workspace-page');


function setBilling(enabled: boolean): void {
  process.env.NEXT_PUBLIC_BILLING_ENABLED = enabled ? 'true' : 'false';
}

function findInput(renderer: ReactTestRenderer): ReactTestInstance {
  const input = renderer.root.findAll(
    (node) => node.type === 'input' && node.props.id === 'workspace-name',
  )[0];
  if (!input) throw new Error('workspace-name input not rendered');
  return input;
}

function findForm(renderer: ReactTestRenderer): ReactTestInstance {
  const form = renderer.root.findAll((node) => node.type === 'form')[0];
  if (!form) throw new Error('create form not rendered');
  return form;
}

function findSubmit(renderer: ReactTestRenderer): ReactTestInstance {
  const button = renderer.root.findAll(
    (node) => node.type === 'button' && node.props.type === 'submit',
  )[0];
  if (!button) throw new Error('submit button not rendered');
  return button;
}

/** The alert paragraph the cap block renders, or null when no cap is shown. */
function capText(renderer: ReactTestRenderer): string | null {
  const alerts = renderer.root.findAll(
    (node) =>
      node.type === 'p' &&
      typeof node.props.className === 'string' &&
      node.props.className.includes('text-destructive'),
  );
  if (alerts.length === 0) return null;
  return alerts[0].children.filter((child): child is string => typeof child === 'string').join('');
}

/** The button whose label contains `text`, or null when none is rendered. */
function findButtonWithText(renderer: ReactTestRenderer, text: string): ReactTestInstance | null {
  return (
    renderer.root.findAll((node) => {
      if (node.type !== 'button') return false;
      const label = node.children
        .filter((child): child is string => typeof child === 'string')
        .join('');
      return label.includes(text);
    })[0] ?? null
  );
}

async function renderPage(): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    renderer = create(
      <QueryClientProvider client={client}>
        <UiProvider useViewerId={() => 'user-1'} navigation={{ ...defaultUiNavigation, useRouter: () => ({ push: () => {}, replace: (path: string) => { destinations.push(path); }, back: () => {}, prefetch: () => {} }) }}>
          <NewWorkspacePage />
        </UiProvider>
      </QueryClientProvider>,
    );
  });
  if (!renderer) throw new Error('page did not render');
  return renderer;
}

async function type(renderer: ReactTestRenderer, value: string): Promise<void> {
  await act(async () => {
    findInput(renderer).props.onChange({ target: { value } });
  });
}

async function unmount(renderer: ReactTestRenderer): Promise<void> {
  await act(async () => {
    renderer.unmount();
  });
}

test('an occupied workspace never blocks the form: Create submits a new workspace and reads no quota', async () => {
  // Every create makes a new account (Workspaces D3), so the old one-project
  // pre-check (KRTX-2495) has nothing to say: no cap line, Create enabled.
  setBilling(true);
  creates = 0;
  payloads.length = 0;
  quotaCalls.length = 0;
  const renderer = await renderPage();
  await type(renderer, 'Valid Name');
  expect(capText(renderer)).toBeNull();
  expect(findSubmit(renderer).props.disabled).toBe(false);
  await act(async () => {
    findForm(renderer).props.onSubmit({ preventDefault: () => {} });
  });
  expect(creates).toBe(1);
  expect(JSON.parse(payloads[0]!)).not.toHaveProperty('account_id');
  expect(quotaCalls).toEqual([]);
  await unmount(renderer);
});

test('the first project created from the pairing entry lands on My computer', async () => {
  query = 'connect=computer';
  provisioned = false;
  quotaData = { capped: false, message: null };
  const renderer = await renderPage();
  await type(renderer, 'Pairing workspace');
  await act(async () => {
    findForm(renderer).props.onSubmit({ preventDefault: () => {} });
  });
  expect(provisioned).toBe(true);
  expect(destinations.at(-1)).toBe('/workspaces/created-project/settings/computer');
  await unmount(renderer);
  query = '';
});

test('ordinary creation and hostile destinations keep the default project landing', async () => {
  for (const value of ['', 'connect=https://example.test', 'connect=//example.test', 'connect=computer/../admin']) {
    query = value;
    const renderer = await renderPage();
    await act(async () => { findForm(renderer).props.onSubmit({ preventDefault: () => {} }); });
    expect(destinations.at(-1)).toBe('/workspaces/created-project');
    await unmount(renderer);
  }
  query = '';
});

test('retry resends the failed attempt and retains the computer destination', async () => {
  query = 'connect=computer';
  failCreate = true;
  const renderer = await renderPage();
  await type(renderer, 'Original name');
  await act(async () => { findForm(renderer).props.onSubmit({ preventDefault: () => {} }); });
  expect(findButtonWithText(renderer, 'Try again')).not.toBeNull();
  await type(renderer, 'Edited after failure');
  failCreate = false;
  await act(async () => { findButtonWithText(renderer, 'Try again')?.props.onClick(); });
  expect(JSON.parse(payloads.at(-1) ?? '{}').name).toBe('Original name');
  // A whole new workspace (`POST /v1/workspaces`): the server picks the
  // account, so none is sent.
  expect(JSON.parse(payloads.at(-1) ?? '{}').account_id).toBeUndefined();
  expect(JSON.parse(payloads.at(-1) ?? '{}').idempotency_key).toBe(JSON.parse(payloads.at(-2) ?? '{}').idempotency_key);
  expect(destinations.at(-1)).toBe('/workspaces/created-project/settings/computer');
  await unmount(renderer);
  query = '';
});

test('a same-origin returnUrl gets the person back after the create; a foreign one does not', async () => {
  for (const [value, expected] of [
    [`returnUrl=${encodeURIComponent('/cli/authorize?user_code=ABCD-EFGH')}`, '/cli/authorize?user_code=ABCD-EFGH'],
    [`returnUrl=${encodeURIComponent('//example.test/steal')}`, '/workspaces/created-project'],
    [`returnUrl=${encodeURIComponent('https://example.test/')}`, '/workspaces/created-project'],
  ] as const) {
    query = value;
    const renderer = await renderPage();
    await act(async () => { findForm(renderer).props.onSubmit({ preventDefault: () => {} }); });
    expect(destinations.at(-1)).toBe(expected);
    await unmount(renderer);
  }
  query = '';
});
