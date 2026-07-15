import { describe, expect, mock, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';

import { projectAcpChatItems as projectAcpEnvelopes, type AcpChatItem } from '@kortix/sdk';
import Loading from '@/components/ui/loading';
import { Skeleton } from '@/components/ui/skeleton';
import { Check } from 'lucide-react';
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
// `useSessionAudit` (the connector-approval lock) calls `useQuery` from
// `@tanstack/react-query`, which needs a `QueryClientProvider` this DOM-free
// harness has no reason to mount. Only that hook is overridden (to a
// no-pending-approvals result) — the module's pure helpers (`relativeTime`,
// `riskTone`, `isPendingAction`, …) stay real, since `session-approval-prompt`
// (imported by `AcpSessionChat`) binds them at module-eval time.
import * as actualSessionAudit from './session-audit-shared';
mock.module('./session-audit-shared', () => ({
  ...actualSessionAudit,
  useSessionAudit: () => ({ data: undefined }),
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
