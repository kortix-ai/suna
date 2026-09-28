import { NextIntlClientProvider } from '@/i18n/use-translations';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { SidebarProvider } from '@/components/ui/sidebar';
import type { SessionPrompt } from '@kortix/sdk';
import enMessages from '../../../translations/en.json';
import { TurnErrorDisplay } from './session-error-banner';

const realSdk = await import('@kortix/sdk/react');
const fixtureMessages = [
  {
    info: { id: 'user-fixture', role: 'user', time: { created: 1 } },
    parts: [{ id: 'text-fixture', type: 'text', text: 'synthetic prompt' }],
  },
  {
    info: {
      id: 'assistant-fixture',
      role: 'assistant',
      parentID: 'user-fixture',
      agent: 'build',
      time: { created: 2 },
    },
    parts: [{ id: 'answer-fixture', type: 'text', text: 'synthetic answer' }],
  },
];
let inboxPrompts: SessionPrompt[] = [];
let busy = false;
mock.module('@kortix/sdk/react', () => ({
  ...realSdk,
  useSessionMessages: () => fixtureMessages,
  useSessionSync: () => ({
    messages: fixtureMessages,
    freshness: 'fresh',
    isLoading: false,
    hasOlder: false,
    isLoadingOlder: false,
    loadOlder: async () => {},
  }),
  useRuntimeReady: () => true,
  useRuntimeSession: () => ({ data: { id: 'session-fixture' }, isFetched: true }),
  useRuntimeAgents: () => ({ data: [{ name: 'build' }] }),
  useRuntimeCommands: () => ({ data: [] }),
  useRuntimeProviders: () => ({ data: [], isLoading: false }),
  useRuntimeSessions: () => ({ data: [] }),
  useRuntimeConfig: () => ({ data: {} }),
  useProjectConfig: () => ({}),
  useSessionPrompts: () => ({ prompts: inboxPrompts }),
  useSessionWorking: () => ({
    state: busy ? 'working' : 'idle',
    turnId: busy ? 'user-fixture' : null,
    serverOpenTurnToken: null,
  }),
}));
mock.module('next/navigation', () => ({
  useParams: () => ({}),
  usePathname: () => '/',
  useRouter: () => ({ push: () => {} }),
  useSearchParams: () => new URLSearchParams(),
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
const { SessionChat, deriveTurnErrorAbortState, deriveTurnErrorPresentation } =
  await import('./session-chat');

const errorTurn = (error?: unknown) => ({ assistantMessages: [{ info: { error } }] });

describe('SessionChat turn error presentation', () => {
  test('aborted turn stays silent without a control-plane notice', () => {
    const state = deriveTurnErrorAbortState(
      errorTurn({ name: 'AbortError', data: { reason: 'user' } }),
    );
    expect(state).toEqual({ isAbort: true });
    const row = deriveTurnErrorPresentation({ turnError: 'Aborted', ...state, notice: null });
    expect(row).toEqual({ text: 'Aborted', isAbort: true, suggestion: undefined });
    expect(
      renderToStaticMarkup(
        createElement(TurnErrorDisplay, { errorText: row.text, isAbort: row.isAbort }),
      ),
    ).toBe('');
  });

  test('failed turn is not mistaken for an abort when its prose mentions one', () => {
    const state = deriveTurnErrorAbortState(
      errorTurn({ name: 'Error', data: { message: 'upstream aborted connection' } }),
    );
    expect(state).toEqual({ isAbort: false });
    const row = deriveTurnErrorPresentation({
      turnError: 'upstream aborted connection',
      ...state,
      notice: null,
    });
    expect(row).toEqual({
      text: 'upstream aborted connection',
      isAbort: false,
      suggestion: undefined,
    });
    expect(
      renderToStaticMarkup(
        createElement(TurnErrorDisplay, { errorText: row.text, isAbort: row.isAbort }),
      ),
    ).toContain('upstream aborted connection');
  });

  test('clean turn has no error row', () => {
    const state = deriveTurnErrorAbortState(errorTurn());
    expect(state).toEqual({ isAbort: false });
    const row = deriveTurnErrorPresentation({ turnError: undefined, ...state, notice: null });
    expect(row).toEqual({ text: undefined, isAbort: false, suggestion: undefined });
    expect(row.text).toBeUndefined();
  });
});

describe('SessionChat transcript rows', () => {
  const renderChat = () =>
    renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <NextIntlClientProvider locale="en" messages={enMessages} onError={() => {}}>
          <SidebarProvider>
            <SessionChat
              sessionId="session-fixture"
              projectId="project-fixture"
              projectSessionId="project-session-fixture"
            />
          </SidebarProvider>
        </NextIntlClientProvider>
      </QueryClientProvider>,
    );
  test('a mounted session shows the user and assistant text without a busy row when idle', () => {
    busy = false;
    const markup = renderChat();
    expect(markup).toContain('synthetic prompt');
    expect(markup).toContain('synthetic answer');
    expect(markup).not.toContain('data-testid="session-busy-indicator"');
  });

  test('a working session renders the busy row', () => {
    busy = true;
    const markup = renderChat();
    expect(markup).toContain('data-testid="session-busy-indicator"');
    expect(markup).toContain('Thinking');
    busy = false;
  });

  test('inbox hook rows reach the mounted chat in queued and restored order', () => {
    const queuedPrompt = (id: string, text: string): SessionPrompt => ({
      prompt_id: id,
      client_message_id: `c-${id}`,
      message_id: `m-${id}`,
      text,
      full_text: text,
      state: 'queued',
      placement: 'composer',
      reason: 'turn_active',
      attempts: 0,
      last_error: null,
      created_at: '2026-01-01T00:00:00.000Z',
      available_at: '2026-01-01T00:00:00.000Z',
    });
    inboxPrompts = [
      queuedPrompt('queued', 'queued prompt'),
      queuedPrompt('restored', 'restored prompt'),
    ];
    try {
      const markup = renderChat();
      expect(markup.indexOf('queued prompt')).toBeGreaterThan(-1);
      expect(markup.indexOf('restored prompt')).toBeGreaterThan(markup.indexOf('queued prompt'));
      expect(markup).toContain('data-queued-prompt-id="restored"');
    } finally {
      inboxPrompts = [];
    }
  });
});
