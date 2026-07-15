import { describe, expect, mock, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import type { AcpChatItem, AcpPendingPrompts } from '@kortix/sdk';
import type { AcpChatItemRowProps } from './acp-chat-item-row';

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

// `AcpChatItemRow` (via its `message` branch) renders `UnifiedMarkdown`
// (`@/components/markdown`), which pulls in shiki/highlighting machinery
// that expects a real browser (well beyond what the stubs above cover) —
// irrelevant to what THIS file tests (row memoization / render counts), so
// it's swapped for a trivial stand-in. Must be registered before the first
// `import('./acp-chat-item-row')` below, so the row module and every test
// that needs it import it dynamically (matching `acp-config-controls.test.tsx`'s
// established convention for exactly this reason).
mock.module('@/components/markdown', () => ({ UnifiedMarkdown: () => null }));

const STABLE_PENDING: AcpPendingPrompts = { permissions: [], questions: [] };
const NOOP_RESPOND_QUESTION = async () => {};
const NOOP_REJECT_QUESTION = async () => {};

function messageItem(id: string, text: string): AcpChatItem {
  return { kind: 'message', id, role: 'assistant', text };
}

function rowKey(item: AcpChatItem): string {
  return item.kind === 'message' || item.kind === 'tool' ? `${item.kind}-${item.id}` : item.kind;
}

/** Renders a flat transcript through `AcpChatItemRow`, exactly the way
 *  `acp-session-chat.tsx` does per turn — a stable `pending` object and
 *  stable no-op callbacks across both renders, matching what the real
 *  `useAcpSession` hook actually hands out (see `use-acp-session.ts`'s
 *  `useCallback`-wrapped respond/reject functions and `AcpSession`'s
 *  `pendingPromptsCache`). */
function makeTranscriptFixture(AcpChatItemRow: React.ComponentType<AcpChatItemRowProps>) {
  return function TranscriptFixture({ items, busy = false }: { items: AcpChatItem[]; busy?: boolean }) {
    const tailItem = items.at(-1) ?? null;
    return (
      <>
        {items.map((item) => (
          <AcpChatItemRow
            key={rowKey(item)}
            item={item}
            isTail={item === tailItem}
            isStreaming={busy && item === tailItem}
            sessionId="s1"
            pending={STABLE_PENDING}
            onRespondQuestion={NOOP_RESPOND_QUESTION}
            onRejectQuestion={NOOP_REJECT_QUESTION}
            animateEnter={false}
          />
        ))}
      </>
    );
  };
}

/** Spies on the render function `memo()` wraps (`AcpChatItemRow.type`) so a
 *  call is only recorded when React actually re-executes that row's render
 *  body — i.e. NOT when `memo`'s shallow prop comparison bails out and skips
 *  it. This is a genuinely different signal from wrapping each row in a
 *  `<Profiler>`: empirically (verified with a throwaway spike against this
 *  exact React/react-test-renderer version), `Profiler.onRender` fires for
 *  every row on every commit of the list REGARDLESS of a memoized child's
 *  bailout — it reports on what the profiled subtree's actual/base
 *  durations were, not whether a component call happened, so it cannot
 *  distinguish "rendered" from "bailed out". Patching `.type` observes the
 *  render call directly, which is the "test-only wrapper" instrumentation
 *  the Task 16 brief calls for. */
function spyOnRowRenders(AcpChatItemRow: React.ComponentType<AcpChatItemRowProps> & { type: (props: AcpChatItemRowProps) => unknown }) {
  const renders = new Map<string, number>();
  const original = AcpChatItemRow.type;
  AcpChatItemRow.type = (props: AcpChatItemRowProps) => {
    const key = rowKey(props.item);
    renders.set(key, (renders.get(key) ?? 0) + 1);
    return original(props);
  };
  return {
    renders,
    restore() {
      AcpChatItemRow.type = original;
    },
  };
}

describe('AcpChatItemRow — memoization', () => {
  test('appending a chunk re-renders only the tail row', async () => {
    const { AcpChatItemRow } = await import('./acp-chat-item-row');
    const TranscriptFixture = makeTranscriptFixture(AcpChatItemRow);

    const itemsA = Array.from({ length: 20 }, (_, i) => messageItem(String(i), `chunk ${i}`));
    // Same 19 object references as `itemsA` — only the tail item is a NEW
    // object (simulating a streamed chunk appended to the last message).
    const tailId = '19';
    const itemsB = [...itemsA.slice(0, -1), messageItem(tailId, 'chunk 19 (updated)')];

    const spy = spyOnRowRenders(AcpChatItemRow as unknown as React.ComponentType<AcpChatItemRowProps> & { type: (props: AcpChatItemRowProps) => unknown });
    let renderer!: ReactTestRenderer;
    try {
      act(() => {
        renderer = create(<TranscriptFixture items={itemsA} />);
      });
      expect(spy.renders.get('message-3')).toBe(1);
      expect(spy.renders.get(`message-${tailId}`)).toBe(1);

      act(() => {
        renderer.update(<TranscriptFixture items={itemsB} />);
      });

      // An untouched row (same `AcpChatItem` object reference, same
      // primitive props, same stable `pending`/callback references) is
      // rendered exactly once — `memo` bails out on the second pass.
      expect(spy.renders.get('message-3')).toBe(1);
      // Only the tail row — the one whose item object actually changed —
      // re-renders.
      expect(spy.renders.get(`message-${tailId}`)).toBe(2);
    } finally {
      spy.restore();
      act(() => {
        renderer.unmount();
      });
    }
  });

  test('RED baseline: without stable item identity, every row re-renders on any change', async () => {
    // This documents the failure mode Task 16 replaces: the OLD
    // `acp-session-chat.tsx` recomputed `projectAcpChatItems(envelopes)`
    // fresh on every render, so EVERY item got a new object identity on
    // EVERY envelopes change — wrapping the row in `memo` alone would not
    // have helped, because `memo`'s shallow prop comparison sees a
    // brand-new `item` reference for every row, every time. Rebuilding the
    // WHOLE array here (instead of reusing 19 references, as the test
    // above does) reproduces exactly that fold-from-scratch shape and
    // proves `memo` cannot bail without it — i.e. `AcpChatItemRow` being
    // `memo`-wrapped is necessary but not sufficient; `chatItems`
    // reference-stability (Task 16's hook plumbing) is what actually makes
    // the test above pass.
    const { AcpChatItemRow } = await import('./acp-chat-item-row');
    const TranscriptFixture = makeTranscriptFixture(AcpChatItemRow);
    const rebuild = (updatedIndex: number) =>
      Array.from({ length: 20 }, (_, i) => messageItem(String(i), `chunk ${i}${i === updatedIndex ? ' (updated)' : ''}`));

    const spy = spyOnRowRenders(AcpChatItemRow as unknown as React.ComponentType<AcpChatItemRowProps> & { type: (props: AcpChatItemRowProps) => unknown });
    let renderer!: ReactTestRenderer;
    try {
      act(() => {
        renderer = create(<TranscriptFixture items={rebuild(-1)} />);
      });
      act(() => {
        renderer.update(<TranscriptFixture items={rebuild(19)} />);
      });

      expect(spy.renders.get('message-3')).toBe(2);
    } finally {
      spy.restore();
      act(() => {
        renderer.unmount();
      });
    }
  });

  test('regression: busy flip does not re-render non-tail rows when isStreaming prop is constant', async () => {
    // Task 16 F1: replacing the `busy` prop with `isStreaming={busy && isTail}`
    // (computed in the parent where isTail is known) ensures non-tail rows
    // always receive isStreaming={false}, a constant prop that doesn't change
    // when busy flips. Memo's shallow prop comparison bails out for those
    // rows, so only the tail row re-renders. Without this fix, every row
    // would re-render on each busy flip, even though their rendering output
    // never changes.
    const { AcpChatItemRow } = await import('./acp-chat-item-row');
    const TranscriptFixture = makeTranscriptFixture(AcpChatItemRow);
    const items = Array.from({ length: 3 }, (_, i) => messageItem(String(i), `message ${i}`));

    const spy = spyOnRowRenders(AcpChatItemRow as unknown as React.ComponentType<AcpChatItemRowProps> & { type: (props: AcpChatItemRowProps) => unknown });
    let renderer!: ReactTestRenderer;
    try {
      // Initial render with busy=false
      act(() => {
        renderer = create(<TranscriptFixture items={items} busy={false} />);
      });
      expect(spy.renders.get('message-0')).toBe(1);
      expect(spy.renders.get('message-1')).toBe(1);
      expect(spy.renders.get('message-2')).toBe(1);

      // Flip to busy=true: only tail row should re-render
      act(() => {
        renderer.update(<TranscriptFixture items={items} busy={true} />);
      });

      // Non-tail rows should have NOT re-rendered (memo bailed out)
      expect(spy.renders.get('message-0')).toBe(1);
      expect(spy.renders.get('message-1')).toBe(1);
      // Tail row is the only one whose isStreaming prop changed (false -> true)
      expect(spy.renders.get('message-2')).toBe(2);

      // Flip back to busy=false: again, only tail row re-renders
      act(() => {
        renderer.update(<TranscriptFixture items={items} busy={false} />);
      });

      expect(spy.renders.get('message-0')).toBe(1);
      expect(spy.renders.get('message-1')).toBe(1);
      expect(spy.renders.get('message-2')).toBe(3);
    } finally {
      spy.restore();
      act(() => {
        renderer.unmount();
      });
    }
  });
});
