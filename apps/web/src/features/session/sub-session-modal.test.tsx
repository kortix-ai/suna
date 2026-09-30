import { SidebarProvider } from '@/components/ui/sidebar';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * Characterization tests for the sub-session modal mount (spec KRTX-483
 * phase 1). They pin what the later phases restructure, and must pass before
 * and after them: the opener gates the body on first open, and open, the body
 * renders the chat surface for the child session.
 *
 * `SubSessionModal` (the real opener) is mounted for the closed gate. Open,
 * the body is mounted from the real `sub-session-modal-content.tsx` — the
 * module the opener's `next/dynamic` chunk resolves to — not from a stub. The
 * chunk boundary itself is skipped: with `ssr: false` the dynamic wrapper
 * always renders its (null) loading state in a server render, so no static
 * render can reach past it. That is a property of the loader, not of this
 * component tree; everything below it here is real.
 *
 * Harness: static markup (this app has no DOM in tests — no jsdom,
 * no happy-dom, no react-test-renderer). The SDK data hooks are stubbed the
 * same way `session-chat.test.tsx` mounts the real `SessionChat`, so the
 * transcript below is the real chat surface rendering fixture messages. The
 * Radix `Modal` primitives render into a portal, which needs a DOM; the stub
 * replaces exactly that layer with an inline open-gated render and keeps
 * every other export real.
 */

const CHILD_SESSION_ID = 'ses-synth-child';

const fixtureMessages = [
  {
    info: { id: 'user-synth', role: 'user', time: { created: 1 } },
    parts: [{ id: 'text-synth-q', type: 'text', text: 'synthetic sub-agent question' }],
  },
  {
    info: {
      id: 'assistant-synth',
      role: 'assistant',
      parentID: 'user-synth',
      agent: 'build',
      time: { created: 2 },
    },
    parts: [{ id: 'text-synth-a', type: 'text', text: 'synthetic sub-agent answer' }],
  },
];

const syncCalls: Array<{ sessionId: string; options: unknown }> = [];

const realSdkReact = await import('@kortix/sdk/react');
mock.module('@kortix/sdk/react', () => ({
  ...realSdkReact,
  useSessionMessages: () => fixtureMessages,
  useSessionSync: (sessionId: string, options?: unknown) => {
    syncCalls.push({ sessionId, options });
    return {
      messages: fixtureMessages,
      freshness: 'fresh',
      isLoading: false,
      hasOlder: false,
      isLoadingOlder: false,
      loadOlder: async () => {},
    };
  },
  useRuntimeReady: () => true,
  useRuntimeSession: () => ({ data: { id: CHILD_SESSION_ID }, isFetched: true }),
  useRuntimeAgents: () => ({ data: [{ name: 'build' }] }),
  useRuntimeCommands: () => ({ data: [] }),
  useRuntimeProviders: () => ({ data: [], isLoading: false }),
  useRuntimeSessions: () => ({ data: [] }),
  useRuntimeConfig: () => ({ data: {} }),
  useProjectConfig: () => ({}),
  useSessionPrompts: () => ({ prompts: [] }),
  useSessionWorking: () => ({
    state: 'idle',
    turnId: null,
    serverOpenTurnToken: null,
  }),
}));

mock.module('next/navigation', () => ({
  useParams: () => ({ id: 'proj-synthetic', sessionId: 'parent-synthetic' }),
  usePathname: () => '/',
  useRouter: () => ({ push: () => {}, replace: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

const realModal = await import('@/components/ui/modal');
mock.module('@/components/ui/modal', () => ({
  ...realModal,
  // Portal-free stand-ins for the Radix layer only. The body's own chrome
  // (header bar, title, close button, chat slot) renders from its real file.
  Modal: ({ open, children }: { open?: boolean; children?: React.ReactNode }) =>
    open ? <>{children}</> : null,
  ModalContent: ({
    children,
    className,
  }: {
    children?: React.ReactNode;
    className?: string;
  }) => <div className={className}>{children}</div>,
  ModalTitle: ({
    children,
    className,
  }: {
    children?: React.ReactNode;
    className?: string;
  }) => <div className={className}>{children}</div>,
}));

mock.module('@/features/session/header/session-site-header', () => ({
  SessionSiteHeader: () => null,
}));
mock.module('@/features/session/session-approval-prompt', () => ({
  SessionApprovalPrompt: () => null,
}));
mock.module('@/features/session/session-permission-prompt', () => ({
  SessionPermissionPrompt: () => null,
}));
mock.module('@/features/session/composer/composer', () => ({
  COMPOSER_SHELL_CLASS: '',
  Composer: ({ inputSlot }: { inputSlot?: React.ReactNode }) => inputSlot ?? null,
}));

const { SubSessionModal } = await import('./sub-session-modal');
const { SubSessionModalContent } = await import('./sub-session-modal-content');

const renderBody = () =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <SidebarProvider>
        <SubSessionModalContent
          open
          onOpenChange={() => {}}
          sessionId={CHILD_SESSION_ID}
          title="Sub-agent research"
        />
      </SidebarProvider>
    </QueryClientProvider>,
  );

describe('SubSessionModal (the real opener) gates the body on first open', () => {
  test('never opened, the modal mounts nothing', () => {
    const html = renderToStaticMarkup(
      <SubSessionModal open={false} onOpenChange={() => {}} sessionId={CHILD_SESSION_ID} />,
    );
    expect(html).toBe('');
  });
});

describe('SubSessionModalContent (the body the opener mounts) opens onto the child chat', () => {
  test('open, it renders the modal chrome and the chat surface for the child session', () => {
    syncCalls.length = 0;
    const html = renderBody();

    // The modal chrome from the real body: its title and its close control.
    expect(html).toContain('Sub-agent research');
    expect(html).toContain('Close sub-session');

    // The chat surface: the real `SessionChat` renders the child transcript.
    expect(html).toContain('synthetic sub-agent question');
    expect(html).toContain('synthetic sub-agent answer');

    // The chat is mounted FOR the child session: the transcript hook is
    // queried with the child session id and the saved-history scope of the
    // session page the sub-agent runs under (`<projectId>/<parentSessionId>`),
    // marked as a saved child so the view paints while the computer is off.
    expect(syncCalls.length).toBeGreaterThan(0);
    expect(syncCalls[0]?.sessionId).toBe(CHILD_SESSION_ID);
    expect(syncCalls[0]?.options).toEqual({
      kortixSessionScope: 'proj-synthetic/parent-synthetic',
      savedChild: true,
    });
  });
});
