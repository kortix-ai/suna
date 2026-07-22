import { describe, expect, mock, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';

import { projectAcpChatItems as projectAcpEnvelopes, type AcpChatItem, type AcpUsageProjection } from '@kortix/sdk';
import Loading from '@/components/ui/loading';
import { Skeleton } from '@/components/ui/skeleton';
import { InlineMeta } from '@/components/ui/inline-meta';
import { Check, ChevronRight } from 'lucide-react';
import type { AcpSessionChat as AcpSessionChatType } from './acp-session-chat';
import { AcpPlanCard } from './acp-tool-call-card';

// Same harness the other interactive component tests in this package use
// (`acp-chat-item-row.test.tsx`, `acp-config-controls.test.tsx`): no jsdom in
// this workspace, so `react-test-renderer` + manual `act()`, with the minimal
// browser-global stubs Radix/`motion`/`Disclosure`'s `useId` reach for during
// mount/unmount.
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

if (typeof (globalThis as any).window === 'undefined') {
  (globalThis as any).window = globalThis;
}
if (typeof (globalThis as any).matchMedia === 'undefined') {
  // `useReducedMotion` (`motion/react`, used by `AcpChatItemRow` and
  // `Disclosure`) reads `window.matchMedia` — stub it to resolve to "no
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
if (typeof (globalThis as any).requestAnimationFrame === 'undefined') {
  // `AcpSessionChat`'s initial-scroll effect schedules one `requestAnimationFrame`
  // call once the transcript first has content — no browser/jsdom here, so
  // stub it to a `setTimeout`-backed no-op (never actually invoked in these
  // tests, since nothing asserts on scroll position).
  (globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0) as unknown as number;
  (globalThis as any).cancelAnimationFrame = (handle: number) => clearTimeout(handle);
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

// `AcpChatItemRow`'s `message` branch renders `UnifiedMarkdown`, which pulls
// in shiki/highlighting machinery well beyond what the stubs above cover —
// irrelevant to what this file tests (top-level state rendering), so it's
// swapped for a trivial stand-in, same convention `acp-chat-item-row.test.tsx`
// established. `SessionSiteHeader`, `SessionChatInput`, and
// `SessionContextModal` all call `useTranslations` (`next-intl`) and/or
// `next/navigation` hooks unconditionally at the top of their render body —
// there is no `IntlProvider`/app-router context in this harness, so each
// throws synchronously on mount regardless of props (verified: even
// `SessionContextModal`'s `open={false}` doesn't help, since the hook call
// happens before Radix's `Dialog` even looks at `open`). None of their
// internals are what this file is testing — `AcpSessionChat`'s own
// ready/empty/error/reconnecting/raw-frame/plan-tick rendering logic is — so
// all three are stubbed to `null`. Must be registered before the first
// `import('./acp-session-chat')` below.
mock.module('@/components/markdown', () => ({ UnifiedMarkdown: () => null }));
mock.module('./header/session-site-header', () => ({ SessionSiteHeader: () => null }));
// `AcpSessionChat` now routes the composer through `ComposerChatInput`, which
// pulls in the full Runtime catalog-query / model-store wiring (react-query,
// SDK hooks) — none of which this file's ready/empty/error/raw-frame render
// tests exercise. Stubbed to a props-capturing `null` so tests can still
// assert on what `AcpSessionChat` hands the composer (e.g. `disabled`).
let lastComposerChatInputProps: Record<string, unknown> | null = null;
import * as actualComposerChatInput from './composer-chat-input';
mock.module('./composer-chat-input', () => ({
  ...actualComposerChatInput,
  ComposerChatInput: (props: Record<string, unknown>) => {
    lastComposerChatInputProps = props;
    return null;
  },
}));
// `useSessionAudit`/`useResolveApproval` (the connector-approval lock) call
// `useQuery`/`useMutation` from `@tanstack/react-query`, which need a
// `QueryClientProvider` this DOM-free harness has no reason to mount. Only
// those hooks are overridden (to a no-pending-approvals result / an inert
// mutation) — the module's pure helpers (`relativeTime`, `riskTone`,
// `isPendingAction`, …) stay real, since the unified `PermissionPrompt`
// (mounted for real by `AcpSessionChat`'s inputSlot, not stubbed away) binds
// them at module-eval time.
import * as actualSessionAudit from './session-audit-shared';
mock.module('./session-audit-shared', () => ({
  ...actualSessionAudit,
  useSessionAudit: () => ({ data: undefined }),
  useResolveApproval: () => ({ mutate: () => {}, mutateAsync: async () => {}, isPending: false }),
}));
// `usePermissionPolicy` (Task WS5-P1-a/b's persistent ACP permission policy)
// also calls `useQuery`/`useQueryClient` — same QueryClientProvider problem.
// Spread the real module so every other export (`useSession`'s type, etc.)
// stays exactly what the rest of this file already relies on.
import * as actualSdkReact from '@kortix/sdk/react';
mock.module('@kortix/sdk/react', () => ({
  ...actualSdkReact,
  usePermissionPolicy: () => ({
    policy: { autoApprove: 'none', toolDecisions: {} },
    isLoading: false,
    setAutoApprove: async () => {},
    rememberToolDecision: async () => {},
  }),
}));
// `useProjectCan` (gates the connector "Always allow" footer) resolves an
// account id via `useQuery` too — same story, stubbed to "not allowed" (the
// footer this file never asserts on).
mock.module('@/lib/use-project-can', () => ({
  useProjectCan: () => ({ allowed: false, reason: null, isLoading: false, isError: false }),
}));
mock.module('./session-context-modal', () => ({ SessionContextModal: () => null }));
// Raw protocol frames now render inline as `AcpUnknownMethodCard` ->
// `BasicTool` (`tool-renderers.tsx`), whose module pulls in `next-intl`'s
// `useTranslations` at import time (and several sibling tool renderers call
// it unconditionally). There is no `NextIntlClientProvider` in this DOM-free
// harness, so stub it to an identity passthrough — same convention the perf
// test file uses. Must be registered before the first `import('./acp-session-chat')`.
mock.module('next-intl', () => ({
  useTranslations: () => Object.assign((key: string) => key, { raw: (key: string) => key, rich: (key: string) => key, markup: (key: string) => key }),
}));

type AcpProp = Parameters<typeof AcpSessionChatType>[0]['acp'];

/** A literal fixture matching the hook's return shape (`useAcpSession`,
 *  `packages/sdk/src/react/use-acp-session.ts`) — every field the real hook
 *  returns, with sensible no-op defaults, overridable per test. */
function baseAcp(overrides: Partial<AcpProp> = {}): AcpProp {
  return {
    ready: true,
    busy: false,
    error: null,
    envelopes: [],
    chatItems: [],
    pendingPrompts: { permissions: [], questions: [] },
    usage: null,
    configOptions: [],
    capabilities: {},
    agentInfo: null,
    authMethods: [],
    send: async () => true,
    cancel: async () => {},
    setConfigOption: async () => true,
    respondPermission: async () => {},
    respondQuestion: async () => {},
    rejectQuestion: async () => {},
    autoApprovePermissions: false,
    setAutoApprovePermissions: () => {},
    acpSessionId: 'sess-1',
    connection: 'open',
    errorInfo: null,
    retry: () => {},
    runtimeSessionId: 'sess-1',
    ...overrides,
  } as AcpProp;
}

function userMsg(id: string, text: string): AcpChatItem {
  return { kind: 'message', id, role: 'user', text };
}

function assistantMsg(id: string, text: string): AcpChatItem {
  return { kind: 'message', id, role: 'assistant', text };
}

function thoughtMsg(id: string, text: string): AcpChatItem {
  return { kind: 'message', id, role: 'thought', text };
}

function rawItem(method: string, data: unknown): AcpChatItem {
  return { kind: 'raw', method, data };
}

function toolItem(id: string, title: string, toolKind: string): AcpChatItem {
  return { kind: 'tool', id, title, toolKind, status: 'completed', content: [], locations: [], rawInput: {}, rawOutput: null, data: {} } as AcpChatItem;
}

function permissionItem(id: number): AcpChatItem {
  return { kind: 'permission', id, method: 'session/request_permission', params: {} } as AcpChatItem;
}

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

describe('AcpSessionChat — session states', () => {
  test('boot skeleton: not ready, no error → 4 shape-matched Skeleton rows, no transcript/empty/error copy', async () => {
    const { AcpSessionChat } = await import('./acp-session-chat');

    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <AcpSessionChat acp={baseAcp({ ready: false, errorInfo: null })} sessionId="s1" sessionTitle="Session" projectId="p1" />,
      );
    });

    try {
      expect(renderer.root.findAllByType(Skeleton)).toHaveLength(4);
      const text = textOf(renderer.root);
      expect(text).not.toContain('Start a conversation');
      expect(text).not.toContain('Something went wrong');
    } finally {
      act(() => {
        renderer.unmount();
      });
    }
  });

  test('empty transcript: ready with zero chat items → EmptyState copy, no skeleton', async () => {
    const { AcpSessionChat } = await import('./acp-session-chat');

    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <AcpSessionChat acp={baseAcp({ ready: true, chatItems: [] })} sessionId="s1" sessionTitle="Session" projectId="p1" />,
      );
    });

    try {
      expect(textOf(renderer.root)).toContain('Start a conversation with the selected native harness.');
      expect(renderer.root.findAllByType(Skeleton)).toHaveLength(0);
    } finally {
      act(() => {
        renderer.unmount();
      });
    }
  });

  test('terminal error: errorInfo.terminal → ErrorState with a Retry button that calls acp.retry()', async () => {
    const { AcpSessionChat } = await import('./acp-session-chat');

    const retryCalls: number[] = [];
    const acp = baseAcp({
      ready: false,
      errorInfo: { kind: 'transport', message: 'The connection was refused.', terminal: true },
      retry: () => {
        retryCalls.push(1);
      },
    });

    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<AcpSessionChat acp={acp} sessionId="s1" sessionTitle="Session" projectId="p1" />);
    });

    try {
      expect(textOf(renderer.root)).toContain('The connection was refused.');
      expect(renderer.root.findAllByType(Skeleton)).toHaveLength(0);

      const retryButton = findButtonsWithText(renderer, 'Retry')[0];
      expect(retryButton).toBeTruthy();
      act(() => {
        (retryButton.props as { onClick: () => void }).onClick();
      });
      expect(retryCalls).toEqual([1]);
    } finally {
      act(() => {
        renderer.unmount();
      });
    }
  });

  test('reconnecting: quiet pill near the composer, transcript stays rendered, no red banner', async () => {
    const { AcpSessionChat } = await import('./acp-session-chat');
    const items: AcpChatItem[] = [userMsg('u1', 'hello there')];

    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <AcpSessionChat
          acp={baseAcp({
            ready: true,
            chatItems: items,
            connection: 'reconnecting',
            errorInfo: { kind: 'transport', message: 'stream dropped', terminal: false },
          })}
          sessionId="s1"
          sessionTitle="Session"
          projectId="p1"
        />,
      );
    });

    try {
      const text = textOf(renderer.root);
      expect(text).toContain('Reconnecting');
      // The transcript keeps rendering — it isn't replaced by any error UI.
      expect(text).toContain('hello there');
      // Non-terminal transport errors show ONLY the pill, never their raw message.
      expect(text).not.toContain('stream dropped');
    } finally {
      act(() => {
        renderer.unmount();
      });
    }
  });

  test('non-terminal error while connected: no pill, no red banner, transcript renders plainly', async () => {
    const { AcpSessionChat } = await import('./acp-session-chat');
    const items: AcpChatItem[] = [userMsg('u1', 'hello there')];

    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <AcpSessionChat
          acp={baseAcp({
            ready: true,
            chatItems: items,
            connection: 'open',
            errorInfo: { kind: 'rpc', message: 'transient hiccup', terminal: false },
          })}
          sessionId="s1"
          sessionTitle="Session"
          projectId="p1"
        />,
      );
    });

    try {
      const text = textOf(renderer.root);
      expect(text).not.toContain('Reconnecting');
      expect(text).not.toContain('transient hiccup');
      expect(text).toContain('hello there');
    } finally {
      act(() => {
        renderer.unmount();
      });
    }
  });

  test('terminal error with an existing transcript: transcript keeps rendering, inline error row (not full-bleed ErrorState) appended with a working Retry', async () => {
    const { AcpSessionChat } = await import('./acp-session-chat');
    const { ErrorState } = await import('@/features/layout/section/error-state');
    const items: AcpChatItem[] = [userMsg('u1', 'hello there')];

    const retryCalls: number[] = [];
    const acp = baseAcp({
      ready: false,
      chatItems: items,
      errorInfo: { kind: 'transport', message: 'The connection was refused.', terminal: true },
      retry: () => {
        retryCalls.push(1);
      },
    });

    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<AcpSessionChat acp={acp} sessionId="s1" sessionTitle="Session" projectId="p1" />);
    });

    try {
      const text = textOf(renderer.root);
      // The transcript never blanks — it keeps rendering alongside the error.
      expect(text).toContain('hello there');
      expect(text).toContain('The connection to the agent failed.');
      // Not the full-bleed centered ErrorState — an inline row instead.
      expect(renderer.root.findAllByType(ErrorState)).toHaveLength(0);
      expect(renderer.root.findAllByType(Skeleton)).toHaveLength(0);

      const retryButton = findButtonsWithText(renderer, 'Retry')[0];
      expect(retryButton).toBeTruthy();
      act(() => {
        (retryButton.props as { onClick: () => void }).onClick();
      });
      expect(retryCalls).toEqual([1]);
    } finally {
      act(() => {
        renderer.unmount();
      });
    }
  });

  test('non-terminal error before ready: skeleton still renders instead of dead air', async () => {
    const { AcpSessionChat } = await import('./acp-session-chat');

    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <AcpSessionChat
          acp={baseAcp({
            ready: false,
            errorInfo: { kind: 'rpc', message: 'bootstrapping hiccup', terminal: false },
          })}
          sessionId="s1"
          sessionTitle="Session"
          projectId="p1"
        />,
      );
    });

    try {
      expect(renderer.root.findAllByType(Skeleton)).toHaveLength(4);
      const text = textOf(renderer.root);
      expect(text).not.toContain('bootstrapping hiccup');
      expect(text).not.toContain('Something went wrong');
    } finally {
      act(() => {
        renderer.unmount();
      });
    }
  });

  test('terminal error disables the composer', async () => {
    const { AcpSessionChat } = await import('./acp-session-chat');
    lastComposerChatInputProps = null;

    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <AcpSessionChat
          acp={baseAcp({
            ready: true,
            errorInfo: { kind: 'transport', message: 'gone', terminal: true },
          })}
          sessionId="s1"
          sessionTitle="Session"
          projectId="p1"
        />,
      );
    });

    try {
      const props = lastComposerChatInputProps as Record<string, unknown> | null;
      expect(props?.disabled).toBe(true);
    } finally {
      act(() => {
        renderer.unmount();
      });
    }
  });
});

describe('AcpSessionChat — raw protocol frame rendering', () => {
  test('every raw frame renders inline as an AcpUnknownMethodCard (method label), with no "Protocol events" Disclosure', async () => {
    const { AcpSessionChat } = await import('./acp-session-chat');
    const items: AcpChatItem[] = [
      userMsg('u1', 'turn one'),
      assistantMsg('a1', 'ack'),
      rawItem('session/update', { n: 1 }),
      rawItem('session/update', { n: 2 }),
      userMsg('u2', 'turn two'),
      rawItem('session/update', { n: 3 }),
    ];

    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <AcpSessionChat acp={baseAcp({ ready: true, chatItems: items })} sessionId="s1" sessionTitle="Session" projectId="p1" />,
      );
    });

    try {
      // The grouping pipeline delegates every raw frame to its own inline
      // card (mirroring THEIRS) — the old per-turn grouped "Protocol events (n)"
      // Disclosure is gone.
      expect(findButtonsWithText(renderer, 'Protocol events')).toHaveLength(0);
      // Each of the 3 raw frames surfaces its method label inline.
      const text = textOf(renderer.root);
      const occurrences = text.split('session/update').length - 1;
      expect(occurrences).toBe(3);
      expect(renderer.root.findAllByType('details')).toHaveLength(0);
    } finally {
      act(() => {
        renderer.unmount();
      });
    }
  });

  test('two consecutive same-tool calls collapse into ONE AcpSameToolGroup wrapper (single "Edit · 2x" header)', async () => {
    const { AcpSessionChat } = await import('./acp-session-chat');
    const items: AcpChatItem[] = [
      userMsg('u1', 'edit two files'),
      toolItem('t1', 'Edit a.ts', 'edit'),
      toolItem('t2', 'Edit b.ts', 'edit'),
    ];

    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <AcpSessionChat acp={baseAcp({ ready: true, chatItems: items })} sessionId="s1" sessionTitle="Session" projectId="p1" />,
      );
    });

    try {
      // The two consecutive `edit` tool calls fold into exactly one grouped
      // pile wrapper (its collapsed header reads "Edit · 2x") rather than two
      // standalone tool cards.
      const text = textOf(renderer.root);
      const headerCount = text.split('Edit · 2x').length - 1;
      expect(headerCount).toBe(1);

      // Rest-visible disclosure affordance (Task WS5-P3-a): the group's
      // chevron must never carry `opacity-0` at rest — it's visible from the
      // start, only its rotation animates on open.
      const chevrons = renderer.root.findAllByType(ChevronRight);
      expect(chevrons.length).toBeGreaterThan(0);
      for (const chevron of chevrons) {
        const className = (chevron.props as { className?: string }).className ?? '';
        expect(className).not.toContain('opacity-0');
      }
    } finally {
      act(() => {
        renderer.unmount();
      });
    }
  });

  test('a folded reasoning group also shows a rest-visible chevron (same disclosure idiom as the same-tool group)', async () => {
    const { AcpSessionChat } = await import('./acp-session-chat');
    const items: AcpChatItem[] = [
      userMsg('u1', 'think it through'),
      thoughtMsg('r1', 'First, consider the options.'),
      thoughtMsg('r2', 'Second, weigh the tradeoffs.'),
    ];

    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <AcpSessionChat acp={baseAcp({ ready: true, chatItems: items })} sessionId="s1" sessionTitle="Session" projectId="p1" />,
      );
    });

    try {
      const chevrons = renderer.root.findAllByType(ChevronRight);
      expect(chevrons.length).toBeGreaterThan(0);
      for (const chevron of chevrons) {
        const className = (chevron.props as { className?: string }).className ?? '';
        expect(className).not.toContain('opacity-0');
      }
    } finally {
      act(() => {
        renderer.unmount();
      });
    }
  });
});

describe('AcpSessionChat — permission prompt in the composer', () => {
  test('a pending permission is handed to the composer inputSlot as an AcpSessionPermissionPrompt (not an inline transcript card)', async () => {
    const { AcpSessionChat } = await import('./acp-session-chat');
    const { AcpSessionPermissionPrompt } = await import('./acp-session-permission-prompt');
    lastComposerChatInputProps = null;

    const permission = {
      id: 7,
      method: 'session/request_permission',
      permission: 'Run shell command',
      patterns: [],
      options: [{ optionId: 'allow', label: 'Allow' }],
      params: {},
    };

    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <AcpSessionChat
          acp={baseAcp({
            ready: true,
            chatItems: [userMsg('u1', 'run pwd'), permissionItem(7)],
            pendingPrompts: { permissions: [permission as any], questions: [] },
          })}
          sessionId="s1"
          sessionTitle="Session"
          projectId="p1"
        />,
      );
    });

    try {
      const slot = (lastComposerChatInputProps as Record<string, unknown> | null)?.inputSlot as ReactElement;
      expect(slot).toBeTruthy();
      const children = Children.toArray((slot.props as { children?: ReactNode }).children);
      const promptEl = children.find(
        (child): child is ReactElement => isValidElement(child) && child.type === AcpSessionPermissionPrompt,
      );
      expect(promptEl).toBeTruthy();
      expect((promptEl!.props as { permissions: unknown[] }).permissions).toHaveLength(1);
      expect((promptEl!.props as { permissions: Array<{ id: number }> }).permissions[0]?.id).toBe(7);

      // The permission does NOT render as an inline transcript card any more —
      // its chat item renders nothing, so the old testids are absent.
      expect(renderer.root.findAll((node) => node.props?.['data-testid'] === 'acp-permission-card')).toHaveLength(0);
    } finally {
      act(() => {
        renderer.unmount();
      });
    }
  });
});

describe('AcpSessionChat — config options in the composer toolbar', () => {
  test('a mode-typed option renders AcpConfigOptionSegment, a select-typed option renders AcpConfigOptionPill (previously: the filter kept only `select`, so a mode option rendered nothing)', async () => {
    const { AcpSessionChat } = await import('./acp-session-chat');
    const { AcpConfigOptionPill, AcpConfigOptionSegment } = await import('./acp-config-option-pills');
    lastComposerChatInputProps = null;

    const modeOption = {
      id: 'thinking-mode',
      name: 'Thinking mode',
      type: 'mode',
      currentValue: 'standard',
      options: [
        { id: 'quick', label: 'Quick' },
        { id: 'standard', label: 'Standard' },
        { id: 'deep', label: 'Deep' },
      ],
    };
    const selectOption = {
      id: 'reasoning',
      name: 'Reasoning',
      type: 'select',
      currentValue: 'balanced',
      options: [
        { id: 'fast', label: 'Fast' },
        { id: 'balanced', label: 'Balanced' },
      ],
    };

    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <AcpSessionChat
          acp={baseAcp({ configOptions: [modeOption as any, selectOption as any] })}
          sessionId="s1"
          sessionTitle="Session"
          projectId="p1"
        />,
      );
    });

    try {
      const slot = (lastComposerChatInputProps as Record<string, unknown> | null)
        ?.toolbarSlot as ReactElement;
      expect(slot).toBeTruthy();
      const children = Children.toArray((slot.props as { children?: ReactNode }).children);

      const segmentEl = children.find(
        (child): child is ReactElement =>
          isValidElement(child) && child.type === AcpConfigOptionSegment,
      );
      expect(segmentEl).toBeTruthy();
      expect((segmentEl!.props as { option: { id: string } }).option.id).toBe('thinking-mode');

      const pillEl = children.find(
        (child): child is ReactElement => isValidElement(child) && child.type === AcpConfigOptionPill,
      );
      expect(pillEl).toBeTruthy();
      expect((pillEl!.props as { option: { id: string } }).option.id).toBe('reasoning');
    } finally {
      act(() => {
        renderer.unmount();
      });
    }
  });

  test('setConfigOption reaches the session with the mode option id when the segment fires onChange', async () => {
    const { AcpSessionChat } = await import('./acp-session-chat');
    const { AcpConfigOptionSegment } = await import('./acp-config-option-pills');
    lastComposerChatInputProps = null;

    const setCalls: Array<[string, unknown]> = [];
    const modeOption = {
      id: 'thinking-mode',
      name: 'Thinking mode',
      type: 'mode',
      currentValue: 'standard',
      options: [
        { id: 'quick', label: 'Quick' },
        { id: 'standard', label: 'Standard' },
      ],
    };

    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <AcpSessionChat
          acp={baseAcp({
            configOptions: [modeOption as any],
            setConfigOption: async (id: string, value: unknown) => {
              setCalls.push([id, value]);
              return true;
            },
          })}
          sessionId="s1"
          sessionTitle="Session"
          projectId="p1"
        />,
      );
    });

    try {
      const slot = (lastComposerChatInputProps as Record<string, unknown> | null)
        ?.toolbarSlot as ReactElement;
      const children = Children.toArray((slot.props as { children?: ReactNode }).children);
      const segmentEl = children.find(
        (child): child is ReactElement =>
          isValidElement(child) && child.type === AcpConfigOptionSegment,
      ) as ReactElement;
      const onChange = (segmentEl.props as { onChange: (value: unknown) => unknown }).onChange;

      await act(async () => {
        await onChange('quick');
      });

      expect(setCalls).toEqual([['thinking-mode', 'quick']]);
    } finally {
      act(() => {
        renderer.unmount();
      });
    }
  });

  test('a busy session renders the config controls disabled — same lock the send/voice controls key off', async () => {
    const { AcpSessionChat } = await import('./acp-session-chat');
    const { AcpConfigOptionPill, AcpConfigOptionSegment } = await import('./acp-config-option-pills');
    lastComposerChatInputProps = null;

    const modeOption = {
      id: 'thinking-mode',
      name: 'Thinking mode',
      type: 'mode',
      currentValue: 'standard',
      options: [
        { id: 'quick', label: 'Quick' },
        { id: 'standard', label: 'Standard' },
      ],
    };
    const selectOption = {
      id: 'reasoning',
      name: 'Reasoning',
      type: 'select',
      currentValue: 'balanced',
      options: [
        { id: 'fast', label: 'Fast' },
        { id: 'balanced', label: 'Balanced' },
      ],
    };

    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <AcpSessionChat
          acp={baseAcp({ busy: true, configOptions: [modeOption as any, selectOption as any] })}
          sessionId="s1"
          sessionTitle="Session"
          projectId="p1"
        />,
      );
    });

    try {
      const slot = (lastComposerChatInputProps as Record<string, unknown> | null)
        ?.toolbarSlot as ReactElement;
      const children = Children.toArray((slot.props as { children?: ReactNode }).children);

      const segmentEl = children.find(
        (child): child is ReactElement =>
          isValidElement(child) && child.type === AcpConfigOptionSegment,
      ) as ReactElement;
      const pillEl = children.find(
        (child): child is ReactElement => isValidElement(child) && child.type === AcpConfigOptionPill,
      ) as ReactElement;

      expect((segmentEl.props as { disabled?: boolean }).disabled).toBe(true);
      expect((pillEl.props as { disabled?: boolean }).disabled).toBe(true);
    } finally {
      act(() => {
        renderer.unmount();
      });
    }
  });
});

describe('AcpSessionChat — message queue while busy', () => {
  test('a message enqueued via the composer surfaces in live.queuedMessages, then flushes through acp.send once busy clears', async () => {
    const { AcpSessionChat } = await import('./acp-session-chat');
    lastComposerChatInputProps = null;

    const sendCalls: unknown[] = [];
    const acp = baseAcp({
      busy: true,
      send: async (blocks: unknown) => {
        sendCalls.push(blocks);
        return true;
      },
    });

    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <AcpSessionChat acp={acp} sessionId="s1" sessionTitle="Session" projectId="p1" />,
      );
    });

    const readLive = () => {
      const props = lastComposerChatInputProps as Record<string, unknown> | null;
      return props?.live as {
        queuedMessages: { id: string; text: string }[];
        onQueueMessage: (text: string) => void;
      };
    };

    try {
      // `SessionChatInput`'s own `handleSubmit` is what routes a busy-time
      // submit to `onQueueMessage` instead of `onSend` — it's mocked out
      // here, so the test drives `live.onQueueMessage` directly, exactly as
      // that routing would.
      expect(readLive().queuedMessages).toEqual([]);

      act(() => {
        readLive().onQueueMessage('queued while busy');
      });

      expect(readLive().queuedMessages).toHaveLength(1);
      expect(readLive().queuedMessages[0]?.text).toBe('queued while busy');
      expect(sendCalls).toHaveLength(0);

      // Busy clears → the flush effect drains the queue through acp.send.
      await act(async () => {
        renderer.update(
          <AcpSessionChat acp={{ ...acp, busy: false }} sessionId="s1" sessionTitle="Session" projectId="p1" />,
        );
      });

      expect(sendCalls).toEqual([[{ type: 'text', text: 'queued while busy' }]]);
      expect(readLive().queuedMessages).toEqual([]);
    } finally {
      act(() => {
        renderer.unmount();
      });
    }
  });
});

describe('AcpPlanCard — entry status ticks', () => {
  test('completed entries get a green check, in-progress a loading spinner, everything else a muted dot', async () => {
    const plan = {
      entries: [
        { status: 'completed', content: 'Step one' },
        { status: 'in_progress', content: 'Step two' },
        { status: 'pending', content: 'Step three' },
        'Step four (string entry)',
      ],
      data: {},
    };

    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<AcpPlanCard plan={plan} />);
    });

    try {
      const text = textOf(renderer.root);
      expect(text).toContain('Step one');
      expect(text).toContain('Step two');
      expect(text).toContain('Step three');
      expect(text).toContain('Step four (string entry)');
      // Exactly one completed entry → exactly one green check.
      expect(renderer.root.findAllByType(Check)).toHaveLength(1);
      // Exactly one in-progress entry → exactly one Loading spinner tick.
      expect(renderer.root.findAllByType(Loading)).toHaveLength(1);
    } finally {
      act(() => {
        renderer.unmount();
      });
    }
  });

  test('a title-only entry (no content) still renders its text', async () => {
    const plan = { entries: [{ status: 'completed', title: 'From title' }], data: {} };

    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<AcpPlanCard plan={plan} />);
    });

    try {
      expect(textOf(renderer.root)).toContain('From title');
    } finally {
      act(() => {
        renderer.unmount();
      });
    }
  });
});

describe('AcpSessionChat — turn footer chips', () => {
  test('a completed turn with ordinal timestamps renders a duration chip; a turn without a completed response renders none', async () => {
    const { AcpSessionChat } = await import('./acp-session-chat');

    // Ordinal timestamps 5s apart on the user prompt / assistant reply —
    // `acpTurnDurationMs` reads these back via each item id's embedded
    // envelope ordinal (`prompt-1` / `assistant-2`), exactly as THEIRS does.
    const completedRows: any[] = [
      {
        ordinal: 1,
        direction: 'client_to_agent',
        streamEventId: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        envelope: { jsonrpc: '2.0', id: 1, method: 'session/prompt', params: { prompt: [{ type: 'text', text: 'Summarize this' }] } },
      },
      {
        ordinal: 2,
        direction: 'agent_to_client',
        streamEventId: 1,
        createdAt: '2026-01-01T00:00:05.000Z',
        envelope: { jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } } } },
      },
    ];
    const completedItems = projectAcpEnvelopes(completedRows);

    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <AcpSessionChat
          acp={baseAcp({ ready: true, busy: false, chatItems: completedItems, envelopes: completedRows as any })}
          sessionId="s1"
          sessionTitle="Session"
          projectId="p1"
        />,
      );
    });

    try {
      const footers = renderer.root.findAll((node) => node.props?.['data-testid'] === 'acp-turn-footer');
      expect(footers).toHaveLength(1);
      expect(textOf(footers[0]!)).toContain('5s');
    } finally {
      act(() => {
        renderer.unmount();
      });
    }

    // A turn with only a user prompt — no assistant reply landed yet — never
    // renders a footer (mirrors THEIRS' `lastAssistantText` gate).
    const pendingRows: any[] = [
      {
        ordinal: 1,
        direction: 'client_to_agent',
        streamEventId: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        envelope: { jsonrpc: '2.0', id: 1, method: 'session/prompt', params: { prompt: [{ type: 'text', text: 'Hi' }] } },
      },
    ];
    const pendingItems = projectAcpEnvelopes(pendingRows);

    let pendingRenderer!: ReactTestRenderer;
    act(() => {
      pendingRenderer = create(
        <AcpSessionChat
          acp={baseAcp({ ready: true, busy: false, chatItems: pendingItems, envelopes: pendingRows as any })}
          sessionId="s2"
          sessionTitle="Session"
          projectId="p1"
        />,
      );
    });

    try {
      const footers = pendingRenderer.root.findAll((node) => node.props?.['data-testid'] === 'acp-turn-footer');
      expect(footers).toHaveLength(0);
    } finally {
      act(() => {
        pendingRenderer.unmount();
      });
    }
  });

  // ordinal timestamps 5s apart on turn 1, 12s apart on turn 2 (both
  // completed) — mirrors the shape of `acpTurnDurationMs`'s own fixture.
  const twoTurnRows: any[] = [
    { ordinal: 1, direction: 'client_to_agent', streamEventId: null, createdAt: '2026-01-01T00:00:00.000Z', envelope: { jsonrpc: '2.0', id: 1, method: 'session/prompt', params: { prompt: [{ type: 'text', text: 'First' }] } } },
    { ordinal: 2, direction: 'agent_to_client', streamEventId: 1, createdAt: '2026-01-01T00:00:05.000Z', envelope: { jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'First done.' } } } } },
    { ordinal: 3, direction: 'client_to_agent', streamEventId: null, createdAt: '2026-01-01T00:01:00.000Z', envelope: { jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { prompt: [{ type: 'text', text: 'Second' }] } } },
    { ordinal: 4, direction: 'agent_to_client', streamEventId: 2, createdAt: '2026-01-01T00:01:12.000Z', envelope: { jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Second done.' } } } } },
  ];

  test('the last turn footer is rest-visible (no opacity-0 hover-gate, tabular-nums, full-contrast text); a historical turn stays hover-only', async () => {
    const { AcpSessionChat } = await import('./acp-session-chat');
    const twoTurnItems = projectAcpEnvelopes(twoTurnRows);

    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <AcpSessionChat
          acp={baseAcp({
            ready: true,
            busy: false,
            chatItems: twoTurnItems,
            envelopes: twoTurnRows as any,
            usage: { used: null, size: null, percent: null, cost: { amount: 0.42, currency: 'USD' }, tokens: null, source: 'usage_update' },
          })}
          sessionId="s1"
          sessionTitle="Session"
          projectId="p1"
        />,
      );
    });

    try {
      const footers = renderer.root.findAll((node) => node.props?.['data-testid'] === 'acp-turn-footer');
      expect(footers).toHaveLength(2);

      const [historicalFooter, lastFooter] = footers;
      const historicalClassName = (historicalFooter!.props as { className?: string }).className ?? '';
      const lastClassName = (lastFooter!.props as { className?: string }).className ?? '';

      // Historical turn: still hover-gated (noise control), but its
      // duration still renders when present.
      expect(historicalClassName).toContain('opacity-0');
      expect(textOf(historicalFooter!)).toContain('5s');

      // Last turn: rest-visible — no opacity-0 hover-gate at all — carrying
      // duration · session cost, with tabular-nums on the numbers and
      // full-contrast (not the dimmer hover-only tint) text.
      expect(lastClassName).not.toContain('opacity-0');
      expect(lastClassName).toContain('text-xs');
      expect(lastClassName).toContain('text-muted-foreground');
      const lastText = textOf(lastFooter!);
      expect(lastText).toContain('12s');
      expect(lastText).toContain('$0.42');

      // The meta cluster is an `InlineMeta` (dot-separated duration · session
      // cost) with tabular numbers, at full contrast — not the historical
      // row's dimmer `/50` tint.
      const lastMeta = lastFooter!.findByType(InlineMeta);
      const lastMetaClassName = (lastMeta.props as { className?: string }).className ?? '';
      expect(lastMetaClassName).toContain('tabular-nums');
      expect(lastMetaClassName).not.toContain('/50');
    } finally {
      act(() => {
        renderer.unmount();
      });
    }
  });
});

describe('AcpSessionChat — session usage in the turn footer', () => {
  function usage(overrides: Partial<AcpUsageProjection> = {}): AcpUsageProjection {
    return { used: null, size: null, percent: null, cost: null, tokens: null, source: 'usage_update', ...overrides };
  }

  // One completed turn (5s apart), same shape as the turn-footer fixtures —
  // the session totals render on the LAST completed turn's footer line, so
  // every test here needs a completed turn to hang them off.
  const completedTurnRows: any[] = [
    { ordinal: 1, direction: 'client_to_agent', streamEventId: null, createdAt: '2026-01-01T00:00:00.000Z', envelope: { jsonrpc: '2.0', id: 1, method: 'session/prompt', params: { prompt: [{ type: 'text', text: 'Summarize this' }] } } },
    { ordinal: 2, direction: 'agent_to_client', streamEventId: 1, createdAt: '2026-01-01T00:00:05.000Z', envelope: { jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } } } } },
  ];

  test('no usage data → the footer carries only the turn duration, and no detached usage line renders anywhere', async () => {
    const { AcpSessionChat } = await import('./acp-session-chat');
    const items = projectAcpEnvelopes(completedTurnRows);

    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <AcpSessionChat
          acp={baseAcp({ ready: true, busy: false, chatItems: items, envelopes: completedTurnRows as any, usage: null })}
          sessionId="s1"
          sessionTitle="Session"
          projectId="p1"
        />,
      );
    });

    try {
      // The old standalone above-the-composer meta line is gone for good.
      expect(renderer.root.findAll((node) => node.props?.['data-testid'] === 'acp-session-usage-meta')).toHaveLength(0);

      const footers = renderer.root.findAll((node) => node.props?.['data-testid'] === 'acp-turn-footer');
      expect(footers).toHaveLength(1);
      const footerText = textOf(footers[0]!);
      expect(footerText).toContain('5s');
      // Never a fabricated "$…" / "0 ctx" chip when the harness reported nothing.
      expect(footerText).not.toContain('$');
      expect(footerText).not.toContain('ctx');
    } finally {
      act(() => {
        renderer.unmount();
      });
    }
  });

  test('session totals project into the LAST turn footer — "$0.42 this session · 128k ctx" — with tabular-nums', async () => {
    const { AcpSessionChat } = await import('./acp-session-chat');
    const items = projectAcpEnvelopes(completedTurnRows);

    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <AcpSessionChat
          acp={baseAcp({
            ready: true,
            busy: false,
            chatItems: items,
            envelopes: completedTurnRows as any,
            usage: usage({ used: 128_000, cost: { amount: 0.42, currency: 'USD' } }),
          })}
          sessionId="s1"
          sessionTitle="Session"
          projectId="p1"
        />,
      );
    });

    try {
      const footers = renderer.root.findAll((node) => node.props?.['data-testid'] === 'acp-turn-footer');
      expect(footers).toHaveLength(1);
      const footerText = textOf(footers[0]!);
      expect(footerText).toContain('5s');
      expect(footerText).toContain('$0.42 this session');
      expect(footerText).toContain('128k ctx');

      const inlineMeta = footers[0]!.findByType(InlineMeta);
      expect((inlineMeta.props as { className?: string }).className ?? '').toContain('tabular-nums');
    } finally {
      act(() => {
        renderer.unmount();
      });
    }
  });

  test('updates in place (same single footer line) when the usage snapshot changes — no new query, pure re-projection', async () => {
    const { AcpSessionChat } = await import('./acp-session-chat');
    const items = projectAcpEnvelopes(completedTurnRows);
    const mount = (usageSnapshot: AcpUsageProjection) => (
      <AcpSessionChat
        acp={baseAcp({ ready: true, busy: false, chatItems: items, envelopes: completedTurnRows as any, usage: usageSnapshot })}
        sessionId="s1"
        sessionTitle="Session"
        projectId="p1"
      />
    );

    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(mount(usage({ used: 40_000, cost: { amount: 0.1, currency: 'USD' } })));
    });

    try {
      expect(textOf(renderer.root.findAll((node) => node.props?.['data-testid'] === 'acp-turn-footer')[0]!)).toContain('$0.10');

      act(() => {
        renderer.update(mount(usage({ used: 130_000, cost: { amount: 0.55, currency: 'USD' } })));
      });

      const updatedFooters = renderer.root.findAll((node) => node.props?.['data-testid'] === 'acp-turn-footer');
      // Still exactly one footer — the update replaced its text, not its shape.
      expect(updatedFooters).toHaveLength(1);
      const updatedText = textOf(updatedFooters[0]!);
      expect(updatedText).toContain('$0.55 this session');
      expect(updatedText).toContain('130k ctx');
    } finally {
      act(() => {
        renderer.unmount();
      });
    }
  });
});

describe('ACP-native chat projection', () => {
  test('keeps user prompts, assistant chunks, thoughts, tools, and permissions protocol-native', () => {
    const rows: any[] = [
      { ordinal: 1, direction: 'client_to_agent', streamEventId: null, envelope: { jsonrpc: '2.0', id: 1, method: 'session/prompt', params: { prompt: [{ type: 'text', text: 'Review this' }] } } },
      { ordinal: 2, direction: 'agent_to_client', streamEventId: 1, envelope: { jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Checking' } } } } },
      { ordinal: 3, direction: 'agent_to_client', streamEventId: 2, envelope: { jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Looks ' } } } } },
      { ordinal: 4, direction: 'agent_to_client', streamEventId: 3, envelope: { jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'good' } } } } },
      { ordinal: 5, direction: 'agent_to_client', streamEventId: 4, envelope: { jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'tool_call', title: 'Read file' } } } },
      { ordinal: 6, direction: 'agent_to_client', streamEventId: 5, envelope: { jsonrpc: '2.0', id: 9, method: 'session/request_permission', params: { options: [{ optionId: 'allow', name: 'Allow' }] } } },
      { ordinal: 7, direction: 'agent_to_client', streamEventId: 6, envelope: { jsonrpc: '2.0', id: 10, method: 'elicitation/create', params: { message: 'Choose environment', requestedSchema: { type: 'object', properties: { environment: { title: 'Environment', enum: ['staging', 'production'] } } } } } },
    ];

    expect(projectAcpEnvelopes(rows)).toMatchObject([
      { kind: 'message', role: 'user', text: 'Review this' },
      { kind: 'message', role: 'thought', text: 'Checking' },
      { kind: 'message', role: 'assistant', text: 'Looks good' },
      { kind: 'tool', title: 'Read file' },
      { kind: 'permission', id: 9, method: 'session/request_permission' },
      { kind: 'question', id: 10, method: 'elicitation/create', questions: [{ key: 'environment', question: 'Environment' }] },
    ]);
  });
});

describe('AcpSessionChat — refusal / truncation footer note', () => {
  // One completed turn to hang the last-turn footer note off.
  const completedTurnRows: any[] = [
    { ordinal: 1, direction: 'client_to_agent', streamEventId: null, createdAt: '2026-01-01T00:00:00.000Z', envelope: { jsonrpc: '2.0', id: 1, method: 'session/prompt', params: { prompt: [{ type: 'text', text: 'Write a long essay' }] } } },
    { ordinal: 2, direction: 'agent_to_client', streamEventId: 1, createdAt: '2026-01-01T00:00:05.000Z', envelope: { jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Once upon a time' } } } } },
  ];

  test('truncation renders a plain explanation + a Continue action that sends "Continue"', async () => {
    const { AcpSessionChat } = await import('./acp-session-chat');
    const items = projectAcpEnvelopes(completedTurnRows);
    const sent: string[] = [];

    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <AcpSessionChat
          acp={baseAcp({
            ready: true,
            busy: false,
            chatItems: items,
            envelopes: completedTurnRows as any,
            stopReason: 'max_tokens',
            send: async (blocks: any) => {
              sent.push(blocks?.[0]?.text ?? '');
              return true;
            },
          } as any)}
          sessionId="s1"
          sessionTitle="Session"
          projectId="p1"
        />,
      );
    });

    try {
      const note = renderer.root.findAll((n) => n.props?.['data-testid'] === 'acp-stop-reason-note');
      expect(note).toHaveLength(1);
      expect(textOf(note[0]!)).toContain('The response hit its length limit.');

      const continueBtn = note[0]!.findAll(
        (n) => typeof n.type === 'string' && n.type === 'button' && textOf(n).includes('Continue'),
      );
      expect(continueBtn.length).toBeGreaterThanOrEqual(1);
      act(() => {
        (continueBtn[0]!.props as { onClick?: () => void }).onClick?.();
      });
      expect(sent).toContain('Continue');
    } finally {
      act(() => {
        renderer.unmount();
      });
    }
  });

  test('refusal renders an honest explanation and NO Continue action', async () => {
    const { AcpSessionChat } = await import('./acp-session-chat');
    const items = projectAcpEnvelopes(completedTurnRows);

    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <AcpSessionChat
          acp={baseAcp({ ready: true, busy: false, chatItems: items, envelopes: completedTurnRows as any, stopReason: 'refusal' } as any)}
          sessionId="s1"
          sessionTitle="Session"
          projectId="p1"
        />,
      );
    });

    try {
      const note = renderer.root.findAll((n) => n.props?.['data-testid'] === 'acp-stop-reason-note');
      expect(note).toHaveLength(1);
      expect(textOf(note[0]!)).toContain('The model declined this request.');
      expect(textOf(note[0]!)).not.toContain('Continue');
    } finally {
      act(() => {
        renderer.unmount();
      });
    }
  });

  test('a clean end_turn finish renders no stop-reason note at all', async () => {
    const { AcpSessionChat } = await import('./acp-session-chat');
    const items = projectAcpEnvelopes(completedTurnRows);

    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <AcpSessionChat
          acp={baseAcp({ ready: true, busy: false, chatItems: items, envelopes: completedTurnRows as any, stopReason: 'end_turn' } as any)}
          sessionId="s1"
          sessionTitle="Session"
          projectId="p1"
        />,
      );
    });

    try {
      expect(renderer.root.findAll((n) => n.props?.['data-testid'] === 'acp-stop-reason-note')).toHaveLength(0);
    } finally {
      act(() => {
        renderer.unmount();
      });
    }
  });
});
