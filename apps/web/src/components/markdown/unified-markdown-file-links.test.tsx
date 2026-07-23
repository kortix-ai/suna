import { describe, expect, mock, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

// Same harness this package already uses for the one other interactive
// component test (`acp-config-controls.test.tsx`): no jsdom in this
// workspace, so `react-test-renderer` + manual `act()`, with the minimal
// browser-global stubs Radix/`motion` reach for during mount/unmount.
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

if (typeof (globalThis as any).window === 'undefined') {
  (globalThis as any).window = globalThis;
}
if (typeof (globalThis as any).matchMedia === 'undefined') {
  // `useReducedMotion` (`motion/react`) reads `window.matchMedia` — this
  // workspace has no jsdom, so stub just enough for it to resolve to "no
  // preference" without throwing.
  (globalThis as any).matchMedia = () => ({
    matches: false,
    media: '',
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  });
}
if (typeof (globalThis as any).document === 'undefined') {
  const stubElement = () => ({ appendChild: () => {}, style: {} }) as { appendChild: () => void; style: Record<string, unknown> };
  (globalThis as any).document = {
    addEventListener: () => {},
    removeEventListener: () => {},
    activeElement: null,
    documentElement: stubElement(),
    head: stubElement(),
    body: stubElement(),
    getElementsByTagName: () => [stubElement()],
    createElement: () => ({ ...stubElement(), styleSheet: undefined }),
    createTextNode: () => ({}),
  };
}
if (typeof (globalThis as any).localStorage === 'undefined') {
  const store = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
    clear: () => { store.clear(); },
  };
}

// `UnifiedMarkdown` calls next-intl's `useTranslations()` unconditionally at
// the top of its render body. There is no `NextIntlClientProvider` in this
// DOM-free harness, so the real hook throws synchronously on mount regardless
// of props — stubbed to an identity passthrough (`t(key) === key`), same
// convention as `acp-session-perf.test.tsx`.
mock.module('next-intl', () => ({
  useTranslations: () => Object.assign((key: string) => key, { raw: (key: string) => key, rich: (key: string) => key, markup: (key: string) => key }),
}));

import { UnifiedMarkdown } from '@/components/markdown/unified-markdown';
import { useSessionBrowserStore } from '@/stores/session-browser-store';

const clickEvent = { preventDefault: () => {}, stopPropagation: () => {} };

describe('sandbox file links in markdown', () => {
  test('[name](/workspace/…) routes into the session panel instead of navigating', async () => {
    useSessionBrowserStore.setState({ activeSessionId: 'ses_test', fileOpenBySession: {} });
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(
        <UnifiedMarkdown
          content="Done — [Report.xlsx](/workspace/out/Report.xlsx)"
          isStreaming={false}
        />,
      );
    });
    const fileLink = renderer!.root.findAll(
      (n) => n.type === 'a' && n.props.role === 'button',
    )[0];
    expect(fileLink).toBeDefined();
    expect(fileLink.props.href).toBeUndefined();
    await act(async () => {
      fileLink.props.onClick(clickEvent);
    });
    const req = useSessionBrowserStore.getState().fileOpenBySession['ses_test'];
    expect(req?.path).toBe('/workspace/out/Report.xlsx');
    renderer!.unmount();
  });

  test('external links keep their normal anchor behavior', async () => {
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(
        <UnifiedMarkdown content="[site](https://example.com/a)" isStreaming={false} />,
      );
    });
    expect(
      renderer!.root.findAll((n) => n.type === 'a' && n.props.role === 'button').length,
    ).toBe(0);
    renderer!.unmount();
  });
});
