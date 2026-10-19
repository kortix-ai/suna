import { describe, expect, test } from 'bun:test';
import type { ClassifiedPart, SessionLogBlock, SessionLogMessage, SessionLogThread } from '@kortix/sdk';
import type { KortixSendError, UseSessionResult } from '@kortix/sdk/react';
import { renderToStaticMarkup } from 'react-dom/server';

import { UiProvider } from '../providers/ui-provider';
import { parseCommand, slashQuery } from './composer';
import { autoRecoveryOf } from './message-list';
import { MessageView } from './message-view';
import { ToolCall } from './tool-call';
import { SessionThread } from './session-thread';
import { sendFailureTitle } from './send-failure';
import {
  closeUnterminatedCodeFence,
  holdBackFenceOpener,
  holdBackTableHeader,
  streamingMarkdown,
} from './streaming-markdown';
import { userMessageParts } from './user-message-parts';

describe('holdBackTableHeader', () => {
  test('holds back a header row until its separator arrives', () => {
    expect(holdBackTableHeader('Intro\n\n| Name | Age |')).toBe('Intro\n');
    expect(holdBackTableHeader('Intro\n\n| Name | Age |\n')).toBe('Intro\n');
    expect(holdBackTableHeader('Intro\n\n| Name')).toBe('Intro\n');
  });

  test('holds back a header and a half-written separator', () => {
    expect(holdBackTableHeader('Intro\n\n| Name | Age |\n|---')).toBe('Intro\n');
    expect(holdBackTableHeader('Intro\n\n| Name | Age |\n| --- |')).toBe('Intro\n');
  });

  test('shows the table once the separator is complete; leaves body rows and plain text alone', () => {
    const table = 'Intro\n\n| Name | Age |\n| --- | --- |';
    expect(holdBackTableHeader(table)).toBe(table);
    const rows = 'Intro\n\n| Name | Age |\n|---|---|\n| Ada | 36';
    expect(holdBackTableHeader(rows)).toBe(rows);
    expect(holdBackTableHeader('no table here')).toBe('no table here');
  });
});

describe('holdBackFenceOpener', () => {
  test('holds back a fence opener whose language tag is still arriving', () => {
    expect(holdBackFenceOpener('Intro\n\n```openu')).toBe('Intro\n\n');
    expect(holdBackFenceOpener('Intro\n\n```')).toBe('Intro\n\n');
  });

  test('shows the fence once its line is complete, and never holds a closing fence', () => {
    expect(holdBackFenceOpener('Intro\n\n```ts\n')).toBe('Intro\n\n```ts\n');
    const closing = 'Intro\n\n```ts\nconst a = 1\n```';
    expect(holdBackFenceOpener(closing)).toBe(closing);
  });
});

describe('closeUnterminatedCodeFence', () => {
  test('closes an open fence and leaves a closed one alone', () => {
    expect(closeUnterminatedCodeFence('```ts\nconst a = 1')).toBe('```ts\nconst a = 1\n\n```');
    const closed = '```ts\nconst a = 1\n```';
    expect(closeUnterminatedCodeFence(closed)).toBe(closed);
    expect(closeUnterminatedCodeFence('')).toBe('');
  });

  test('streamingMarkdown applies all three in order', () => {
    expect(streamingMarkdown('Intro\n\n| A | B |')).toBe('Intro\n');
    expect(streamingMarkdown('```ts\nconst a = 1')).toBe('```ts\nconst a = 1\n\n```');
  });
});

describe('userMessageParts', () => {
  test('joins text parts into plain text and keeps every other part', () => {
    const parts = [
      { kind: 'text', id: 't1', text: ' Hello ', synthetic: false },
      { kind: 'file', id: 'f1', url: 'kortix-attachment://p/s/a', filename: 'a.png', mime: 'image/png' },
      { kind: 'text', id: 't2', text: 'world ', synthetic: false },
    ] as unknown as ClassifiedPart[];
    const out = userMessageParts(parts);
    expect(out.text).toBe('Hello \nworld');
    expect(out.parts.map((p) => p.kind)).toEqual(['file']);
  });
});

describe('sendFailureTitle', () => {
  const err = (over: Partial<KortixSendError>) => ({ message: 'x', ...over }) as KortixSendError;
  test('names each kind of send failure', () => {
    expect(sendFailureTitle(err({ kind: 'billing' }))).toBe('This session is out of credit');
    expect(sendFailureTitle(err({ kind: 'runtime-not-ready' }))).toBe('The runtime is still starting');
    expect(sendFailureTitle(err({ kind: 'runtime-error' }))).toBe('The agent could not run that');
    expect(
      sendFailureTitle(err({ kind: 'runtime-error', gateway: { provider: 'openrouter' } } as Partial<KortixSendError>)),
    ).toBe('The openrouter model failed');
    expect(sendFailureTitle(err({ kind: 'unknown' } as unknown as Partial<KortixSendError>))).toBe(
      'Your message was not sent',
    );
  });
});

describe('composer commands', () => {
  const commands = [{ name: 'review', description: 'Review the diff' }];
  test('slashQuery reads a bare /token only', () => {
    expect(slashQuery('/Rev')).toBe('rev');
    expect(slashQuery('/')).toBe('');
    expect(slashQuery('/review now')).toBeNull();
    expect(slashQuery('hello')).toBeNull();
  });
  test('parseCommand runs only a known command and trims its args', () => {
    expect(parseCommand('/review  src/a.ts ', commands)).toEqual({ name: 'review', args: 'src/a.ts' });
    expect(parseCommand('/review', commands)).toEqual({ name: 'review', args: '' });
    expect(parseCommand('/unknown x', commands)).toBeNull();
    expect(parseCommand('review', commands)).toBeNull();
  });
});

function message(
  role: 'user' | 'assistant',
  blocks: SessionLogBlock[],
  over: Partial<SessionLogMessage> = {},
): SessionLogMessage {
  return {
    schema: 'kortix.session',
    v: 2,
    message_id: `m-${role}`,
    thread_id: 't',
    seq: 1,
    role,
    kind: 'turn',
    status: 'complete',
    in_context: true,
    model: null,
    usage: null,
    finish: null,
    error: null,
    created_at: '2026-01-01T00:00:00.000Z',
    completed_at: null,
    producer: { harness: 'pi', harness_version: '1', adapter_version: '1' },
    blocks,
    ...over,
  } as unknown as SessionLogMessage;
}

describe('MessageView', () => {
  test('renders assistant text as markdown', () => {
    const html = renderToStaticMarkup(
      <MessageView message={message('assistant', [{ type: 'text', id: 't1', text: 'Hello **world**' }])} />,
    );
    expect(html).toContain('data-message-role="assistant"');
    expect(html).toContain('<strong class="font-semibold">world</strong>');
  });

  test('renders a user turn as an end-aligned bubble', () => {
    const html = renderToStaticMarkup(
      <MessageView message={message('user', [{ type: 'text', id: 't1', text: 'Fix the bug' }])} />,
    );
    expect(html).toContain('data-message-role="user"');
    expect(html).toContain('data-slot="bubble"');
    expect(html).toContain('Fix the bug');
  });

  const shell: SessionLogBlock = {
    type: 'tool_call',
    id: 'c1',
    call_id: 'call_c1',
    name: 'bash',
    kind: 'shell',
    input: { command: 'ls -la' },
    status: 'complete',
    result: { content: [{ type: 'text', text: 'ok' }], is_error: false },
  };

  test('renders a tool call as the default card', () => {
    const html = renderToStaticMarkup(<MessageView message={message('assistant', [shell])} />);
    expect(html).toContain('data-slot="tool-call"');
    expect(html).toContain('data-tool-status="done"');
    expect(html).toContain('ls -la');
  });

  test('renderTool replaces the tool card; undefined keeps the default', () => {
    const custom = renderToStaticMarkup(
      <MessageView message={message('assistant', [shell])} renderTool={(t) => <i>custom {t.name}</i>} />,
    );
    expect(custom).toContain('<i>custom bash</i>');
    expect(custom).not.toContain('data-slot="tool-call"');
    const kept = renderToStaticMarkup(
      <MessageView message={message('assistant', [shell])} renderTool={() => undefined} />,
    );
    expect(kept).toContain('data-slot="tool-call"');
  });
});

function fakeSession(over: Record<string, unknown> = {}): UseSessionResult {
  return {
    projectId: 'p',
    sessionId: 's',
    isLoading: false,
    hasPending: false,
    pending: null,
    isBusy: false,
    canStop: true,
    permissions: [],
    questions: [],
    runtimePhase: 'ready',
    switched: true,
    sendError: null,
    commands: [],
    models: [],
    agents: [],
    picks: { model: null, agent: null, setModel() {}, setAgent() {} },
    defaultAgent: null,
    send() {},
    cancel() {},
    runCommand() {},
    retry() {},
    ...over,
  } as unknown as UseSessionResult;
}

describe('SessionThread', () => {
  test('advertises "/ for commands" only when the session has a command', () => {
    const none = renderToStaticMarkup(<SessionThread session={fakeSession()} />);
    expect(none).toContain('placeholder="Message the agent…"');
    expect(none).not.toContain('/ for commands');
    const some = renderToStaticMarkup(
      <SessionThread session={fakeSession({ commands: [{ name: 'review', description: null }] })} />,
    );
    expect(some).toContain('(/ for commands)');
  });

  test('renders the host strings from UiProvider, English for keys it does not pass', () => {
    const html = renderToStaticMarkup(
      <UiProvider strings={{ chat: { send: 'Senden', placeholder: 'Nachricht…' } }}>
        <SessionThread session={fakeSession()} />
      </UiProvider>,
    );
    expect(html).toContain('aria-label="Senden"');
    expect(html).toContain('placeholder="Nachricht…"');
    expect(html).toContain('Send a message to get the agent working.');
  });

  test('renders the empty state, busy marker, send error and composer from one session result', () => {
    const session = {
      projectId: 'p',
      sessionId: 's',
      isLoading: false,
      hasPending: false,
      pending: null,
      isBusy: true,
      canStop: true,
      permissions: [],
      questions: [],
      runtimePhase: 'ready',
      switched: true,
      sendError: { kind: 'billing', message: 'Top up credits' },
      commands: [],
      models: [],
      agents: [],
      picks: { model: null, agent: null, setModel() {}, setAgent() {} },
      defaultAgent: null,
      send() {},
      cancel() {},
      runCommand() {},
      retry() {},
    } as unknown as UseSessionResult;
    const html = renderToStaticMarkup(<SessionThread session={session} emptyState={<p>Nothing yet</p>} />);
    expect(html).toContain('Nothing yet');
    expect(html).toContain('data-slot="busy-marker"');
    expect(html).toContain('This session is out of credit');
    expect(html).toContain('Top up credits');
    expect(html).toContain('aria-label="Stop"');
  });
});

describe('auto-recovery chain (KRTX-2597)', () => {
  let seq = 0;
  const at = () => new Date(1_700_000_000_000 + ++seq * 1000).toISOString();
  const person = (id: string, text: string) =>
    message('user', [{ type: 'text', id: `${id}-t`, text }], { message_id: id, created_at: at() });
  const recoveryPrompt = (id: string) =>
    message('user', [{ type: 'text', id: `${id}-t`, text: '[auto-recovery] Your previous response was interrupted.', synthetic: true } as SessionLogBlock], {
      message_id: id,
      created_at: at(),
    });
  const failed = (id: string, to: string) =>
    message('assistant', [], {
      message_id: id,
      created_at: at(),
      reply_to: to,
      status: 'error',
      in_context: false,
      hidden_reason: 'failed_attempt',
      error: { code: 'model_unavailable', message: 'kimi-k3 is temporarily unavailable.' },
    } as Partial<SessionLogMessage>);
  const ok = (id: string, to: string) =>
    message('assistant', [{ type: 'text', id: `${id}-t`, text: 'deploy done' }], { message_id: id, created_at: at(), reply_to: to } as Partial<SessionLogMessage>);
  const thread = (messages: SessionLogMessage[]) =>
    ({ schema: 'kortix.session', v: 2, thread_id: 't', parent_thread_id: null, spawned_by: null, agent: null, title: null, created_at: '', messages }) as unknown as SessionLogThread;

  test('hides the [auto-recovery] prompts and the continued failures when the retry succeeds', () => {
    const r = autoRecoveryOf(thread([person('u1', 'run the deploy'), failed('a1', 'u1'), recoveryPrompt('u2'), failed('a2', 'u2'), recoveryPrompt('u3'), ok('a3', 'u3')]));
    expect([...r.hidden].sort()).toEqual(['u2', 'u3']);
    expect([...r.quiet].sort()).toEqual(['a1', 'a2']);
    expect(r.retries.size).toBe(0);
  });

  test('a chain that ends in failure keeps ONE error row, annotated with the retry count', () => {
    const msgs = [person('u1', 'run the deploy'), failed('a1', 'u1'), recoveryPrompt('u2'), failed('a2', 'u2')];
    const r = autoRecoveryOf(thread(msgs));
    expect([...r.hidden]).toEqual(['u2']);
    expect([...r.quiet]).toEqual(['a1']);
    expect([...r.retries]).toEqual([['a2', 1]]);
    const quiet = renderToStaticMarkup(<MessageView message={msgs[1]!} hideError={r.quiet.has('a1')} />);
    expect(quiet).toBe('');
    const last = renderToStaticMarkup(<MessageView message={msgs[3]!} autoRetries={r.retries.get('a2')} />);
    expect(last).toContain('kimi-k3 is temporarily unavailable.');
    expect(last).toContain('Retried automatically once before this failure.');
  });

  test('a plain conversation is untouched', () => {
    const r = autoRecoveryOf(thread([person('u1', 'hi'), failed('a1', 'u1'), person('u2', 'again'), ok('a2', 'u2')]));
    expect(r.hidden.size + r.quiet.size + r.retries.size).toBe(0);
    expect(autoRecoveryOf(null).hidden.size).toBe(0);
  });
});

describe('ToolCall header', () => {
  const call = (command: string): SessionLogBlock => ({
    type: 'tool_call',
    id: 'c2',
    call_id: 'call_c2',
    name: 'bash',
    kind: 'shell',
    input: { command, description: command },
    status: 'complete',
    result: { content: [{ type: 'text', text: 'ok' }], is_error: false },
  } as SessionLogBlock);

  test('the title truncates and the status never shrinks, so a long title stays inside the card', () => {
    const long = `sed -i 's/a/b/g' ${'very/long/path/'.repeat(20)}file.ts`;
    const html = renderToStaticMarkup(<MessageView message={message('assistant', [call(long)])} />);
    expect(html).toMatch(/<span class="text-foreground min-w-0 truncate text-xs font-medium">/);
    expect(html).toContain('class="ml-auto flex shrink-0 items-center gap-1.5"');
    expect(html).not.toContain('shrink-0 text-xs font-medium');
  });

  test('a title that equals the summary prints once', () => {
    const tool = { name: 'bash', kind: 'shell', title: 'ls -la .', status: 'done', input: { command: 'ls -la .' } } as never;
    const html = renderToStaticMarkup(<ToolCall tool={tool} />);
    expect(html.match(/ls -la \./g)?.length).toBe(1); // collapsed: the header only
    expect(html).not.toContain('truncate font-mono text-xs">ls -la .');
  });
});
