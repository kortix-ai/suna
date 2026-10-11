import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { act, create } from 'react-test-renderer';

// The three error boundaries every route flows through must hand a
// chunk-load failure to `reloadForChunkLoadError` and render nothing while
// that reload lands — and must keep rendering their real error card when the
// guard answers "no reload" (second sighting inside the window, no storage).
// The recovery decision itself is unit-tested in
// `src/lib/chunk-load-recovery.test.ts`; here the module is a controllable
// seam so each component's reaction is what is under test.

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

let reloadResult = false;
const reloadCalls: unknown[] = [];
mock.module('@/lib/chunk-load-recovery', () => ({
  reloadForChunkLoadError: (error: unknown) => {
    reloadCalls.push(error);
    return reloadResult;
  },
}));
mock.module('@/i18n/use-translations', () => ({
  useTranslations: () => ({ raw: (key: string) => key }),
}));
mock.module('@sentry/nextjs', () => ({
  captureException: () => undefined,
  captureMessage: () => undefined,
}));
mock.module('@kortix/sdk', () => ({ isRuntimeStartingError: () => false }));
mock.module('@/components/ui/button', () => ({
  Button: ({ children }: { children: React.ReactNode }) => createElement('button', null, children),
}));
mock.module('@/components/ui/marketing/kortix-hyper-logo', () => ({
  KortixHyperLogo: () => createElement('div', null, 'logo'),
}));
mock.module('next/link', () => ({
  default: ({ children }: { children: React.ReactNode }) => createElement('a', null, children),
}));
mock.module('@/components/common/system-fault', () => ({
  SystemFaultView: () => createElement('div', null, 'system-fault'),
}));
mock.module('@/lib/browser-error-noise', () => ({
  isRuntimeNotReadyNoiseMessage: () => false,
}));
mock.module('@/components/common/error-details', () => ({
  ErrorDetails: () => createElement('div', null, 'details'),
}));

const CHUNK_ERROR = new TypeError(
  'Failed to fetch dynamically imported module: https://app.example/_next/static/chunks/a.js',
);

const noop = () => {};
let Component: React.ComponentType<{ error: Error; reset: () => void }>;

async function renderWith(error: Error) {
  let root: ReturnType<typeof create> | undefined;
  await act(async () => {
    root = create(createElement(Component, { error, reset: noop }));
  });
  if (!root) throw new Error('boundary did not render');
  return root;
}

test('the [locale] boundary renders nothing while the chunk reload lands', async () => {
  ({ default: Component } = await import('../app/[locale]/error'));
  reloadResult = true;
  reloadCalls.length = 0;
  const root = await renderWith(CHUNK_ERROR);
  expect(root.toJSON()).toBeNull();
  expect(reloadCalls).toEqual([CHUNK_ERROR]);
});

test('the [locale] boundary keeps its crash card when the guard answers no reload', async () => {
  ({ default: Component } = await import('../app/[locale]/error'));
  reloadResult = false;
  reloadCalls.length = 0;
  const root = await renderWith(CHUNK_ERROR);
  expect(root.toJSON()).not.toBeNull();
  expect(reloadCalls).toEqual([CHUNK_ERROR]);
});

test('global-error renders nothing while the chunk reload lands', async () => {
  ({ default: Component } = await import('../app/global-error'));
  reloadResult = true;
  reloadCalls.length = 0;
  const root = await renderWith(CHUNK_ERROR);
  expect(root.toJSON()).toBeNull();
  expect(reloadCalls).toEqual([CHUNK_ERROR]);
});

test('global-error keeps the system-fault view when the guard answers no reload', async () => {
  ({ default: Component } = await import('../app/global-error'));
  reloadResult = false;
  reloadCalls.length = 0;
  const root = await renderWith(CHUNK_ERROR);
  expect(root.toJSON()).not.toBeNull();
  expect(reloadCalls).toEqual([CHUNK_ERROR]);
});

test('RouteErrorFallback renders nothing while the chunk reload lands', async () => {
  ({ RouteErrorFallback: Component } = await import('../components/common/route-error'));
  reloadResult = true;
  reloadCalls.length = 0;
  const root = await renderWith(CHUNK_ERROR);
  expect(root.toJSON()).toBeNull();
  expect(reloadCalls).toEqual([CHUNK_ERROR]);
});

test('RouteErrorFallback keeps its crash card when the guard answers no reload', async () => {
  ({ RouteErrorFallback: Component } = await import('../components/common/route-error'));
  reloadResult = false;
  reloadCalls.length = 0;
  const root = await renderWith(CHUNK_ERROR);
  expect(root.toJSON()).not.toBeNull();
  expect(reloadCalls).toEqual([CHUNK_ERROR]);
});
