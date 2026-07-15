import { describe, expect, mock, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import type { AcpPendingQuestion } from '@kortix/sdk';

// Same harness `acp-chat-item-row.test.tsx` and `acp-config-controls.test.tsx`
// already use for interactive components: no jsdom in this workspace, so
// `react-test-renderer` + manual `act()`, with the minimal browser-global
// stubs `motion`/Radix reach for during mount/unmount.
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

// `AcpPermissionCard`/`AcpQuestionCard` swap their pending/answered faces
// through `AnimatePresence mode="popLayout"` — under `react-test-renderer`
// there is no real DOM for `motion` to drive an exit transition against, so
// the exiting node never fires its completion callback and lingers in the
// tree forever (verified empirically: the pending card's buttons were still
// present after the answered flip). None of what this file tests is about
// animation timing, so `motion/react` is swapped for a deterministic
// stand-in that renders only the current children — same rationale as the
// `@/components/markdown` mock in `acp-chat-item-row.test.tsx`. Must be
// registered before the first `import('./acp-request-cards')` below.
mock.module('motion/react', () => {
  const ReactModule = require('react');
  function stripMotionProps(props: Record<string, unknown>) {
    const { initial, animate, exit, transition, layout, layoutId, variants, ...rest } = props;
    return rest;
  }
  const motion = new Proxy(
    {},
    {
      get: (_target, tag: string) => {
        return function MotionStub(props: Record<string, unknown>) {
          return ReactModule.createElement(tag, stripMotionProps(props));
        };
      },
    },
  );
  function AnimatePresence({ children }: { children?: unknown }) {
    return ReactModule.createElement(ReactModule.Fragment, null, children);
  }
  function useReducedMotion() {
    return false;
  }
  return { motion, AnimatePresence, useReducedMotion };
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

const QUESTION_REQUEST: AcpPendingQuestion = {
  id: 'q-1',
  method: 'session/request_input',
  questions: [{ key: 'confirm', question: 'Continue?', options: [], allowText: true }],
  params: {},
};

const BOOLEAN_QUESTION_REQUEST: AcpPendingQuestion = {
  id: 'q-bool',
  method: 'session/request_input',
  questions: [
    {
      key: 'proceed',
      question: 'Proceed?',
      options: [
        { label: 'Yes', value: 'true' },
        { label: 'No', value: 'false' },
      ],
    },
  ],
  params: {
    requestedSchema: {
      properties: {
        proceed: { type: 'boolean' },
      },
    },
  },
};

describe('cardSwapVariants', () => {
  test('with reduced motion disabled, includes blur and scale transforms', async () => {
    const { cardSwapVariants } = await import('./acp-request-cards');

    const variants = cardSwapVariants(false);
    expect(variants.initial).toHaveProperty('filter', 'blur(4px)');
    expect(variants.initial).toHaveProperty('scale', 0.98);
    expect(variants.animate).toHaveProperty('filter', 'blur(0px)');
    expect(variants.animate).toHaveProperty('scale', 1);
    expect(variants.exit).toHaveProperty('filter', 'blur(4px)');
    expect(variants.exit).toHaveProperty('scale', 0.98);
  });

  test('with reduced motion enabled, only modifies opacity', async () => {
    const { cardSwapVariants } = await import('./acp-request-cards');

    const variants = cardSwapVariants(true);
    expect(variants.initial).toEqual({ opacity: 0 });
    expect(variants.animate).toEqual({ opacity: 1 });
    expect(variants.exit).toEqual({ opacity: 0 });
    expect(variants.initial).not.toHaveProperty('filter');
    expect(variants.initial).not.toHaveProperty('scale');
    expect(variants.animate).not.toHaveProperty('filter');
    expect(variants.animate).not.toHaveProperty('scale');
  });

  test('transition is consistent regardless of motion preference', async () => {
    const { cardSwapVariants } = await import('./acp-request-cards');

    const reducedVariants = cardSwapVariants(true);
    const fullVariants = cardSwapVariants(false);
    expect(reducedVariants.transition).toEqual(fullVariants.transition);
    expect(reducedVariants.transition).toEqual({ type: 'spring', duration: 0.3, bounce: 0 });
  });
});

describe('AcpQuestionCard', () => {
  test('question form state (typed answer) survives a re-render with a new request object identity, same request.id', async () => {
    const { AcpQuestionCard } = await import('./acp-request-cards');

    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <AcpQuestionCard request={QUESTION_REQUEST} pending={true} onSubmit={async () => {}} onReject={async () => {}} />,
      );
    });

    try {
      const input = renderer.root.findByType('input');
      act(() => {
        input.props.onChange({ target: { value: 'hello there' } });
      });
      expect(renderer.root.findByType('input').props.value).toBe('hello there');

      // Re-render with a structurally-equal but NEW object/array identity —
      // same `request.id`, matching what a fresh `pendingPrompts` snapshot
      // looks like after an unrelated envelope arrives.
      const freshRequest: AcpPendingQuestion = {
        ...QUESTION_REQUEST,
        questions: [...QUESTION_REQUEST.questions],
      };
      expect(freshRequest).not.toBe(QUESTION_REQUEST);
      act(() => {
        renderer.update(
          <AcpQuestionCard request={freshRequest} pending={true} onSubmit={async () => {}} onReject={async () => {}} />,
        );
      });

      expect(renderer.root.findByType('input').props.value).toBe('hello there');
    } finally {
      act(() => { renderer.unmount(); });
    }
  });

  test('boolean-typed elicitation submits true, not the string "true"', async () => {
    const { AcpQuestionCard } = await import('./acp-request-cards');

    const onSubmit = mock(async (_answers: Record<string, unknown>) => {});
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <AcpQuestionCard request={BOOLEAN_QUESTION_REQUEST} pending={true} onSubmit={onSubmit} onReject={async () => {}} />,
      );
    });

    try {
      const yesButton = findButtonsWithText(renderer, 'Yes')[0];
      act(() => { yesButton.props.onClick(); });

      const submitButton = findButtonsWithText(renderer, 'Submit')[0];
      expect(submitButton.props.disabled).toBe(false);

      // The submit control is a `type="submit"` button inside the card's
      // `<form>` — it has no `onClick` of its own, so the flow is driven
      // through the form's `onSubmit`, exactly as a real click would.
      const form = renderer.root.findByType('form');
      await act(async () => {
        form.props.onSubmit({ preventDefault() {} });
        await Promise.resolve();
      });

      expect(onSubmit).toHaveBeenCalledTimes(1);
      const [answers] = onSubmit.mock.calls[0]!;
      expect(answers).toEqual({ proceed: true });
      expect((answers as Record<string, unknown>).proceed).not.toBe('true');
    } finally {
      act(() => { renderer.unmount(); });
    }
  });

  test('reject (dismiss) flow renders "Dismissed" in the answered row', async () => {
    const { AcpQuestionCard } = await import('./acp-request-cards');

    const onReject = mock(async () => {});
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <AcpQuestionCard request={QUESTION_REQUEST} pending={true} onSubmit={async () => {}} onReject={onReject} />,
      );
    });

    try {
      const dismissButton = findButtonsWithText(renderer, 'Dismiss')[0];
      await act(async () => {
        dismissButton.props.onClick();
        await Promise.resolve();
      });

      expect(onReject).toHaveBeenCalledTimes(1);
      const fullText = textOf(renderer.root);
      expect(fullText).toContain('Dismissed');
      expect(renderer.root.findAllByType('button')).toHaveLength(0);
    } finally {
      act(() => { renderer.unmount(); });
    }
  });
});
