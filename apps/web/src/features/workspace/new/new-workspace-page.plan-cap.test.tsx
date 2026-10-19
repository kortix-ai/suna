import { expect, mock, test } from 'bun:test';
import { createElement, forwardRef, type ReactNode } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

/**
 * `/new` plan-cap state, BEFORE the first failed create.
 *
 * A free account at its 1-project cap used to open `/new` with the form
 * looking fully available: Create enabled, no cap indication anywhere — the
 * cap reason only appeared after a failed submit (KRTX-2495). The page now
 * reads the account's project quota on load (`useProjectQuota` →
 * `GET /projects/quota`, the same computation `POST /provision`'s 403 gate
 * runs) and shows the cap state up front: the cap reason, the Upgrade
 * affordance, and Create disabled — before any submit.
 *
 * The quota hook is the mocked boundary here (its fetch and caching are the
 * SDK's concern, not the page's); everything between the quota payload and
 * the DOM — the disabled submit, the cap message, the Upgrade dialog wiring —
 * is the real page.
 */

let creates = 0;

/** The quota payload the mocked `useProjectQuota` returns; undefined = in flight. */
let quotaData: { capped: boolean; message: string | null } | undefined;
/** Account ids the page asked the quota for, in order. */
const quotaCalls: (string | null | undefined)[] = [];

mock.module('@/features/workspace/new/use-project-quota', () => ({
  useProjectQuota: (accountId: string | null | undefined) => {
    quotaCalls.push(accountId);
    return { data: quotaData };
  },
}));

mock.module('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
  usePathname: () => '/new',
}));
mock.module('@/features/providers/auth-provider', () => ({
  useAuth: () => ({
    user: { id: 'user-1', email: 'pr-demo@example.test', user_metadata: { name: 'Demo' } },
    isLoading: false,
  }),
}));
mock.module('@/lib/auth/use-signed-out-redirect', () => ({ useSignedOutRedirect: () => {} }));
mock.module('@/hooks/account/use-accounts-list', () => ({
  useAccountsList: () => ({
    data: [
      { account_id: 'user-1', name: 'Personal', account_role: 'owner', is_primary_owner: true },
    ],
    isLoading: false,
  }),
}));
mock.module('@/features/workspace/new/use-creatable-accounts', () => ({
  useCreatableAccounts: (accounts: unknown[]) => accounts,
}));
// The upgrade modal's content runs react-query git/billing queries against no
// provider; which plans it offers is not what these tests assert. The dialog
// STORE stays real — the Upgrade click is asserted through it.
mock.module('@/features/billing/global-upgrade-modal', () => ({
  GlobalUpgradeModal: () => createElement('div', { 'data-testid': 'upgrade-modal-stub' }),
}));
mock.module('@/features/workspace/new/use-create-workspace', () => ({
  useCreateWorkspace: () => ({
    create: () => {
      creates += 1;
    },
    status: 'idle',
    error: null,
    retry: () => {},
    canRetry: false,
    limitReached: false,
  }),
}));
// The top bar and the Advanced (GitHub source) field are not what these tests
// assert; the Advanced field also runs react-query git-account queries. Stubs
// keep the render surface on the name field, the cap state and the submit path.
mock.module('@/features/workspace/account-top-bar', () => ({
  AccountTopBar: () => createElement('header'),
}));
mock.module('@/features/workspace/new/advanced-fields', () => ({
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
const { useUpgradeDialogStore } = await import('@/stores/upgrade-dialog-store');

const CAP_MESSAGE = 'Free accounts are limited to 1 project. Upgrade to a paid plan to create more.';

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
    renderer = create(createElement(NewWorkspacePage));
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

const cappedQuota = { capped: true, message: CAP_MESSAGE };

test('a capped account sees the cap reason on load, before any submit', async () => {
  setBilling(true);
  quotaData = cappedQuota;
  const renderer = await renderPage();
  expect(capText(renderer)).toBe(CAP_MESSAGE);
  await unmount(renderer);
});

test('a capped account cannot submit: Create project is disabled and fires no request', async () => {
  setBilling(true);
  quotaData = cappedQuota;
  const renderer = await renderPage();
  await type(renderer, 'Valid Name');
  expect(findSubmit(renderer).props.disabled).toBe(true);
  await act(async () => {
    findForm(renderer).props.onSubmit({ preventDefault: () => {} });
  });
  expect(creates).toBe(0);
  await unmount(renderer);
});

test('a capped account gets the Upgrade affordance, scoped to the target account', async () => {
  setBilling(true);
  quotaData = cappedQuota;
  const renderer = await renderPage();
  const upgrade = findButtonWithText(renderer, 'Upgrade plan');
  expect(upgrade).not.toBeNull();
  await act(async () => {
    upgrade!.props.onClick();
  });
  const dialog = useUpgradeDialogStore.getState();
  expect(dialog.isOpen).toBe(true);
  expect(dialog.accountId).toBe('user-1');
  useUpgradeDialogStore.getState().closeUpgradeDialog();
  await unmount(renderer);
});

test('a capped account without billing shows the cap reason but no upgrade affordance', async () => {
  setBilling(false);
  quotaData = cappedQuota;
  const renderer = await renderPage();
  // The quota still reports the cap, and Create still cannot submit.
  expect(capText(renderer)).toBe(CAP_MESSAGE);
  expect(findSubmit(renderer).props.disabled).toBe(true);
  // Without billing there is no upgrade path to offer — no affordance.
  expect(findButtonWithText(renderer, 'Upgrade plan')).toBeNull();
  await unmount(renderer);
});

test('an account under the cap shows no cap state and Create project stays enabled', async () => {
  setBilling(true);
  quotaData = { capped: false, message: null };
  const renderer = await renderPage();
  await type(renderer, 'Valid Name');
  expect(capText(renderer)).toBeNull();
  expect(findSubmit(renderer).props.disabled).toBe(false);
  await unmount(renderer);
});

test('the quota is read for the account the create would target', async () => {
  setBilling(true);
  quotaData = cappedQuota;
  const renderer = await renderPage();
  expect(quotaCalls[0]).toBe('user-1');
  await unmount(renderer);
});
