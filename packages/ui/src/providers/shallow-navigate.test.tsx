import { afterAll, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act, create } from 'react-test-renderer';

import { openTabAndNavigate } from '../internal/stores/tab-store';
import {
  UiProvider,
  defaultUiNavigation,
  useUiPathname,
  useUiShallowNavigate,
  type UiNavigation,
  type UiRouter,
  type UiShallowNavigate,
} from './ui-provider';

// A tab or query-param URL the library writes reaches the host router: the
// default navigation re-reads it, and a router that does not observe history
// (React Router) receives it as a push, so the address bar never moves alone.

const originals = ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'].map((key) => ({
  key,
  descriptor: Object.getOwnPropertyDescriptor(globalThis, key),
}));
const window = new Window({ url: 'http://localhost/projects/p1/sessions/s1' });
Object.defineProperty(globalThis, 'window', { value: window, configurable: true });
Object.defineProperty(globalThis, 'document', { value: window.document, configurable: true });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
afterAll(() => {
  for (const { key, descriptor } of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  window.happyDOM.abort();
});

function mount(navigation: UiNavigation) {
  const seen: string[] = [];
  let navigate: UiShallowNavigate | undefined;
  function Probe() {
    seen.push(useUiPathname());
    navigate = useUiShallowNavigate();
    return null;
  }
  act(() => {
    create(
      <UiProvider navigation={navigation}>
        <Probe />
      </UiProvider>,
    );
  });
  return { seen, navigate: () => navigate as UiShallowNavigate };
}

test('the default navigation re-renders on a session tab the UI opens', () => {
  const { seen, navigate } = mount(defaultUiNavigation);
  act(() => {
    openTabAndNavigate(
      { id: 's2', title: 'S2', type: 'session', href: '/projects/p1/sessions/s2' },
      undefined,
      navigate(),
    );
  });
  expect(window.location.pathname).toBe('/projects/p1/sessions/s2');
  expect(seen.at(-1)).toBe('/projects/p1/sessions/s2');
});

test('a router that does not observe history gets the push; a non-route tab href moves no URL', () => {
  const pushes: string[] = [];
  const replaces: string[] = [];
  const router: UiRouter = {
    push: (href) => pushes.push(href),
    replace: (href) => replaces.push(href),
    prefetch() {},
    back() {},
  };
  const before = window.location.href;
  const { navigate } = mount({ ...defaultUiNavigation, observesHistory: false, useRouter: () => router });
  act(() => {
    openTabAndNavigate(
      { id: 's3', title: 'S3', type: 'session', href: '/projects/p1/sessions/s3' },
      undefined,
      navigate(),
    );
    openTabAndNavigate({ id: 'preview:3000', title: 'Preview', type: 'preview', href: '/p/3000' }, undefined, navigate());
    navigate()('/projects/p1/sessions/s3?cr=1', { replace: true });
  });
  expect(pushes).toEqual(['/projects/p1/sessions/s3']);
  expect(replaces).toEqual(['/projects/p1/sessions/s3?cr=1']);
  expect(window.location.href).toBe(before);
});
