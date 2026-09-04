import { TooltipProvider } from '@/components/ui/tooltip';
import type { SessionAuditAction } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';
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
  acted_by_email: 'marko@kortix.ai',
  resolved_by: null,
  resolved_by_email: null,
  result_summary: {
    args_preview: {
      to: ['marko@kortix.ai'],
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
  test('collapsed: states the call, offers Review, and keeps the standalone link', () => {
    const html = render(
      <SessionApprovalNotice
        rows={approvalNoticeRows([pendingAction], {})}
        expanded={null}
        busy={{}}
        onToggle={() => undefined}
        onDecide={() => undefined}
      />,
    );

    expect(html).toContain('The agent needs your approval');
    expect(html).toContain('waiting for one decision');
    expect(html).toContain('gmail.send_email');
    expect(html).toContain('to: marko@kortix.ai · subject: Weekly report');
    expect(html).toContain('Review');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('href="https://dev.kortix.com/approve/tok-1"');
    expect(html).not.toContain('Approve this call');
    expect(html).not.toContain('Parameters');
  });

  test('expanded: reviews every redacted parameter and decides in place', () => {
    const html = render(
      <SessionApprovalNotice
        rows={approvalNoticeRows([pendingAction], {})}
        expanded="exec-1"
        busy={{}}
        onToggle={() => undefined}
        onDecide={() => undefined}
      />,
    );

    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('Parameters');
    expect(html).toContain('marko@kortix.ai');
    expect(html).toContain('The approver must see the complete email content.');
    expect(html).toContain('Hidden credential');
    expect(html).toContain('Approve this call');
    expect(html).toContain('Deny');
    expect(html).toContain('href="https://dev.kortix.com/approve/tok-1"');
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
        expanded="exec-1"
        busy={{}}
        onToggle={() => undefined}
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
        expanded="exec-1"
        busy={{}}
        onToggle={() => undefined}
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
        expanded={null}
        busy={{}}
        onToggle={() => undefined}
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
        expanded={null}
        busy={{}}
        onToggle={() => undefined}
        onDecide={() => undefined}
      />,
    );

    expect(html).toBe('');
  });
});
