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
import { firstLine, parseSubagentNotice } from './subagent-notice';
import { SubagentNoticeRow } from './subagent-notice-row';

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

describe('parseSubagentNotice', () => {
  test('reads the child, its status, its name and its result', () => {
    expect(parseSubagentNotice(noticeText('completed', REPORT))).toEqual({
      kind: 'subagent',
      handle: null,
      ownedTasks: null,
      sessionId: CHILD,
      status: 'completed',
      agent: 'writer',
      title: 'Draft the launch post',
      result: REPORT,
      excerpt: 'Draft ready',
    });
  });

  test('a failed or stopped child carries its error as the result', () => {
    expect(parseSubagentNotice(noticeText('failed', '', 'The model ran out of room.'))).toMatchObject({
      status: 'failed',
      result: 'The model ran out of room.',
      excerpt: 'The model ran out of room.',
    });
    expect(parseSubagentNotice(noticeText('stopped', '', 'The subagent was stopped.'))?.status).toBe('stopped');
  });

  test('any other prompt, a session report included, is not a notice', () => {
    expect(parseSubagentNotice('Draft the launch post')).toBeNull();
    expect(parseSubagentNotice(noticeText('completed', REPORT).replace('A background subagent you started has finished.', 'Hi.'))).toBeNull();
    expect(parseSubagentNotice(null)).toBeNull();
  });

  test('the excerpt is the first line with words, without Markdown marks', () => {
    expect(firstLine('\n\n- **Done:** 3 files\nmore')).toBe('Done: 3 files');
  });
});

describe('SubagentNoticeRow', () => {
  test('a finished child is one compact row: ✅, its name, the first line of its result', () => {
    const html = render(<SubagentNoticeRow notice={parseSubagentNotice(noticeText('completed', REPORT))!} />);
    const text = textOf(html);
    expect(html).toContain('data-testid="subagent-notice"');
    expect(html).toContain('data-notice-status="completed"');
    expect(text).toContain('✅');
    expect(text).toContain('Draft the launch post finished');
    expect(text).toContain('Draft ready');
    // Closed: the rest of the report stays folded.
    expect(text).not.toContain('600 words');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-label="Open session"');
  });

  test('a failed child says it did not finish, with a warning label, never a done mark', () => {
    const text = textOf(render(<SubagentNoticeRow notice={parseSubagentNotice(noticeText('failed', '', 'The model ran out of room.'))!} />));
    expect(text).toContain('⚠️');
    expect(text).toContain('Draft the launch post didn’t finish');
    expect(text).not.toContain('✅');
  });

  test('a stopped child takes no emoji', () => {
    const text = textOf(render(<SubagentNoticeRow notice={parseSubagentNotice(noticeText('stopped', '', 'The subagent was stopped.'))!} />));
    expect(text).toContain('Draft the launch post was stopped');
    expect(text).not.toContain('✅');
    expect(text).not.toContain('⚠️');
  });

  test('the row opens in place to the whole result', async () => {
    // The "Open session" hint's tooltip listens on `document`.
    const dom = new Window();
    const globals = globalThis as unknown as Record<string, unknown>;
    const saved = { window: globals.window, document: globals.document };
    globals.window = dom;
    globals.document = dom.document;
    let tree: ReturnType<typeof create> | undefined;
    await act(async () => {
      tree = create(wrap(<SubagentNoticeRow notice={parseSubagentNotice(noticeText('completed', REPORT))!} />));
    });
    const disclosure = () => tree!.root.findAll((node) => node.type === 'button' && node.props['aria-expanded'] !== undefined)[0]!;
    await act(async () => disclosure().props.onClick());
    expect(disclosure().props['aria-expanded']).toBe(true);
    expect(JSON.stringify(tree!.toJSON())).toContain('600 words');
    await act(async () => tree!.unmount());
    globals.window = saved.window;
    globals.document = saved.document;
    await dom.happyDOM.close();
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

  test('a notice turn draws the compact row, not the "Worker complete" card or a user bubble', () => {
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
    expect(html).toContain('data-testid="subagent-notice"');
    const text = textOf(html);
    expect(text).toContain('Draft the launch post finished');
    expect(text).not.toContain('Worker complete');
    expect(text).not.toContain('A background subagent you started has finished');
    expect(text).toContain('The writer finished the draft.');
  });
});
