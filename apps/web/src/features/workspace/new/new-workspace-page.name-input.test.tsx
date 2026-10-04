import { expect, mock, test } from 'bun:test';
import { createElement, forwardRef, type ReactNode } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

/**
 * `/new` name field: the too-long message must be reachable for TYPED input.
 *
 * The field used to carry `maxLength={120}`, so the browser silently truncated
 * typed and pasted names at 120 characters — the documented "Name must be 120
 * characters or fewer" message was unreachable (it needs a >120 value in form
 * state, which no typing can produce), and a customer could submit a silently
 * truncated name. These tests render the real page and drive the real input.
 */

let creates = 0;

mock.module('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
  usePathname: () => '/new',
  useSelectedLayoutSegment: () => null,
  useSelectedLayoutSegments: () => [],
  redirect: () => {},
  permanentRedirect: () => {},
  notFound: () => {},
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
// keep the render surface on the name field, its message and the submit path.
mock.module('@/features/workspace/account-top-bar', () => ({
  AccountTopBar: () => createElement('header'),
}));
mock.module('@/features/workspace/new/advanced-fields', () => ({
  AdvancedFields: () => createElement('div', { 'data-testid': 'advanced-stub' }),
}));

// motion/react with no DOM: render the same tag with the animation-only props
// stripped, and always claim reduced motion so no animation timing runs. The
// import graph pulls more names from this module than the page itself does,
// so the usual set answers with inert stubs.
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
  LazyMotion: ({ children }: { children: ReactNode }) => <>{children}</>,
  MotionConfig: ({ children }: { children: ReactNode }) => <>{children}</>,
  m: motionComponents,
  motion: motionComponents,
  animate: () => Promise.resolve(),
  useAnimation: () => ({ start: () => Promise.resolve(), stop: () => {}, set: () => {} }),
  useInView: () => false,
  useMotionValue: (initial: number) => motionValue(initial),
  useTransform: (initial: number) => motionValue(initial),
  useReducedMotion: () => true,
}));

const { NewWorkspacePage } = await import('./new-workspace-page');

const TOO_LONG_MESSAGE = 'Name must be 120 characters or fewer';

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

/** Text of the field error paragraph, or null when no error is rendered. */
function errorText(renderer: ReactTestRenderer): string | null {
  const paragraph = renderer.root.findAll(
    (node) => node.type === 'p' && node.props.id === 'workspace-name-error',
  )[0];
  if (!paragraph) return null;
  return paragraph.children.filter((child): child is string => typeof child === 'string').join('');
}

async function renderPage(): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(createElement(NewWorkspacePage));
  });
  if (!renderer) throw new Error('page did not render');
  return renderer;
}

/** Type into the field the way a keystroke lands: a fresh instance per act. */
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

test('the name input does not truncate typed input at the limit (no maxLength)', async () => {
  const renderer = await renderPage();
  expect(findInput(renderer).props.maxLength).toBeUndefined();
  await unmount(renderer);
});

test('typing past the limit shows the too-long message before the field is left', async () => {
  const renderer = await renderPage();
  await type(renderer, 'a'.repeat(200));
  expect(errorText(renderer)).toBe(TOO_LONG_MESSAGE);
  await unmount(renderer);
});

test('a too-long name keeps Create project disabled and fires no request', async () => {
  const renderer = await renderPage();
  await type(renderer, 'a'.repeat(200));
  expect(findSubmit(renderer).props.disabled).toBe(true);
  await act(async () => {
    findForm(renderer).props.onSubmit({ preventDefault: () => {} });
  });
  expect(creates).toBe(0);
  await unmount(renderer);
});

test('exactly 120 characters stays valid: no message and Create project enabled', async () => {
  const renderer = await renderPage();
  await type(renderer, 'a'.repeat(120));
  expect(errorText(renderer)).toBeNull();
  expect(findSubmit(renderer).props.disabled).toBe(false);
  await unmount(renderer);
});

test('the limit counts trimmed characters: trailing spaces past 120 stay valid', async () => {
  const renderer = await renderPage();
  await type(renderer, `${'a'.repeat(115)}${' '.repeat(10)}`);
  expect(errorText(renderer)).toBeNull();
  await unmount(renderer);
});

test('the other name errors still wait for the field to be left', async () => {
  const renderer = await renderPage();
  await type(renderer, '');
  expect(errorText(renderer)).toBeNull();
  await act(async () => {
    findInput(renderer).props.onBlur();
  });
  expect(errorText(renderer)).toBe('Name is required');
  await unmount(renderer);
});
