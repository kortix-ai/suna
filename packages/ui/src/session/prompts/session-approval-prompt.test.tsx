import { TooltipProvider } from '../../primitives/tooltip';
import type { SessionAuditAction } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { SessionApprovalNotice } from './session-approval-prompt';
import { approvalNoticeRows } from './session-approval-review';

const pendingAction: SessionAuditAction = {
  execution_id: 'exec-1',
  action: 'gmail.send_email',
  connector_id: 'conn-1',
  connector: 'gmail',
  status: 'pending_approval',
  risk: 'write',
  acted_by: 'user-1',
  acted_by_email: 'sam@example.test',
  resolved_by: null,
  resolved_by_email: null,
  result_summary: {
    args_preview: {
      to: ['sam@example.test'],
      subject: 'Weekly report',
      body: 'The approver must see the complete email content.',
      access_token: '[redacted]',
    },
    args_preview_complete: true,
  },
  at: new Date().toISOString(),
  resolved_at: null,
  approval_url: 'https://dev.kortix.com/approve/tok-1',
};

function render(node: React.ReactNode): string {
  return renderToStaticMarkup(<TooltipProvider>{node}</TooltipProvider>);
}

describe('SessionApprovalNotice', () => {
  test('docks open on the call: names it, shows every parameter, decides in place', () => {
    const html = render(
      <SessionApprovalNotice
        rows={approvalNoticeRows([pendingAction], {})}
        current={null}
        busy={{}}
        onSelect={() => undefined}
        onDecide={() => undefined}
      />,
    );

    expect(html).toContain('The agent needs your approval');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('gmail.send_email');
    expect(html).toContain('Parameters');
    expect(html).toContain('sam@example.test');
    expect(html).toContain('The approver must see the complete email content.');
    expect(html).toContain('Hidden credential');
    expect(html).toContain('Approve this call');
    expect(html).toContain('Deny');
    expect(html).toContain('href="https://dev.kortix.com/approve/tok-1"');
    // One call: no pager.
    expect(html).not.toContain('1 / 1');
  });

  test('a viewer who may not decide: who decides replaces Deny / Approve (KRTX-1724)', () => {
    const html = render(
      <SessionApprovalNotice
        rows={approvalNoticeRows([{ ...pendingAction, can_resolve: false }], {})}
        current={null}
        busy={{}}
        onSelect={() => undefined}
        onDecide={() => undefined}
        launcherName="Ada"
      />,
    );

    expect(html).toContain('Needs approval');
    expect(html).not.toContain('The agent needs your approval');
    expect(html).toContain('Waiting for Ada or anyone who manages this project to approve or deny it.');
    expect(html).not.toContain('Approve this call');
    expect(html).not.toContain('>Deny<');
    // The call and its arguments still read.
    expect(html).toContain('sam@example.test');
    // The approval page answers this viewer 403: the link is there to copy
    // and send to whoever decides, not to open.
    expect(html).not.toContain('href="https://dev.kortix.com/approve/tok-1"');
    expect(html).not.toContain('Open the full approval page');
    expect(html).toContain('aria-label="Copy approval link"');
  });

  test('a session started with an API token: managers decide, nobody else is named', () => {
    const html = render(
      <SessionApprovalNotice
        rows={approvalNoticeRows([{ ...pendingAction, can_resolve: false, resolvers: 'managers' }], {})}
        current={null}
        busy={{}}
        onSelect={() => undefined}
        onDecide={() => undefined}
        launcherName="Ada"
      />,
    );
    expect(html).toContain('Waiting for anyone who manages this project to approve or deny it.');
    expect(html).not.toContain('Ada');
    expect(html).not.toContain('Approve this call');
  });

  test('can_resolve true keeps the decision', () => {
    const html = render(
      <SessionApprovalNotice
        rows={approvalNoticeRows([{ ...pendingAction, can_resolve: true }], {})}
        current={null}
        busy={{}}
        onSelect={() => undefined}
        onDecide={() => undefined}
        launcherName="Ada"
      />,
    );
    expect(html).toContain('The agent needs your approval');
    expect(html).toContain('Approve this call');
    expect(html).not.toContain('Waiting for');
    expect(html).toContain('href="https://dev.kortix.com/approve/tok-1"');
    expect(html).not.toContain('Copy approval link');
  });

  test('several pending: pages one call at a time, `current` picks which', () => {
    const second: SessionAuditAction = {
      ...pendingAction,
      execution_id: 'exec-2',
      action: 'github.repos.delete',
      risk: 'destructive',
    };
    const rows = approvalNoticeRows([pendingAction, second], {});
    const first = render(
      <SessionApprovalNotice
        rows={rows}
        current={null}
        busy={{}}
        onSelect={() => undefined}
        onDecide={() => undefined}
      />,
    );
    expect(first).toContain('1 / 2');
    expect(first).toContain('gmail.send_email');
    expect(first).not.toContain('github.repos.delete');

    const picked = render(
      <SessionApprovalNotice
        rows={rows}
        current="exec-2"
        busy={{}}
        onSelect={() => undefined}
        onDecide={() => undefined}
      />,
    );
    expect(picked).toContain('2 / 2');
    expect(picked).toContain('github.repos.delete');
    expect(picked).not.toContain('gmail.send_email');
  });

  test('expanded: a SHORTENED value is still approvable in place', () => {
    // A mail carrying an attachment: recipient legible, blob described,
    // `args_preview_complete` false. This used to render a disabled Approve
    // beside a warning, so the run could only ever be killed.
    const truncated: SessionAuditAction = {
      ...pendingAction,
      result_summary: {
        args_preview: { to: 'a@b.c', attachment: '[204800 chars omitted]' },
        args_preview_complete: false,
      },
    };
    const html = render(
      <SessionApprovalNotice
        rows={approvalNoticeRows([truncated], {})}
        current={null}
        busy={{}}
        onSelect={() => undefined}
        onDecide={() => undefined}
      />,
    );

    expect(html).toContain('[204800 chars omitted]');
    expect(html).toContain('Approve this call');
    expect(html).not.toContain('cannot be reviewed here');
    expect(html).not.toMatch(/<button[^>]*disabled=""/);
  });

  test('expanded: a call with nothing recorded offers Deny only', () => {
    const blind: SessionAuditAction = {
      ...pendingAction,
      result_summary: { args_preview_complete: false },
    };
    const html = render(
      <SessionApprovalNotice
        rows={approvalNoticeRows([blind], {})}
        current={null}
        busy={{}}
        onSelect={() => undefined}
        onDecide={() => undefined}
      />,
    );

    expect(html).toContain('cannot be reviewed here');
    expect(html).toContain('Deny');
    expect(html).not.toContain('Approve this call');
  });

  test('a decision taken here is confirmed on the card, not navigated away from', () => {
    const html = render(
      <SessionApprovalNotice
        rows={approvalNoticeRows([], {
          'exec-1': { action: pendingAction, decision: 'approve' },
        })}
        current={null}
        busy={{}}
        onSelect={() => undefined}
        onDecide={() => undefined}
      />,
    );

    expect(html).toContain('Approved');
    expect(html).toContain('Decision recorded');
    expect(html).not.toContain('Approve this call');
  });

  test('renders nothing when there is nothing to decide', () => {
    const html = render(
      <SessionApprovalNotice
        rows={[]}
        current={null}
        busy={{}}
        onSelect={() => undefined}
        onDecide={() => undefined}
      />,
    );

    expect(html).toBe('');
  });
});

// A Slack connector call needing approval showed `channel: C0…` in the session
// (2026-10-02). The session passes the project's bound channel names: the
// summary reads the name, and the parameters keep the exact id beside it.
describe('SessionApprovalNotice with Slack channel names', () => {
  const slackAction: SessionAuditAction = {
    ...pendingAction,
    execution_id: 'exec-slack',
    action: 'slack.send_message',
    connector: 'slack',
    result_summary: { args_preview: { channel: 'C0TEST1', text: 'Deploy done' }, args_preview_complete: true },
  };

  // The collapsed one-line summary is `approvalArgsSummary`, pinned with the
  // same names in session-approval-review.test.ts.
  test('the parameters keep the exact id beside the bound name', () => {
    const names = new Map([['C0TEST1', '#general']]);
    const html = render(
      <SessionApprovalNotice
        rows={approvalNoticeRows([slackAction], {})}
        current={null}
        busy={{}}
        onSelect={() => undefined}
        onDecide={() => undefined}
        channelNames={names}
      />,
    );
    expect(html).toContain('C0TEST1');
    expect(html).toContain('#general');
  });

  test("the session prompt reads names from the project's bindings, only while an approval shows", () => {
    const source = readFileSync(join(import.meta.dir, 'session-approval-prompt.tsx'), 'utf8');
    expect(source).toContain('useChannelBindings(rows.length > 0 ? projectId : null)');
    expect(source).toContain('slackChannelNames(');
  });
});
