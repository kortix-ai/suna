import { SESSION_LOG_MINOR, SESSION_LOG_SCHEMA, sessionLogTurns, toolCallBlock, type SessionLogMessage, type SessionLogTurn, type ToolPart } from '@kortix/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { TooltipProvider } from '../../primitives/tooltip';
import { IntlTestProvider } from '../../test-utils/intl';
import '../tool/tools/register';
import { messageWorkerIds, ShowWork } from './show-work';
import { messageOnlySegments, SessionTurn } from './transcript';
import { TranscriptRowsContext, type TranscriptRows } from './transcript-rows';

// A space thread with `chat` on (`TranscriptRows.messagesOnly`): the thread shows
// the person's messages and the agent's words and deliverables, never its work.

function message(id: string, role: 'user' | 'assistant', blocks: SessionLogMessage['blocks'], extra: Partial<SessionLogMessage> = {}): SessionLogMessage {
  return {
    schema: SESSION_LOG_SCHEMA, v: SESSION_LOG_MINOR, message_id: id, thread_id: 'synthetic', seq: 1,
    role, kind: 'turn', status: 'complete', in_context: true, model: null, usage: null,
    finish: null, error: null, created_at: '2026-01-01T00:00:00Z', completed_at: '2026-01-01T00:00:30Z',
    producer: { harness: 'pi', harness_version: '1', adapter_version: '1' }, blocks, ...extra,
  };
}

function call(id: string, name: string, input: Record<string, unknown>, output: string): SessionLogMessage['blocks'][number] {
  return {
    type: 'tool_call', id, call_id: id, name, kind: 'other', input, status: 'complete',
    result: { content: [{ type: 'text', text: output }], is_error: false },
    started_at: '2026-01-01T00:00:01Z', ended_at: '2026-01-01T00:00:20Z',
  };
}

function turnOf(messages: SessionLogMessage[]): SessionLogTurn {
  const [turn] = sessionLogTurns({
    schema: SESSION_LOG_SCHEMA, v: SESSION_LOG_MINOR, thread_id: 'synthetic', parent_thread_id: null, spawned_by: null,
    agent: null, title: null, created_at: '', messages,
  });
  if (!turn) throw new Error('Missing synthetic turn');
  return turn;
}

const ROWS: TranscriptRows = {
  agent: 'Kortix',
  owner: { name: 'Thread Owner', email: 'owner@example.test', avatarUrl: null },
  unknownAuthor: 'Someone',
};

function render(turn: SessionLogTurn, rows: TranscriptRows, working = false): string {
  return renderToStaticMarkup(
    <IntlTestProvider locale="en" onError={() => {}}>
      <QueryClientProvider client={new QueryClient()}>
        <TooltipProvider>
          <TranscriptRowsContext.Provider value={rows}>
            <SessionTurn
              turn={turn} turnOutcome={{}} sessionId="synthetic" sessionStatus={undefined} isLast ownsPlan={false}
              permissions={[]} questions={[]} sessionWorking={working} isWorkingTurn={working}
              suppressBusyIndicator={false} awaitingUser={false} pending={false} isFirstTurn
              onPermissionReply={async () => {}} onRewind={() => {}} rewindDisabled
            />
          </TranscriptRowsContext.Provider>
        </TooltipProvider>
      </QueryClientProvider>
    </IntlTestProvider>,
  );
}

const rowCount = (html: string) => html.match(/data-slot="message-row"/g)?.length ?? 0;

describe('messages-only thread rows', () => {
  const worked = turnOf([
    message('prompt', 'user', [{ type: 'text', id: 'q', text: 'Summarize the synthetic report' }]),
    message('reply', 'assistant', [
      { type: 'reasoning', id: 'think', text: 'Synthetic private reasoning' },
      call('sh-1', 'bash', { command: 'cat synthetic-notes.txt' }, 'synthetic notes'),
      { type: 'text', id: 'interim', text: 'Synthetic interim narration' },
      call('show-1', 'show', { items: [{ type: 'file', path: '/workspace/synthetic-report.pdf', title: 'synthetic-report.pdf' }] }, ''),
      { type: 'text', id: 'answer', text: 'Synthetic final answer' },
    ], { reply_to: 'prompt' }),
  ]);

  test('a settled turn shows the prompt, the deliverable and the final answer, and no work', () => {
    const html = render(worked, { ...ROWS, messagesOnly: true });
    expect(html).toContain('Summarize the synthetic report');
    expect(html).toContain('Synthetic final answer');
    expect(html).toContain('synthetic-report.pdf');
    expect(html).not.toContain('group/work');
    expect(html).not.toContain('Worked');
    expect(html).not.toContain('cat synthetic-notes.txt');
    expect(html).not.toContain('Synthetic interim narration');
    expect(html).not.toContain('Synthetic private reasoning');
    expect(rowCount(html)).toBe(2);
  });

  test('without the mode the same turn folds its work behind the Worked row', () => {
    const html = render(worked, ROWS);
    expect(html.match(/group\/work/g)).toHaveLength(1);
    expect(html).toContain('Synthetic final answer');
  });

  test('a settled turn that said nothing draws no agent row', () => {
    const silent = turnOf([
      message('prompt', 'user', [{ type: 'text', id: 'q', text: 'Tidy the synthetic folder' }]),
      message('reply', 'assistant', [call('sh-1', 'bash', { command: 'rm synthetic.tmp' }, '')], { reply_to: 'prompt' }),
    ]);
    const html = render(silent, { ...ROWS, messagesOnly: true });
    expect(html).toContain('Tidy the synthetic folder');
    expect(html).not.toContain('rm synthetic.tmp');
    expect(rowCount(html)).toBe(1);
    expect(rowCount(render(silent, ROWS))).toBe(2);
  });

  test('a working turn shows one busy row and no tool rows', () => {
    const live = turnOf([
      message('prompt', 'user', [{ type: 'text', id: 'q', text: 'Check the synthetic build' }]),
      message('reply', 'assistant', [
        { ...call('sh-1', 'bash', { command: 'make synthetic' }, ''), status: 'running', result: undefined, ended_at: undefined } as SessionLogMessage['blocks'][number],
      ], { reply_to: 'prompt', status: 'streaming', completed_at: null }),
    ]);
    const html = render(live, { ...ROWS, messagesOnly: true }, true);
    expect(html).toContain('Check the synthetic build');
    expect(html).not.toContain('make synthetic');
    expect(rowCount(html)).toBe(2);
    // The busy row reads like a person typing, never "Thinking" or a tool phrase.
    expect(html).toContain('data-testid="typing-indicator"');
    expect(html).toContain('Kortix is typing…');
    expect(html).not.toContain('Thinking');
    expect(html).not.toContain('session-busy-indicator');
    // A working turn has no "Show work" yet.
    expect(html).not.toContain('data-slot="show-work"');
    // The control: without the mode the running call is a row.
    expect(render(live, ROWS, true)).toContain('make synthetic');
    expect(render(live, ROWS, true)).not.toContain('typing-indicator');
  });

  test('a settled message with work behind it carries a closed "Show work"', () => {
    const html = render(worked, { ...ROWS, messagesOnly: true });
    expect(html.match(/data-slot="show-work"/g)).toHaveLength(1);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('Show work');
    // Closed, the work is not mounted.
    expect(html).not.toContain('data-slot="show-work-content"');
    expect(html).not.toContain('cat synthetic-notes.txt');
    // The full session view has its own fold, no "Show work".
    expect(render(worked, ROWS)).not.toContain('data-slot="show-work"');
  });

  test('a message with nothing behind it carries no "Show work"', () => {
    const plain = turnOf([
      message('prompt', 'user', [{ type: 'text', id: 'q', text: 'Say hi' }]),
      message('reply', 'assistant', [{ type: 'text', id: 'answer', text: 'Synthetic hello' }], { reply_to: 'prompt' }),
    ]);
    const html = render(plain, { ...ROWS, messagesOnly: true });
    expect(html).toContain('Synthetic hello');
    expect(html).not.toContain('data-slot="show-work"');
  });

  test('a talk-only thread\'s message opens the worker it started, not its own hand-off rows', () => {
    const handoff = turnOf([
      message('prompt', 'user', [{ type: 'text', id: 'q', text: 'Find a synthetic flight' }]),
      message('reply', 'assistant', [
        agentCall('ag-1', 'ses_synthworker1'),
        { type: 'text', id: 'answer', text: 'On it.' },
      ], { reply_to: 'prompt' }),
    ]);
    const front = render(handoff, { ...ROWS, messagesOnly: true, front: true });
    expect(front).toContain('On it.');
    expect(front.match(/data-slot="show-work"/g)).toHaveLength(1);
    // The same turn in a plain thread opens its folded hand-off row instead: Show work still shows.
    expect(render(handoff, { ...ROWS, messagesOnly: true })).toContain('data-slot="show-work"');
    // A talk-only small-talk answer started no worker: nothing to open.
    const smallTalk = turnOf([
      message('prompt', 'user', [{ type: 'text', id: 'q', text: 'Hi' }]),
      message('reply', 'assistant', [{ type: 'text', id: 'answer', text: 'Hi there.' }], { reply_to: 'prompt' }),
    ]);
    expect(render(smallTalk, { ...ROWS, messagesOnly: true, front: true })).not.toContain('data-slot="show-work"');
  });

  test("a talk-only answer to a worker's report opens that worker; the report itself is no row", () => {
    const report = turnOf([
      message('prompt', 'user', [{
        type: 'text', id: 'q', synthetic: true,
        text: '<kortix_system type="session-report"><session-report><session-id>ses_synthworker1</session-id><status>COMPLETE</status><project>p</project><prompt>Find a synthetic flight</prompt><result><task_result>Synthetic flight found</task_result></result></session-report></kortix_system>',
      }]),
      message('reply', 'assistant', [{ type: 'text', id: 'answer', text: 'Found one for you.' }], { reply_to: 'prompt' }),
    ]);
    const html = render(report, { ...ROWS, messagesOnly: true, front: true });
    expect(html).toContain('Found one for you.');
    expect(html).not.toContain('Synthetic flight found');
    expect(rowCount(html)).toBe(1);
    expect(html.match(/data-slot="show-work"/g)).toHaveLength(1);
    // Outside a talk-only thread the same answer has no work of its own.
    expect(render(report, { ...ROWS, messagesOnly: true })).not.toContain('data-slot="show-work"');
  });
});

function agentCall(id: string, child: string): SessionLogMessage['blocks'][number] {
  return toolCallBlock({
    type: 'tool', id, tool: 'agent', callID: id,
    state: {
      status: 'completed', input: { subagent_type: 'mykortix', name: 'flight-search', description: 'Find a flight', prompt: 'Find a synthetic flight' },
      output: 'started', title: 'Find a flight', metadata: { sessionId: child, background: true }, time: { start: 1, end: 2 },
    },
  } as unknown as ToolPart);
}

describe('Show work', () => {
  test('opened, it draws the work and says "Hide work"', () => {
    const html = renderToStaticMarkup(
      <IntlTestProvider locale="en" onError={() => {}}>
        <ShowWork defaultOpen>
          <p>Synthetic work body</p>
        </ShowWork>
      </IntlTestProvider>,
    );
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('Hide work');
    expect(html).toContain('data-slot="show-work-content"');
    expect(html).toContain('Synthetic work body');
  });

  test('closed, it draws only the control, hidden until hover on a pointer screen', () => {
    const html = renderToStaticMarkup(
      <IntlTestProvider locale="en" onError={() => {}}>
        <ShowWork>
          <p>Synthetic work body</p>
        </ShowWork>
      </IntlTestProvider>,
    );
    expect(html).toContain('Show work');
    expect(html).toContain('md:opacity-0');
    expect(html).not.toContain('Synthetic work body');
  });

  test('a talk-only message opens every worker its turn started or answers, each once', () => {
    const blocks = [
      agentCall('ag-1', 'ses_synthworker1'),
      agentCall('ag-2', 'ses_synthworker2'),
      agentCall('ag-3', 'ses_synthworker1'),
      { type: 'text', id: 't', text: 'On it.' } as SessionLogMessage['blocks'][number],
    ];
    expect(messageWorkerIds(blocks, [])).toEqual(['ses_synthworker1', 'ses_synthworker2']);
    // A worker's run-end report names its session: the answer to it opens that worker.
    expect(messageWorkerIds([], ['ses_synthworker3', null, undefined, 'ses_synthworker3'])).toEqual(['ses_synthworker3']);
    expect(messageWorkerIds([{ type: 'text', id: 't', text: 'Hi.' } as SessionLogMessage['blocks'][number]], [])).toEqual([]);
  });

  test("another session's message is no row; the agent's answer to it is", () => {
    const peer = turnOf([
      message('prompt', 'user', [{
        type: 'text', id: 'q', synthetic: true,
        text: '[message from reviewer · session 3f2a1b9c · #m_synth]\n\nSynthetic peer text\n\n---\nfooter',
      }]),
      message('reply', 'assistant', [{ type: 'text', id: 'answer', text: 'Synthetic reply to the person' }], { reply_to: 'prompt' }),
    ]);
    const html = render(peer, { ...ROWS, messagesOnly: true });
    expect(html).not.toContain('Synthetic peer text');
    expect(html).not.toContain('reviewer');
    expect(html).toContain('Synthetic reply to the person');
    expect(rowCount(html)).toBe(1);
    expect(render(peer, ROWS)).toContain('reviewer');
  });

  test("an agent's post into the space thread (`kortix spaces post --thread`) is a row in a messages-only thread", () => {
    const post = turnOf([
      message('prompt', 'user', [{
        type: 'text', id: 'q', synthetic: true,
        text: '[message from launch-weather · session 3f2a1b9c · #m_synth · post in this space]\n\nTomorrow looks dry too.\n\n---\nfooter',
      }]),
    ]);
    const html = render(post, { ...ROWS, messagesOnly: true });
    expect(html).toContain('Tomorrow looks dry too.');
    expect(html).toContain('launch-weather');
    expect(html).not.toContain('footer');
    expect(rowCount(html)).toBe(1);
  });
});

describe('messages only: a blank text segment', () => {
  // The router writes an empty text before a hand-off. Drawn, it was an empty
  // element first in the message column, and the words after it took the gap.
  test('is not drawn; the words are', () => {
    const text = (id: string, value: string) => ({ kind: 'text' as const, block: { type: 'text', id, text: value } }) as never;
    for (const working of [false, true]) {
      const kept = messageOnlySegments([text('t1', '\n\n'), text('t2', 'On it.')], { working, permissions: [] });
      expect(kept.map((segment) => (segment as { block: { text: string } }).block.text)).toEqual(['On it.']);
    }
  });
});
