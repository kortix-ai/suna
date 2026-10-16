import { NextIntlClientProvider } from '@/i18n/use-translations';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { SidebarProvider } from '@/components/ui/sidebar';
import type { ChangeRequest, SessionPrompt, SessionTurnOutcome } from '@kortix/sdk';
import enMessages from '../../../translations/en.json';
import { sessionAuditKey } from './session-audit-shared';
import { TurnErrorDisplay } from './session-error-banner';

const realSdk = await import('@kortix/sdk/react');
const baseFixtureMessages = [
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
let fixtureMessages: any[] = baseFixtureMessages;
const userFixture = (id: string, text: string) => ({
  info: { id, role: 'user', time: { created: 1 } },
  parts: [{ id: `${id}-text`, type: 'text', text }],
});
let inboxPrompts: SessionPrompt[] = [];
let busy = false;
let persistedOutcome: SessionTurnOutcome = {};
let auditPending = false;
/** The `useRuntimeCommands` query's `data`: `undefined` while it loads, the list once it has answered. */
let runtimeCommandsData: { name: string }[] | undefined = [];
/** The `data` the agent-scoped call (`useRuntimeCommands({ agent })`) sees — same cache today, its own hook instance. */
let agentCommandsData: { name: string }[] | undefined = [];
/** The props the last render handed the composer — the host-wire observables. */
let composerProps: { commandsResolved?: boolean } | undefined;
mock.module('@kortix/sdk/react', () => ({
  ...realSdk,
  useSessionTurnOutcome: () => persistedOutcome,
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
  useRuntimeCommands: (opts?: { agent?: string }) => ({
    data: opts !== undefined ? agentCommandsData : runtimeCommandsData,
  }),
  useRuntimeProviders: () => ({ data: [], isLoading: false }),
  useRuntimeSessions: () => ({ data: [] }),
  useRuntimeConfig: () => ({ data: {} }),
  useProjectConfig: () => ({}),
  useSessionPrompts: () => ({ prompts: inboxPrompts }),
  useSessionMessageAuthors: () => ({ data: undefined }),
  useFeatureFlag: () => ({ enabled: true, isLoading: false }),
  useSessionWorking: () => ({
    state: busy ? 'working' : 'idle',
    turnId: busy ? 'user-fixture' : null,
    serverOpenTurnToken: null,
  }),
}));
mock.module('@/features/providers/auth-provider', () => ({
  useAuth: () => ({ user: { id: 'viewer-1', email: 'viewer@example.com' } }),
}));
mock.module('next/navigation', () => ({
  useParams: () => ({ id: 'project-fixture', sessionId: 'project-session-fixture' }),
  usePathname: () => '/',
  useRouter: () => ({ push: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));
mock.module('@/features/session/header/session-site-header', () => ({
  SessionSiteHeader: () => null,
}));
mock.module('@/features/session/session-approval-prompt', () => ({
  SessionApprovalPrompt: () =>
    auditPending ? <button type="button">Approve this call</button> : null,
}));
mock.module('@/features/session/session-permission-prompt', () => ({
  SessionPermissionPrompt: () => null,
}));
mock.module('@/features/session/composer/composer', () => ({
  COMPOSER_SHELL_CLASS: '',
  Composer: (props: {
    aboveSlot?: React.ReactNode;
    inputSlot?: React.ReactNode;
    lockForApproval?: boolean;
    commandsResolved?: boolean;
  }) => {
    composerProps = props;
    return (
      <div>
        {props.aboveSlot}
        {props.inputSlot}
        <textarea aria-label="Message" disabled={props.lockForApproval} />
        <button type="button" disabled={props.lockForApproval}>
          Send
        </button>
      </div>
    );
  },
}));
const { SessionChat, deriveTurnErrorAbortState, deriveTurnErrorPresentation } =
  await import('./session-chat');
const sdk = await import('@kortix/sdk');
const { changeRequestKeys } = await import(
  '@/features/project-files/hooks/use-change-requests'
);

/** A turn whose one reply carries `error`, as the transcript reads it (the `fromV1` view, grouped). */
const errorTurn = (error?: unknown) => {
  const { sessionLogOfV1Rows, sessionLogTurns } = sdk;
  const rows = [
    { info: { id: 'msg_u', sessionID: 'ses', role: 'user', time: { created: 1 } }, parts: [] },
    {
      info: { id: 'msg_a', sessionID: 'ses', role: 'assistant', parentID: 'msg_u', time: { created: 2, completed: 3 }, ...(error ? { error } : {}) },
      parts: [{ id: 'prt_a', sessionID: 'ses', messageID: 'msg_a', type: 'text', text: 'x' }],
    },
  ];
  return sessionLogTurns(sessionLogOfV1Rows('kses', 'ses', rows as never).threads[0]!)[0]!;
};

const changeRequestFixture = (): ChangeRequest => ({
  cr_id: 'cr-fixture',
  account_id: 'account-fixture',
  project_id: 'project-fixture',
  number: 7,
  title: 'synthetic files reorder',
  description: 'a synthetic change request for the outcome pin',
  base_ref: 'main',
  head_ref: 'cr/synthetic',
  status: 'open',
  head_commit_sha: null,
  base_commit_sha: null,
  origin_session_id: 'project-session-fixture',
  created_by: 'agent-fixture',
  merged_at: null,
  merged_by: null,
  merge_commit_sha: null,
  closed_at: null,
  closed_by: null,
  metadata: {},
  created_at: new Date(2000).toISOString(),
  updated_at: new Date(2000).toISOString(),
});

const seedSessionChangeRequests = (client: QueryClient, crs: ChangeRequest[]) =>
  client.setQueryData(
    changeRequestKeys.sessionList('project-fixture', 'project-session-fixture'),
    { change_requests: crs },
  );

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
  const renderChat = (client = new QueryClient()) =>
    renderToStaticMarkup(
      <QueryClientProvider client={client}>
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
  test('persisted failures render without a transcript message and deduplicate last_ended', () => {
    fixtureMessages = [];
    persistedOutcome = {
      recent_failures: [{ message_id: 'install-prompt', ended_at: null, error: { name: 'Error', message: 'synthetic install failure' } }],
      last_ended: { turn_token: 'install-turn', message_id: 'install-prompt', end_reason: 'failed', ended_at: null, error: { name: 'Error', message: 'synthetic install failure' } },
    };
    try {
      expect(renderChat().split('synthetic install failure').length - 1).toBe(1);
      persistedOutcome = { last_ended: { turn_token: 'early-turn', end_reason: 'failed', ended_at: null, error: { name: 'Error', message: 'synthetic early failure' } } };
      expect(renderChat()).toContain('synthetic early failure');
    } finally {
      fixtureMessages = baseFixtureMessages;
      persistedOutcome = {};
    }
  });

  test('unknown persisted failures render after settling even without a transcript', () => {
    fixtureMessages = [];
    persistedOutcome = { atMs: 100000, recent_failures: [{ message_id: 'install-unknown', ended_at: new Date(0).toISOString(), error: null }] };
    try {
      expect(renderChat()).toContain('Agent turn failed. No reason was reported.');
      persistedOutcome = { last_ended: { turn_token: 'unknown-early', end_reason: 'failed', ended_at: null } };
      expect(renderChat()).toContain('Agent turn failed. No reason was reported.');
      persistedOutcome = { atMs: 100001, recent_failures: [{ message_id: 'install-provisional', ended_at: new Date(100000).toISOString(), error: null }] };
      expect(renderChat()).not.toContain('Agent turn failed. No reason was reported.');
    } finally {
      fixtureMessages = baseFixtureMessages;
      persistedOutcome = {};
    }
  });

  // An edit rewinds the failed message and sends a new one; the ledger keeps the
  // old failure under a message id the transcript no longer holds.
  test('a persisted failure clears once a later message is sent, as after an edit', () => {
    persistedOutcome = { atMs: 100000, recent_failures: [{ message_id: 'rewound-prompt', ended_at: new Date(0).toISOString(), error: null }] };
    try {
      fixtureMessages = baseFixtureMessages;
      expect(renderChat()).not.toContain('Agent turn failed. No reason was reported.');
      persistedOutcome = { atMs: 100000, recent_failures: [{ message_id: 'rewound-prompt', ended_at: new Date(50).toISOString(), error: null }] };
      expect(renderChat()).toContain('Agent turn failed. No reason was reported.');
    } finally {
      persistedOutcome = {};
      fixtureMessages = baseFixtureMessages;
    }
  });

  test('persisted failures already represented by transcript rows are not repeated', () => {
    persistedOutcome = { recent_failures: [{ message_id: 'user-fixture', ended_at: null, error: { name: 'Error', message: 'synthetic persisted failure' } }] };
    try {
      fixtureMessages = [];
      expect(renderChat().split('synthetic persisted failure').length - 1).toBe(1);
      fixtureMessages = baseFixtureMessages;
      expect(renderChat().split('synthetic persisted failure').length - 1).toBe(1);
      persistedOutcome = { last_ended: { turn_token: 'done', end_reason: 'completed', ended_at: null, error: { name: 'Error', message: 'stale completed error' } } };
      expect(renderChat()).not.toContain('stale completed error');
      persistedOutcome = { last_ended: { turn_token: 'stop', end_reason: 'failed', ended_at: null, error: { name: 'AbortError', message: 'Aborted' } } };
      expect(renderChat()).not.toContain('Aborted');
    } finally {
      persistedOutcome = {};
      fixtureMessages = baseFixtureMessages;
    }
  });

  test('an audit-pending executor call leaves the editor and send enabled beside its approval action', () => {
    auditPending = true;
    busy = true;
    const client = new QueryClient();
    client.setQueryData(sessionAuditKey('project-fixture', 'project-session-fixture'), {
      actions: [
        { execution_id: 'synthetic-execution', status: 'pending_approval', resolved_at: null },
      ],
    });
    try {
      const markup = renderChat(client);
      expect(markup).toContain('Approve this call');
      expect(markup).toContain('<textarea aria-label="Message"></textarea>');
      expect(markup).toContain('>Send</button>');
    } finally {
      auditPending = false;
      busy = false;
    }
  });

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

  test('a no_reply prompt shows its bubble with no Queued, Sending or Thinking', () => {
    const ask = 'Which region?';
    fixtureMessages = [];
    inboxPrompts = [
      {
        prompt_id: 'ask-1',
        client_message_id: 'c-ask-1',
        message_id: 'm-ask-1',
        text: ask,
        full_text: ask,
        state: 'delivering',
        placement: 'transcript',
        reason: null,
        no_reply: true,
        attempts: 0,
        last_error: null,
        created_at: '2026-01-01T00:00:00.000Z',
        available_at: '2026-01-01T00:00:00.000Z',
      } as SessionPrompt,
    ];
    try {
      const markup = renderChat();
      expect(markup).toContain('Which region?');
      expect(markup).not.toContain('Thinking');
      expect(markup).not.toContain('Sending');
      expect(markup).not.toContain('Queued');
    } finally {
      inboxPrompts = [];
      fixtureMessages = baseFixtureMessages;
    }
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

// Characterization of the moved turn-rendering sections (KRTX-355). Each case
// pins one section the transcript move must preserve, through the whole
// SessionChat render, so the same assertions hold before and after the move.
describe('SessionChat moved turn sections', () => {
  const renderChat = (client = new QueryClient()) =>
    renderToStaticMarkup(
      <QueryClientProvider client={client}>
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

  test('a failed turn renders the transcript error row', () => {
    fixtureMessages = [
      userFixture('user-error', 'do the failing thing'),
      {
        info: {
          id: 'assistant-error',
          role: 'assistant',
          parentID: 'user-error',
          time: { created: 2 },
          error: { name: 'Error', data: { message: 'synthetic runtime failure' } },
        },
        parts: [],
      },
    ];
    try {
      const markup = renderChat();
      expect(markup).toContain('synthetic runtime failure');
    } finally {
      fixtureMessages = baseFixtureMessages;
    }
  });

  test('a running compaction turn renders the compaction marker, not a user bubble', () => {
    fixtureMessages = [
      {
        info: { id: 'user-compaction', role: 'user', time: { created: 1 } },
        parts: [{ id: 'compaction-request', type: 'compaction' }],
      },
      {
        info: {
          id: 'assistant-compaction',
          role: 'assistant',
          parentID: 'user-compaction',
          summary: true,
          time: { created: 2 },
        },
        parts: [],
      },
    ];
    try {
      const markup = renderChat();
      expect(markup).toContain('Compacting context…');
      expect(markup).not.toContain('data-turn-pending');
    } finally {
      fixtureMessages = baseFixtureMessages;
    }
  });

  test('a tool-call turn renders its burst in the steps section', () => {
    fixtureMessages = [
      userFixture('user-tool', 'run the synthetic command'),
      {
        info: {
          id: 'assistant-tool',
          role: 'assistant',
          parentID: 'user-tool',
          agent: 'build',
          time: { created: 2 },
        },
        parts: [
          {
            id: 'tool-part-fixture',
            type: 'tool',
            callID: 'call-tool-fixture',
            tool: 'bash',
            state: {
              status: 'completed',
              input: { command: 'echo synthetic-tool-output' },
              output: 'synthetic-tool-output',
            },
          },
        ],
      },
    ];
    try {
      const markup = renderChat();
      // The settled turn folds its burst behind the "Worked" row (KRTX-2113);
      // the row renders only through the turn's segmented steps section.
      expect(markup).toContain('group/work');
      expect(markup).toContain('>Worked</span>');
      expect(markup).not.toContain('group/burst');
    } finally {
      fixtureMessages = baseFixtureMessages;
    }
  });

  // KRTX-2113: a settled turn folds its work into one "Worked for" row; the
  // `show` deliverable and the final message stay visible below it.
  const foldTurn = (userId: string) => [
    userFixture(userId, 'build the synthetic report'),
    {
      info: {
        id: `${userId}-assistant`,
        role: 'assistant',
        parentID: userId,
        agent: 'build',
        time: { created: 1_000, completed: 135_000 },
      },
      parts: [
        {
          id: `${userId}-bash`,
          type: 'tool',
          callID: `${userId}-call-bash`,
          tool: 'bash',
          state: { status: 'completed', input: { command: 'echo synthetic' }, output: 'synthetic' },
        },
        { id: `${userId}-interim`, type: 'text', text: 'Let me check the synthetic config.' },
        {
          id: `${userId}-bash-2`,
          type: 'tool',
          callID: `${userId}-call-bash-2`,
          tool: 'bash',
          state: { status: 'completed', input: { command: 'echo again' }, output: 'again' },
        },
        {
          id: `${userId}-show`,
          type: 'tool',
          callID: `${userId}-call-show`,
          tool: 'show',
          state: {
            status: 'completed',
            input: { type: 'text', title: 'Synthetic Deliverable', content: 'deliverable body' },
            output: '',
            metadata: {},
          },
        },
        { id: `${userId}-final`, type: 'text', text: 'Here is the synthetic final answer.' },
      ],
    },
  ];

  test('a settled turn shows the Worked row, the hoisted show card and the final text', () => {
    fixtureMessages = foldTurn('user-fold');
    try {
      const markup = renderChat();
      expect(markup).toContain('Worked for 2m 14s');
      expect(markup).toContain('Synthetic Deliverable');
      expect(markup).toContain('Here is the synthetic final answer.');
      expect(markup).not.toContain('Let me check the synthetic config.');
      expect(markup).not.toContain('group/burst');
      // Order: row → deliverable → final text.
      const row = markup.indexOf('Worked for 2m 14s');
      const card = markup.indexOf('Synthetic Deliverable');
      const final = markup.indexOf('Here is the synthetic final answer.');
      expect(row).toBeLessThan(card);
      expect(card).toBeLessThan(final);
    } finally {
      fixtureMessages = baseFixtureMessages;
    }
  });

  const plumbingTurn = (userId: string, parts: unknown[]) => [
    userFixture(userId, 'answer from memory'),
    {
      info: {
        id: `${userId}-assistant`,
        role: 'assistant',
        parentID: userId,
        agent: 'build',
        time: { created: 1_000, completed: 5_000 },
      },
      parts,
    },
  ];
  const prune = (id: string) => ({
    id,
    type: 'tool',
    callID: `call-${id}`,
    tool: 'prune',
    state: { status: 'completed', input: {}, output: 'ok' },
  });

  test('a trailing plumbing-only burst does not hide the final text', () => {
    fixtureMessages = plumbingTurn('user-plumbing', [
      {
        id: 'plumbing-bash',
        type: 'tool',
        callID: 'call-plumbing-bash',
        tool: 'bash',
        state: { status: 'completed', input: { command: 'echo seen' }, output: 'seen' },
      },
      { id: 'plumbing-final', type: 'text', text: 'Synthetic answer after plumbing.' },
      prune('plumbing-prune'),
    ]);
    try {
      const markup = renderChat();
      // The trailing burst renders no row, so it cannot end the turn: the
      // text before it is still the final text.
      expect(markup).toContain('Worked for 4s');
      expect(markup).toContain('Synthetic answer after plumbing.');
    } finally {
      fixtureMessages = baseFixtureMessages;
    }
  });

  test('a turn whose only work is a plumbing burst renders no Worked row', () => {
    fixtureMessages = plumbingTurn('user-plumbing-only', [
      {
        id: 'plumbing-only-show',
        type: 'tool',
        callID: 'call-plumbing-only-show',
        tool: 'show',
        state: {
          status: 'completed',
          input: { type: 'text', title: 'Plumbing Deliverable', content: 'body' },
          output: '',
          metadata: {},
        },
      },
      prune('plumbing-only-prune'),
      { id: 'plumbing-only-final', type: 'text', text: 'Synthetic answer from memory.' },
    ]);
    try {
      const markup = renderChat();
      expect(markup).not.toContain('>Worked');
      expect(markup).toContain('Plumbing Deliverable');
      expect(markup).toContain('Synthetic answer from memory.');
    } finally {
      fixtureMessages = baseFixtureMessages;
    }
  });

  test('a settled turn with no work (a card and text) renders no Worked row', () => {
    fixtureMessages = plumbingTurn('user-no-work', [
      {
        id: 'no-work-show',
        type: 'tool',
        callID: 'call-no-work-show',
        tool: 'show',
        state: {
          status: 'completed',
          input: { type: 'text', title: 'Lone Deliverable', content: 'body' },
          output: '',
          metadata: {},
        },
      },
      { id: 'no-work-final', type: 'text', text: 'Synthetic note under the card.' },
    ]);
    try {
      const markup = renderChat();
      expect(markup).not.toContain('>Worked');
      // Nothing to fold: the plain list, no accordion wrapper.
      expect(markup).not.toContain('group/work');
      expect(markup).toContain('Lone Deliverable');
      expect(markup).toContain('Synthetic note under the card.');
    } finally {
      fixtureMessages = baseFixtureMessages;
    }
  });

  test('a working turn streams every step as today, with no Worked row', () => {
    fixtureMessages = foldTurn('user-fixture');
    busy = true;
    try {
      const markup = renderChat();
      // Streaming text paints through ThrottledMarkdown, which is empty under
      // SSR, so the live view is pinned by its burst rows instead.
      expect(markup).toContain('group/burst');
      expect(markup).toContain('echo synthetic');
      expect(markup).toContain('echo again');
      expect(markup).toContain('Synthetic Deliverable');
      expect(markup).not.toContain('Worked for');
    } finally {
      busy = false;
      fixtureMessages = baseFixtureMessages;
    }
  });

  test('a system-notification-only turn renders the inline system indicator', () => {
    fixtureMessages = [
      {
        info: { id: 'user-goal', role: 'user', time: { created: 1 } },
        parts: [
          {
            id: 'goal-text',
            type: 'text',
            text: '<kortix_system type="goal-continue" source="runtime">[GOAL - ITERATION 2/5]</kortix_system>',
          },
        ],
      },
    ];
    try {
      const markup = renderChat();
      expect(markup).toContain('iteration 2/5');
      expect(markup).not.toContain('data-turn-pending');
    } finally {
      fixtureMessages = baseFixtureMessages;
    }
  });

  // Pin for the turn-outcome footer (KRTX-1622): the KRTX-355 session-chat
  // split moved the `TurnFooter` comment block but dropped its
  // `{!working && <TurnOutcomes …/>}` render, so the provider pipeline below
  // fed a context nothing read. Both cases render through the whole
  // SessionChat so the provider → anchor → footer path is the one under test.
  describe('turn-outcome footer', () => {
    test('a settled turn whose span contains this session’s change request renders its outcome card', () => {
      fixtureMessages = [
        userFixture('user-cr', 'open the synthetic change request'),
        {
          info: {
            id: 'assistant-cr',
            role: 'assistant',
            parentID: 'user-cr',
            agent: 'build',
            time: { created: 2000 },
          },
          parts: [],
        },
      ];
      const client = new QueryClient();
      seedSessionChangeRequests(client, [changeRequestFixture()]);
      try {
        const markup = renderChat(client);
        expect(markup).toContain('data-testid="turn-outcomes"');
        expect(markup).toContain('synthetic files reorder');
        expect(markup).toContain('Waiting for you');
      } finally {
        fixtureMessages = baseFixtureMessages;
      }
    });

    test('a turn still working renders no outcome card yet', () => {
      busy = true;
      const client = new QueryClient();
      seedSessionChangeRequests(client, [changeRequestFixture()]);
      try {
        // The change request postdates the only turn's start, so it anchors to
        // the working turn; the `!working` gate is what must hide it.
        expect(renderChat(client)).not.toContain('data-testid="turn-outcomes"');
      } finally {
        busy = false;
      }
    });
  });
});

// The unresolved-chip refusal (KRTX-1903) consumes `commandsResolved` — the bit
// that says the live command list has answered at least once. The composer
// cannot derive it from the `commands` array (that is `[]` both while the list
// loads and when it resolved empty), so this host wire must forward the RAW
// query state, from the same hook instance whose (filtered) list the composer
// consumes. A normalized `agentCommands || []` reads as resolved forever, and
// the refusal could never fire on this host.
describe('SessionChat command-list resolution wire', () => {
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

  test('a never-resolved list reaches the composer as unresolved; a resolved one does not', () => {
    agentCommandsData = undefined; // loading: a fresh mount, or a reset the composer cannot see
    try {
      renderChat();
      expect(composerProps?.commandsResolved).toBe(false);
      agentCommandsData = []; // resolved, and the agent has no commands
      renderChat();
      expect(composerProps?.commandsResolved).toBe(true);
    } finally {
      agentCommandsData = [];
    }
  });

  test('the wire follows the agent-scoped instance, not the agent-less one beside it', () => {
    // Two `useRuntimeCommands` instances live in this component: the agent-less
    // one (another consumer's list) and the agent-scoped one the composer eats.
    // They share one cache entry today, so only a test that pulls them apart
    // can pin that the resolution bit rides the instance that feeds `commands`.
    agentCommandsData = undefined;
    runtimeCommandsData = [{ name: 'resolved-elsewhere' }];
    try {
      renderChat();
      expect(composerProps?.commandsResolved).toBe(false);
    } finally {
      agentCommandsData = [];
      runtimeCommandsData = [];
    }
  });
});
