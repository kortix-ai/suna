/**
 * The default navigation adapter: SSR renders an empty location, the client
 * reads `window.location` and follows `popstate`, the router does full page
 * loads. Rendered on happy-dom (the composer.test.tsx setup).
 */
import { expect, test } from 'bun:test';
import { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Window } from 'happy-dom';

import {
  UiProvider,
  defaultUiNavigation,
  useUiParams,
  useUiPathname,
  useUiRouter,
  useUiSearchParams,
  type UiNavigation,
} from './ui-provider';

function Probe() {
  const pathname = useUiPathname();
  const search = useUiSearchParams();
  const params = useUiParams<{ id?: string }>();
  return <span>{`${pathname}|${search.get('tab') ?? '-'}|${params.id ?? '-'}`}</span>;
}

test('SSR renders an empty pathname, no search params and no route params', () => {
  expect(renderToStaticMarkup(<Probe />)).toBe('<span>|-|-</span>');
});

test('the client reads window.location and re-renders on popstate', async () => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
  const win = new Window({ url: 'https://example.test/projects/p1?tab=files' });
  const globals = globalThis as Record<string, unknown>;
  globals.window = win;
  globals.document = win.document;
  globals.navigator = win.navigator;
  const { createRoot } = await import('react-dom/client');
  const container = win.document.createElement('div');
  win.document.body.appendChild(container);
  const root = createRoot(container as never);
  act(() => root.render(<Probe />));
  expect(container.textContent).toBe('/projects/p1|files|-');

  act(() => {
    win.history.pushState(null, '', '/projects/p2?tab=changes');
    win.dispatchEvent(new win.PopStateEvent('popstate'));
  });
  expect(container.textContent).toBe('/projects/p2|changes|-');
  act(() => root.unmount());
});

test('the default router assigns, replaces and goes back through window', () => {
  const calls: string[] = [];
  const globals = globalThis as Record<string, unknown>;
  const saved = globals.window;
  globals.window = {
    location: { assign: (h: string) => calls.push(`assign ${h}`), replace: (h: string) => calls.push(`replace ${h}`) },
    history: { back: () => calls.push('back') },
  };
  try {
    const router = defaultUiNavigation.useRouter();
    router.push('/a');
    router.replace('/b');
    router.prefetch('/c');
    router.back();
  } finally {
    globals.window = saved;
  }
  expect(calls).toEqual(['assign /a', 'replace /b', 'back']);
});

test('a host navigation replaces every hook', () => {
  const pushed: string[] = [];
  const host: UiNavigation = {
    useRouter: () => ({ push: (h) => pushed.push(h), replace: () => {}, prefetch: () => {}, back: () => {} }),
    usePathname: () => '/host',
    useSearchParams: () => new URLSearchParams('tab=host'),
    useParams: () => ({ id: 'p9' }),
  };
  function Push() {
    useUiRouter().push('/next');
    return null;
  }
  expect(
    renderToStaticMarkup(
      <UiProvider navigation={host}>
        <Probe />
        <Push />
      </UiProvider>,
    ),
  ).toBe('<span>/host|host|p9</span>');
  expect(pushed).toEqual(['/next']);
});

