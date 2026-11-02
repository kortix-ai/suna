import { SESSION_LOG_MINOR, SESSION_LOG_SCHEMA, sessionLogOfV1Rows, sessionLogTurns, type SessionLogMessage } from '@kortix/sdk';
import { peerMessagePromptText } from '@kortix/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, test } from 'bun:test';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { TooltipProvider } from '../../primitives/tooltip';
import { IntlTestProvider } from '../../test-utils/intl';
import '../tool/tools/register';
import { SessionTurn } from '../thread/transcript';
import { NoticeBatchGroup } from './notice-batch-group';
import { parseNoticeBatch, parseSubagentNotice } from './subagent-notice';
import { UserMessage } from './user-message';

// Synthetic values only. The texts are what `subagentNoticeText`
// (apps/api/src/projects/subagent-notice.ts) and `firePeerIdleNotices`
// (apps/api/src/projects/peer-messages/service.ts) write, joined as
// `session-notice-batch.ts` joins them: a blank line between two notices.

const id = (n: number) => `0b7c2f1e-0000-4000-8000-${String(n).padStart(12, '0')}`;

function subagent(n: number, opts: { status?: string; report?: string; teammate?: { handle: string; tasks: string | null } } = {}): string {
  const status = opts.status ?? 'completed';
  const report = opts.report ?? `Report ${n} is ready.\nIt has a second line.`;
  const body = status === 'completed' ? `<task_result>\n${report}\n</task_result>` : `<task_error>\nThe subagent failed.\n</task_error>`;
  const teammate = opts.teammate;
  return [
    teammate
      ? `Your teammate ${teammate.handle} finished its turn and is idle. This message is from the platform, not from the user.`
      : 'A background subagent you started has finished. This message is from the platform, not from the user.',
    `task_id: ${id(n)}`,
    `status: ${status}`,
    '',
    '<kortix_system type="session-report" source="subagent">',
    '<session-report>',
    `<session-id>${id(n)}</session-id>`,
    `<status>${status === 'completed' ? 'COMPLETE' : 'FAILED'}</status>`,
    '<project>writer</project>',
    `<prompt>Task ${n} (@writer subagent)</prompt>`,
    `<result>\n${body}\n</result>`,
    '</session-report>',
    '</kortix_system>',
    ...(teammate ? ['', teammate.tasks ? `Tasks ${teammate.handle} still owns: ${teammate.tasks}.` : `${teammate.handle} owns no unfinished task.`] : []),
    '',
    `Continue your task with this result. To send this subagent a follow-up, call \`agent\` with task_id ${id(n)}.`,
  ].join('\n');
}

const peerIdle = (handle: string, answer: string | null) =>
  peerMessagePromptText({
    kind: 'idle_notice',
    from: handle,
    fromShortId: '3f2a1b9c',
    messageId: `m_${handle}`,
    summary: null,
    text: `${handle} finished its turn and is idle.${answer ? `\n\nIts last answer: ${answer}` : ''}`,
  });

const batch = (...notices: string[]) => notices.join('\n\n');

let intlErrors: unknown[] = [];
function wrap(node: ReactNode) {
  return (
    <IntlTestProvider locale="en" fallback={false} onError={(error) => intlErrors.push(error)}>
      <QueryClientProvider client={new QueryClient()}>
        <TooltipProvider>{node}</TooltipProvider>
      </QueryClientProvider>
    </IntlTestProvider>
  );
}
function render(node: ReactNode) {
  intlErrors = [];
  const html = renderToStaticMarkup(wrap(node));
  expect(intlErrors).toEqual([]);
  return html;
}
const textOf = (html: string) =>
  html.replace(/<[^>]*>/g, '').replaceAll('&#x27;', "'").replaceAll('&quot;', '"').replaceAll('&amp;', '&');

describe('parseNoticeBatch', () => {
  test('two subagent notices are two items, each with its own child and result', () => {
    const items = parseNoticeBatch(batch(subagent(1), subagent(2, { status: 'error' })))!;
    expect(items.map((item) => item.kind)).toEqual(['subagent', 'subagent']);
    const [first, second] = items as Array<{ kind: 'subagent'; notice: ReturnType<typeof parseSubagentNotice> & object }>;
    expect(first!.notice).toMatchObject({ sessionId: id(1), status: 'completed', excerpt: 'Report 1 is ready.' });
    // `error` is the API's word for a turn that ended on an error: it reads as a failure.
    expect(second!.notice).toMatchObject({ sessionId: id(2), status: 'failed', result: 'The subagent failed.' });
  });

  test('a subagent, a teammate and a peer idle notice keep their order and kinds', () => {
    const items = parseNoticeBatch(
      batch(subagent(1), subagent(2, { teammate: { handle: 'reviewer', tasks: '#3 Write the fix (in progress); #4 Test it (pending)' } }), peerIdle('archivist', 'All 12 files indexed.')),
    )!;
    expect(items.map((item) => item.kind)).toEqual(['subagent', 'teammate', 'peer_idle']);
    expect(items[1]).toMatchObject({
      kind: 'teammate',
      notice: { kind: 'teammate', handle: 'reviewer', sessionId: id(2), ownedTasks: '#3 Write the fix (in progress); #4 Test it (pending)' },
    });
    expect(items[2]).toMatchObject({ kind: 'peer_idle', info: { kind: 'idle_notice', from: 'archivist' } });
  });

  test('a teammate that owns no task carries none', () => {
    const items = parseNoticeBatch(batch(subagent(1, { teammate: { handle: 'reviewer', tasks: null } }), subagent(2)))!;
    expect(items[0]).toMatchObject({ kind: 'teammate', notice: { handle: 'reviewer', ownedTasks: null } });
  });

  test('a peer idle notice first is one item of the batch, not a message that swallows the rest', () => {
    const items = parseNoticeBatch(batch(peerIdle('archivist', 'Done.'), subagent(1), peerIdle('scout', null)))!;
    expect(items.map((item) => item.kind)).toEqual(['peer_idle', 'subagent', 'peer_idle']);
    const first = items[0] as { kind: 'peer_idle'; info: { text: string } };
    expect(first.info.text).not.toContain('A background subagent');
  });

  test('20 notices, the most one prompt carries, parse; more is not a batch the API wrote', () => {
    const twenty = Array.from({ length: 20 }, (_, n) => (n % 3 === 2 ? peerIdle(`peer${n}`, `answer ${n}`) : subagent(n + 1)));
    expect(parseNoticeBatch(batch(...twenty))).toHaveLength(20);
    expect(parseNoticeBatch(batch(...twenty, subagent(99)))).toBeNull();
  });

  test('a single notice is one item, and parseSubagentNotice reads it as before', () => {
    const one = subagent(7);
    expect(parseNoticeBatch(one)).toHaveLength(1);
    expect(parseSubagentNotice(one)).toMatchObject({ kind: 'subagent', sessionId: id(7), title: 'Task 7', excerpt: 'Report 7 is ready.', ownedTasks: null });
  });

  test('anything else is not a batch: a typed prompt, a peer message, a notice with text before it', () => {
    expect(parseNoticeBatch('Draft the launch post')).toBeNull();
    expect(
      parseNoticeBatch(peerMessagePromptText({ kind: 'message', from: 'lead', fromShortId: '3f2a1b9c', messageId: 'm_1', summary: null, text: 'Hi' })),
    ).toBeNull();
    expect(parseNoticeBatch(`Please read this.\n\n${subagent(1)}`)).toBeNull();
  });

  test('a notice line quoted inside a report does not split it', () => {
    const quoted = subagent(1, { report: 'Here is what it said:\nA background subagent you started has finished. (quoted)' });
    expect(parseNoticeBatch(batch(quoted, subagent(2)))).toHaveLength(2);
  });
});

describe('NoticeBatchGroup', () => {
  test('one header with the count, then one compact row per notice', () => {
    const items = parseNoticeBatch(
      batch(subagent(1), subagent(2, { teammate: { handle: 'reviewer', tasks: '#3 Write the fix (in progress)' } }), peerIdle('archivist', 'All 12 files indexed.')),
    )!;
    const html = render(<NoticeBatchGroup items={items} />);
    const text = textOf(html);
    expect(html).toContain('data-testid="notice-batch"');
    expect(html).toContain('data-notice-count="3"');
    expect(text).toContain('3 agents finished');
    expect(html.match(/data-testid="subagent-notice"/g)).toHaveLength(2);
    expect(html.match(/data-testid="peer-message-turn"/g)).toHaveLength(1);
    expect(text).toContain('Task 1 finished');
    expect(text).toContain('reviewer finished');
    expect(text).toContain('Still owns #3 Write the fix (in progress)');
    // The peer idle row previews its last answer, not the line that repeats the headline.
    expect(text).toContain('@archivist finished');
    expect(text).toContain('All 12 files indexed.');
    expect(text).not.toContain('finished its turn and is idle');
  });

  test('one notice counts as one agent', () => {
    const html = render(<NoticeBatchGroup items={parseNoticeBatch(batch(subagent(1), subagent(2)))!.slice(0, 1)} />);
    expect(textOf(html)).toContain('1 agent finished');
  });
});

describe('in the thread', () => {
  type V1Row = Parameters<typeof sessionLogOfV1Rows>[2][number];
  const logOf = (text: string) =>
    sessionLogOfV1Rows('session-1', 'ses_runtime', [
      { info: { id: 'm1', role: 'user' }, parts: [{ id: 'p1', messageID: 'm1', type: 'text', text }] } as V1Row,
    ]).threads[0]!.messages[0]!;

  function message(mid: string, role: 'user' | 'assistant', text: string, extra: Partial<SessionLogMessage> = {}): SessionLogMessage {
    return {
      schema: SESSION_LOG_SCHEMA, v: SESSION_LOG_MINOR, message_id: mid, thread_id: 'synthetic', seq: 1,
      role, kind: 'turn', status: 'complete', in_context: true, model: null, usage: null,
      finish: null, error: null, created_at: '2026-01-01T00:00:00Z', completed_at: '2026-01-01T00:00:30Z',
      producer: { harness: 'pi', harness_version: '1', adapter_version: '1' }, blocks: [{ type: 'text', id: `${mid}-t`, text }], ...extra,
    };
  }
  const turnHtml = (prompt: string) => {
    const turns = sessionLogTurns({
      schema: SESSION_LOG_SCHEMA, v: SESSION_LOG_MINOR, thread_id: 'synthetic', parent_thread_id: null, spawned_by: null,
      agent: null, title: null, created_at: '', messages: [message('notice', 'user', prompt), message('reply', 'assistant', 'Both are done.', { reply_to: 'notice' })],
    });
    return render(
      <SessionTurn
        turn={turns[0]!} turnOutcome={{}} sessionId="synthetic" sessionStatus={undefined} isLast ownsPlan={false}
        permissions={[]} questions={[]} sessionWorking={false} isWorkingTurn={false}
        suppressBusyIndicator={false} awaitingUser={false} pending={false} isFirstTurn
        onPermissionReply={async () => {}} onRewind={() => {}} rewindDisabled
      />,
    );
  };

  test('a batch turn draws the group, not one row per first notice or a bubble', () => {
    const html = turnHtml(batch(subagent(1), subagent(2)));
    expect(html.match(/data-testid="notice-batch"/g)).toHaveLength(1);
    expect(textOf(html)).toContain('2 agents finished');
    expect(textOf(html)).not.toContain('A background subagent you started has finished');
  });

  test('a batch of peer idle notices only (no session report) is a group too', () => {
    const html = turnHtml(batch(peerIdle('archivist', 'Indexed.'), peerIdle('scout', 'Mapped.')));
    expect(html.match(/data-testid="notice-batch"/g)).toHaveLength(1);
    expect(html.match(/data-testid="peer-message-turn"/g)).toHaveLength(2);
    expect(textOf(html)).toContain('2 agents finished');
  });

  test('a single notice still draws today’s row, and a single peer idle notice today’s peer row', () => {
    const one = turnHtml(subagent(1));
    expect(one).not.toContain('data-testid="notice-batch"');
    expect(one.match(/data-testid="subagent-notice"/g)).toHaveLength(1);
    const peer = render(<UserMessage message={logOf(peerIdle('archivist', 'Indexed.'))} sessionId="session-1" ownsPlan={false} />);
    expect(peer).not.toContain('data-testid="notice-batch"');
    expect(peer).toContain('data-peer-kind="idle_notice"');
  });

  test('UserMessage draws a batch whose first notice is a peer idle notice as the group', () => {
    const html = render(<UserMessage message={logOf(batch(peerIdle('archivist', 'Indexed.'), subagent(1)))} sessionId="session-1" ownsPlan={false} />);
    expect(html).toContain('data-testid="notice-batch"');
    expect(html.match(/data-testid="peer-message-turn"/g)).toHaveLength(1);
    expect(html).toContain('data-testid="subagent-notice"');
  });
});
