import { SESSION_LOG_MINOR, SESSION_LOG_SCHEMA, sessionLogTurns, type SessionLogMessage, type SessionLogTurn } from '@kortix/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { TooltipProvider } from '../../primitives/tooltip';
import { IntlTestProvider } from '../../test-utils/intl';
import '../tool/tools/register';
import { SessionTurn } from './transcript';
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
    // The control: without the mode the running call is a row.
    expect(render(live, ROWS, true)).toContain('make synthetic');
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
});
