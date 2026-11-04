import { SESSION_LOG_MINOR, SESSION_LOG_SCHEMA, sessionLogTurns, type SessionLogMessage } from '@kortix/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, test } from 'bun:test';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create } from 'react-test-renderer';
import { Window } from 'happy-dom';

import { TooltipProvider } from '../../primitives/tooltip';
import { IntlTestProvider } from '../../test-utils/intl';
import '../tool/tools/register';
import { SessionTurn } from '../thread/transcript';
import { parseSubagentNotice } from './subagent-notice';
import { SubagentNoticeRow } from './subagent-notice-row';
import { AgentActivateContext } from '../tool/shared/infrastructure-contexts';

// Synthetic values only. The notice is the text `subagentNoticeText` in
// apps/api/src/projects/subagent-notice.ts writes.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CHILD = '0b7c2f1e-0000-4000-8000-000000000001';

function noticeText(status: 'completed' | 'failed' | 'stopped', report: string, error?: string): string {
  const body =
    status === 'completed'
      ? `<task_result>\n${report}\n</task_result>`
      : `<task_error>\n${error ?? 'The subagent failed.'}\n</task_error>${report ? `\n<task_result>\n${report}\n</task_result>` : ''}`;
  return [
    'A background subagent you started has finished. This message is from the platform, not from the user.',
    `task_id: ${CHILD}`,
    `status: ${status}`,
    '',
    '<kortix_system type="session-report" source="subagent">',
    '<session-report>',
    `<session-id>${CHILD}</session-id>`,
    `<status>${status === 'completed' ? 'COMPLETE' : 'FAILED'}</status>`,
    '<project>writer</project>',
    '<prompt>Draft the launch post (@writer subagent)</prompt>',
    `<result>\n${body}\n</result>`,
    '</session-report>',
    '</kortix_system>',
    '',
    `Continue your task with this result. To send this subagent a follow-up, call \`agent\` with task_id ${CHILD}.`,
  ].join('\n');
}

const REPORT = '## Draft ready\n\nThe post is in posts/launch.md.\nIt runs 600 words.';

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

describe('SubagentNoticeRow', () => {
  test('a workflow result returned as JSON reads as its document: no braces, no escapes, a real first line', () => {
    const doc = '# Growth plan\n\nOne pack. Ten pilots.\n\n## Priorities\n\n1. **Prove it.**';
    const html = render(<SubagentNoticeRow notice={parseSubagentNotice(noticeText('completed', JSON.stringify({ strategy: doc })))!} />);
    const text = textOf(html);
    expect(text).toContain('Growth plan');
    expect(text).not.toContain('"strategy"');
    expect(text).not.toContain('\\n');
    expect(html).toContain('title="Growth plan"');
  });

  // The row is product chrome: it draws its state with the glyph every tool row
  // uses, never an emoji. Emoji status labels belong to the agent's own words
  // (brand D31), and the reply under the row often starts with one.
  test('a finished child is one agent row: its face, its name, the report\'s first line, Finished; a button, never a fold', () => {
    const notice = parseSubagentNotice(noticeText('completed', REPORT))!;
    const html = render(<SubagentNoticeRow notice={notice} defaultOpen />);
    expect(html).toContain('data-testid="subagent-notice"');
    expect(html).toContain('data-notice-status="completed"');
    expect(html).toContain('data-tone="agent"');
    expect(html).toContain('data-agent-status="done"');
    expect(html).toContain('role="button"');
    expect(html).not.toContain('aria-expanded');
    expect(html).not.toContain('data-testid="notice-result"');
    const text = textOf(html);
    expect(text).not.toContain('✅');
    expect(text).toContain('Finished');
    expect(text).toContain('Draft ready');
    expect(text).not.toContain('600 words');
    expect(html).not.toContain('text-kortix-red');
  });

  test('a workflow report reads without its result tag: the row shows its real first line', () => {
    const report = '<workflow_result>\nCompleted the full strategy.\n\nThe plan has three bets.\n</workflow_result>';
    const text = textOf(render(<SubagentNoticeRow notice={parseSubagentNotice(noticeText('completed', report))!} defaultOpen />));
    expect(text).toContain('Completed the full strategy.');
    expect(text).not.toContain('workflow_result');
    expect(text).not.toContain('workflowresult');
  });

  test('a first line that only says it is done does not stand in for the subtitle', () => {
    const html = render(<SubagentNoticeRow notice={parseSubagentNotice(noticeText('completed', 'Done.\nWrote poem.md.'))!} />);
    expect(html).toContain('data-agent-status="done"');
    expect(textOf(html)).not.toContain('Done.');
  });

  test('a failed child reads Didn’t finish, no red word; a click opens it beside the chat with its raw error', async () => {
    const notice = parseSubagentNotice(noticeText('failed', '', 'The model ran out of room.'))!;
    const html = render(<SubagentNoticeRow notice={notice} />);
    expect(html).toContain('data-notice-status="failed"');
    expect(html).toContain('data-agent-status="failed"');
    const text = textOf(html);
    expect(text).toContain('Didn’t finish');
    expect(text).not.toContain('The model ran out of room.');
    expect(text).not.toContain('⚠️');
    expect(html).not.toContain('text-kortix-red');

    const opened: unknown[] = [];
    let tree: ReturnType<typeof create> | undefined;
    // Mounted, the row's hooks read `window`: a DOM for this one render.
    const dom = new Window();
    Object.defineProperty(globalThis, 'window', { value: dom, configurable: true, writable: true });
    await act(async () => {
      tree = create(wrap(<AgentActivateContext.Provider value={(agent) => void opened.push(agent)}><SubagentNoticeRow notice={notice} /></AgentActivateContext.Provider>));
    });
    const row = tree!.root.find((node) => node.props['data-component'] === 'tool-trigger');
    await act(async () => row.props.onClick({ stopPropagation() {} }));
    expect(opened).toEqual([expect.objectContaining({ sessionId: CHILD, failure: 'The model ran out of room.' })]);
    await act(async () => tree!.unmount());
    Reflect.deleteProperty(globalThis, 'window');
    dom.happyDOM.abort();
  });

  test('a stopped child reads Stopped, never failed or done', () => {
    const html = render(<SubagentNoticeRow notice={parseSubagentNotice(noticeText('stopped', '', 'The subagent was stopped.'))!} />);
    expect(html).toContain('data-agent-status="stopped"');
    expect(textOf(html)).toContain('Stopped');
  });
});

describe('in the transcript', () => {
  function message(id: string, role: 'user' | 'assistant', blocks: SessionLogMessage['blocks'], extra: Partial<SessionLogMessage> = {}): SessionLogMessage {
    return {
      schema: SESSION_LOG_SCHEMA, v: SESSION_LOG_MINOR, message_id: id, thread_id: 'synthetic', seq: 1,
      role, kind: 'turn', status: 'complete', in_context: true, model: null, usage: null,
      finish: null, error: null, created_at: '2026-01-01T00:00:00Z', completed_at: '2026-01-01T00:00:30Z',
      producer: { harness: 'pi', harness_version: '1', adapter_version: '1' }, blocks, ...extra,
    };
  }

  test('a notice turn draws one agent row, not the "Worker complete" card or a user bubble', () => {
    const turns = sessionLogTurns({
      schema: SESSION_LOG_SCHEMA, v: SESSION_LOG_MINOR, thread_id: 'synthetic', parent_thread_id: null, spawned_by: null,
      agent: null, title: null, created_at: '', messages: [
        message('notice', 'user', [{ type: 'text', id: 'n', text: noticeText('completed', REPORT) }]),
        message('reply', 'assistant', [{ type: 'text', id: 'a', text: 'The writer finished the draft.' }], { reply_to: 'notice' }),
      ],
    });
    const html = renderToStaticMarkup(
      wrap(
        <SessionTurn
          turn={turns[0]!} turnOutcome={{}} sessionId="synthetic" sessionStatus={undefined} isLast ownsPlan={false}
          permissions={[]} questions={[]} sessionWorking={false} isWorkingTurn={false}
          suppressBusyIndicator={false} awaitingUser={false} pending={false} isFirstTurn
          onPermissionReply={async () => {}} onRewind={() => {}} rewindDisabled
        />,
      ),
    );
    expect(html.match(/data-testid="subagent-notice"/g)).toHaveLength(1);
    expect(html).toContain('data-agent-status="done"');
    const text = textOf(html);
    expect(text).not.toContain('Worker complete');
    expect(text).not.toContain('A background subagent you started has finished');
    expect(text).toContain('The writer finished the draft.');
  });
});
