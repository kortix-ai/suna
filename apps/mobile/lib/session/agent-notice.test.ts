import { describe, expect, test } from 'bun:test';

import { agentNoticeOf, batchTitle, noticeExcerpt, noticeHeadline, noticeReport } from './agent-notice';

// The contract of apps/web session/turn/subagent-notice-row.tsx, asserted on the
// helpers the mobile notice draws from.

const CHILD = '0b7c2f1e-0000-4000-8000-000000000001';

// Synthetic values only: the text `subagentNoticeText` in apps/api/src/projects/subagent-notice.ts writes.
function noticeText(status: 'completed' | 'failed' | 'stopped', report: string, error?: string): string {
  const body =
    status === 'completed'
      ? `<task_result>\n${report}\n</task_result>`
      : `<task_error>\n${error ?? 'The subagent failed.'}\n</task_error>`;
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

describe('agentNoticeOf', () => {
  test('a typed prompt is not a notice', () => {
    expect(agentNoticeOf('Research Kortix and write a strategy')).toBeNull();
  });

  test('a delivered finish notice is one notice, named and opening its session', () => {
    const prompt = agentNoticeOf(noticeText('completed', '## Draft ready\n\nThe post is in posts/launch.md.'));
    expect(prompt?.kind).toBe('single');
    if (prompt?.kind !== 'single') return;
    expect(prompt.notice.sessionId).toBe(CHILD);
    expect(noticeHeadline(prompt.notice)).toBe('Draft the launch post finished');
    expect(noticeExcerpt(noticeReport(prompt.notice.result))).toBe('Draft ready');
  });

  test('a failed notice reads didn’t finish', () => {
    const prompt = agentNoticeOf(noticeText('failed', '', 'The model ran out of room.'));
    expect(prompt?.kind === 'single' && noticeHeadline(prompt.notice)).toBe('Draft the launch post didn’t finish');
  });
});

describe('notice lines', () => {
  test('the run is named without "(workflow)"; failed and stopped say so', () => {
    const notice = { kind: 'subagent', sessionId: CHILD, status: 'completed', handle: null, agent: null, title: 'Kortix growth marketing deep dive (workflow)', result: '', excerpt: '', ownedTasks: null } as const;
    expect(noticeHeadline(notice)).toBe('Kortix growth marketing deep dive finished');
    expect(noticeHeadline({ ...notice, status: 'failed' })).toBe('Kortix growth marketing deep dive didn’t finish');
    expect(noticeHeadline({ ...notice, status: 'stopped' })).toBe('Kortix growth marketing deep dive was stopped');
  });

  test('a workflow report reads without its result tag; a filler first line is no excerpt', () => {
    const report = noticeReport('<workflow_result>\nCompleted the full strategy.\n\nThe plan has three bets.\n</workflow_result>');
    expect(report).not.toContain('workflow_result');
    expect(noticeExcerpt(report)).toBe('Completed the full strategy.');
    expect(noticeExcerpt('Done.\nWrote poem.md.')).toBeNull();
  });

  test('a batch title counts its agents', () => {
    expect(batchTitle(3)).toBe('3 agents finished');
    expect(batchTitle(1)).toBe('1 agent finished');
  });
});

test('a JSON workflow result reads as its document', () => {
  const doc = '# Growth plan\n\nOne pack. Ten pilots.';
  expect(noticeReport(JSON.stringify({ strategy: doc }))).toBe(doc);
});
