import { describe, expect, mock, test } from 'bun:test';
import * as React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

// Same DOM-free harness the sibling interactive-component tests in this
// package use (`acp-request-cards.test.tsx`, `acp-session-chat.test.tsx`): no
// jsdom in this workspace, so `react-test-renderer` + manual `act()`, with
// the minimal browser-global stubs `motion`/`Disclosure`'s `useId` reach for
// during mount/unmount.
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

if (typeof (globalThis as any).window === 'undefined') {
  (globalThis as any).window = globalThis;
}
if (typeof (globalThis as any).matchMedia === 'undefined') {
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

// `AcpUnknownMethodCard`'s "Advanced" raw-JSON panel is a design-system
// `Disclosure` (`@/components/ui/disclosure`), which wraps its tree in
// `MotionConfig` and swaps content via `AnimatePresence`/`motion.div`. None
// of what this file tests is about animation timing (only whether the raw
// payload is present/absent in the tree before/after toggling), so
// `motion/react` is swapped for the same deterministic, current-children-only
// stand-in `acp-session-perf.test.tsx` uses. Must be registered before the
// first `import('./acp-transcript-groups')` below.
mock.module('motion/react', () => {
  function stripMotionProps(props: Record<string, unknown>) {
    const { initial, animate, exit, transition, layout, layoutId, variants, ...rest } = props;
    return rest;
  }
  const motionFactory = (Component: unknown) =>
    function MotionCreateStub(props: Record<string, unknown>) {
      return React.createElement(Component as never, stripMotionProps(props));
    };
  const motion = new Proxy(motionFactory, {
    apply: (target, _thisArg, args) => (target as typeof motionFactory)(args[0]),
    get: (_target, tag: string) => {
      if (tag === 'create') return motionFactory;
      return function MotionStub(props: Record<string, unknown>) {
        return React.createElement(tag, stripMotionProps(props));
      };
    },
  });
  function AnimatePresence({ children }: { children?: React.ReactNode }) {
    return React.createElement(React.Fragment, null, children);
  }
  function MotionConfig({ children }: { children?: React.ReactNode }) {
    return React.createElement(React.Fragment, null, children);
  }
  function useReducedMotion() {
    return false;
  }
  return { motion, AnimatePresence, MotionConfig, useReducedMotion };
});

function textOf(node: unknown): string {
  if (typeof node === 'string') return node;
  const children = (node as { children?: unknown[] } | null)?.children;
  if (!children) return '';
  return children.map(textOf).join('');
}

function findButtonsWithText(renderer: ReactTestRenderer, text: string) {
  return renderer.root
    .findAllByType('button')
    .filter((instance) => textOf(instance).includes(text));
}

describe('AcpUnknownMethodCard — graceful unknown-frame rendering', () => {
  test('renders a friendly row (title + method name), never a bare <pre> JSON dump at rest', async () => {
    const { AcpUnknownMethodCard } = await import('./acp-transcript-groups');

    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<AcpUnknownMethodCard method="session/some_future_method" data={{ secretPayloadKey: 'sentinel-value' }} />);
    });

    try {
      const text = textOf(renderer.root);
      expect(text).toContain('Unrecognized agent event');
      expect(text).toContain('session/some_future_method');

      // The raw payload must NOT be visible at rest — no bare `<pre>` JSON
      // leak, and the disclosure starts closed.
      expect(text).not.toContain('secretPayloadKey');
      expect(text).not.toContain('sentinel-value');
      expect(renderer.root.findAllByType('pre')).toHaveLength(0);
    } finally {
      act(() => {
        renderer.unmount();
      });
    }
  });

  test('opening the Advanced disclosure reveals the raw JSON payload', async () => {
    const { AcpUnknownMethodCard } = await import('./acp-transcript-groups');

    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<AcpUnknownMethodCard method="session/some_future_method" data={{ secretPayloadKey: 'sentinel-value' }} />);
    });

    try {
      const advancedButton = findButtonsWithText(renderer, 'Advanced')[0];
      expect(advancedButton).toBeTruthy();

      act(() => {
        (advancedButton.props as { onClick: () => void }).onClick();
      });

      const text = textOf(renderer.root);
      expect(text).toContain('secretPayloadKey');
      expect(text).toContain('sentinel-value');
      expect(renderer.root.findAllByType('pre')).toHaveLength(1);
    } finally {
      act(() => {
        renderer.unmount();
      });
    }
  });
});
