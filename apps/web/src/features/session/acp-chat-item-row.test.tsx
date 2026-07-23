import { beforeEach, afterEach, describe, expect, mock, test } from 'bun:test';
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
// Assistant rows now render through `SandboxUrlDetector` (Task 7), which
// calls `useTranslations('hardcodedUi')` (`next-intl`) unconditionally at the
// top of its render body — even the no-URL fallback path. There is no
// `NextIntlClientProvider` in this DOM-free harness, so stub it to an
// identity passthrough — same convention `acp-session-chat.test.tsx` uses.
// Must be registered before the first `import('./acp-chat-item-row')` below.
mock.module('next-intl', () => ({
  useTranslations: () => Object.assign((key: string) => key, { raw: (key: string) => key, rich: (key: string) => key, markup: (key: string) => key }),
}));
// The full `SandboxPreviewCard` path (plain-text localhost URLs, restored by
// Fix wave 2 below) mounts `InlineIframePreview`, which calls
// `useAuthenticatedPreviewUrl` — that hook chains into `getAuthToken()`
// (`@/lib/auth-token`), which builds a real Supabase client and retries
// `getSession()`/`refreshSession()` against `NEXT_PUBLIC_SUPABASE_URL`
// (unreachable in this DOM-free harness) with backoff delays. None of that
// is what this file tests — it only cares whether the card renders — so the
// hook is stubbed to resolve synchronously, same "mock at the module
// boundary" convention `use-running-apps.test.tsx` uses for
// `use-sandbox-proxy`'s upstream stores.
const realUseAuthenticatedPreviewUrl = await import('@/hooks/use-authenticated-preview-url');
mock.module('@/hooks/use-authenticated-preview-url', () => ({
  ...realUseAuthenticatedPreviewUrl,
  useAuthenticatedPreviewUrl: (url: string) => url || null,
}));

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

describe('AcpChatItemRow — restored localhost preview cards (Task 7)', () => {
  // Stub `globalThis.fetch` for all tests in this suite: `usePortReachability`
  // (in `SandboxPreviewCard` / `sandbox-url-detector.tsx`) probes on mount and
  // fires a real fetch if not mocked. This ensures tests don't depend on loopback
  // network availability or port state, and don't incur connection attempt delays.
  const originalFetch = globalThis.fetch;
  let mockFetch: ReturnType<typeof mock>;

  beforeEach(() => {
    mockFetch = mock(async () => {
      throw new TypeError('network disabled in test');
    }) as unknown as ReturnType<typeof mock>;
    globalThis.fetch = mockFetch as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // Renders a single row in isolation — the memoization suite above uses
  // `TranscriptFixture` for multi-item render-count spying; these tests only
  // care about which component renders a given item's text, so a bare
  // `AcpChatItemRow` is enough. Always wrapped in `TooltipProvider`: Fix wave
  // 2 restored `SandboxPreviewCard` (and its Radix `Tooltip`s) for plain-text
  // localhost URLs too, so any row here that carries one now mounts real
  // Tooltips, not just the code-block chip case Task 7 originally covered.
  async function renderRow(item: AcpChatItem, AcpChatItemRow: React.ComponentType<AcpChatItemRowProps>): Promise<ReactTestRenderer> {
    const { TooltipProvider } = await import('@/components/ui/tooltip');
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <TooltipProvider>
          <AcpChatItemRow
            item={item}
            isTail={true}
            isStreaming={false}
            sessionId="s1"
            pending={STABLE_PENDING}
            onRespondQuestion={NOOP_RESPOND_QUESTION}
            onRejectQuestion={NOOP_REJECT_QUESTION}
            animateEnter={false}
          />
        </TooltipProvider>,
      );
    });
    return renderer;
  }

  test('assistant message text containing a localhost URL renders through SandboxUrlDetector', async () => {
    const { AcpChatItemRow } = await import('./acp-chat-item-row');
    const { SandboxUrlDetector } = await import('./sandbox-url-detector');
    const item = messageItem('a1', 'Check the dev server at http://localhost:3000 now.');

    const { TooltipProvider } = await import('@/components/ui/tooltip');
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <TooltipProvider>
          <AcpChatItemRow
            item={item}
            isTail={true}
            isStreaming={false}
            sessionId="s1"
            pending={STABLE_PENDING}
            onRespondQuestion={NOOP_RESPOND_QUESTION}
            onRejectQuestion={NOOP_REJECT_QUESTION}
            animateEnter={false}
          />
        </TooltipProvider>,
      );
    });
    try {
      expect(renderer.root.findAllByType(SandboxUrlDetector)).toHaveLength(1);
    } finally {
      act(() => {
        renderer.unmount();
      });
    }
  });

  test('user message with the same localhost URL text does NOT get preview treatment', async () => {
    const { AcpChatItemRow } = await import('./acp-chat-item-row');
    const { SandboxUrlDetector } = await import('./sandbox-url-detector');
    const item: AcpChatItem = {
      kind: 'message',
      id: 'u1',
      role: 'user',
      text: 'Check the dev server at http://localhost:3000 now.',
    };

    const renderer = await renderRow(item, AcpChatItemRow);
    try {
      // The user bubble (`AcpUserMessage`) always renders through the plain
      // `AcpHighlightMentions`/markdown path — `SandboxUrlDetector` must never
      // appear in a user row's tree, localhost URL or not.
      expect(renderer.root.findAllByType(SandboxUrlDetector)).toHaveLength(0);
    } finally {
      act(() => {
        renderer.unmount();
      });
    }
  });

  test('assistant message without a URL still renders through SandboxUrlDetector, unchanged markdown output', async () => {
    const { AcpChatItemRow } = await import('./acp-chat-item-row');
    const { SandboxUrlDetector } = await import('./sandbox-url-detector');
    const { UnifiedMarkdown } = await import('@/components/markdown');
    const item = messageItem('a2', 'no urls in this one');

    const renderer = await renderRow(item, AcpChatItemRow);
    try {
      // Every assistant row now routes through `SandboxUrlDetector` — when it
      // finds no localhost URLs it falls back internally to a bare
      // `UnifiedMarkdown`, so the previously-existing render path (content,
      // isStreaming) is preserved byte-for-byte, just one layer deeper.
      expect(renderer.root.findAllByType(SandboxUrlDetector)).toHaveLength(1);
      const markdownNodes = renderer.root.findAllByType(UnifiedMarkdown as unknown as React.ComponentType);
      expect(markdownNodes).toHaveLength(1);
      expect(markdownNodes[0].props).toMatchObject({ content: 'no urls in this one', isStreaming: false });
    } finally {
      act(() => {
        renderer.unmount();
      });
    }
  });

  test('assistant message with a localhost URL inside a code span renders the code-block preview chip', async () => {
    const { AcpChatItemRow } = await import('./acp-chat-item-row');
    // The chip's action buttons (`SandboxUrlChip`, in `sandbox-url-detector.tsx`)
    // are wrapped in Radix `Tooltip`s, which throw without a `TooltipProvider`
    // ancestor — none of this DOM-free harness's other fixtures need one, since
    // this is the first row content that renders a real (non-stubbed) Tooltip.
    const { TooltipProvider } = await import('@/components/ui/tooltip');
    const item = messageItem('a3', 'Run it, then open `http://localhost:4000/health` to check.');

    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <TooltipProvider>
          <AcpChatItemRow
            item={item}
            isTail={true}
            isStreaming={false}
            sessionId="s1"
            pending={STABLE_PENDING}
            onRespondQuestion={NOOP_RESPOND_QUESTION}
            onRejectQuestion={NOOP_REJECT_QUESTION}
            animateEnter={false}
          />
        </TooltipProvider>,
      );
    });
    try {
      // `SandboxUrlDetector` renders code-block-URL matches as a
      // `SandboxUrlChip` — a real, visible artifact independent of the
      // `UnifiedMarkdown` stand-in — the strongest stable signal available
      // that the detector actually ran its detection logic on this content,
      // not just that the component was mounted. JSX renders `localhost:`
      // and the port number as two separate text nodes (`localhost:{port}`),
      // so assert on both rather than the concatenated string.
      const json = JSON.stringify(renderer.toJSON());
      expect(json).toContain('localhost:');
      expect(json).toContain('4000');
      expect(json).toContain('/health');
    } finally {
      act(() => {
        renderer.unmount();
      });
    }
  });

  test('Fix wave 2: assistant message with a PLAIN-TEXT localhost URL renders the full SandboxPreviewCard', async () => {
    // Task 7 wired `SandboxUrlDetector` into the assistant row and it computes
    // `liveUrls` (plain-text, non-code-block localhost URLs) correctly, but a
    // stale comment claimed they were "rendered as inline preview cards
    // directly inside UnifiedMarkdown" — false; nothing ever rendered them.
    // This is the RED case for that gap: a plain-text `http://localhost:3000`
    // must produce the real `SandboxPreviewCard` (status probe + "Preview"
    // button + inline iframe toolbar), not just the raw text passed through
    // to the (stubbed) markdown renderer.
    const { TooltipProvider } = await import('@/components/ui/tooltip');
    const { AcpChatItemRow } = await import('./acp-chat-item-row');
    const item = messageItem('a4', 'Your app is running at http://localhost:3000 — check it out.');

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <TooltipProvider>
          <AcpChatItemRow
            item={item}
            isTail={true}
            isStreaming={false}
            sessionId="s1"
            pending={STABLE_PENDING}
            onRespondQuestion={NOOP_RESPOND_QUESTION}
            onRejectQuestion={NOOP_REJECT_QUESTION}
            animateEnter={false}
          />
        </TooltipProvider>,
      );
    });

    try {
      // "Preview" is a literal JSX string inside `SandboxPreviewCard`'s
      // primary action button (not a translation key, unlike the other
      // labels in this component) — a stable artifact that only the full
      // card renders, distinguishing it from `SandboxUrlChip` (the
      // code-block variant, which has no "Preview" button) and from plain
      // markdown text.
      const json = JSON.stringify(renderer.toJSON());
      expect(json).toContain('Preview');
      expect(json).toContain('localhost:');
      expect(json).toContain('3000');
    } finally {
      act(() => {
        renderer.unmount();
      });
    }
  });
});
