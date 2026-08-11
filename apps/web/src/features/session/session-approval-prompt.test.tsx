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
  approval_url: 'https://dev.dosco.live/approve/tok-1',
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
    expect(html).toContain('href="https://dev.dosco.live/approve/tok-1"');
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
    expect(html).toContain('href="https://dev.dosco.live/approve/tok-1"');
  });

  test('expanded: cannot approve a call whose preview is incomplete', () => {
    const incomplete: SessionAuditAction = {
      ...pendingAction,
      result_summary: { args_preview: { to: 'a@b.c' }, args_preview_complete: false },
    };
    const html = render(
      <SessionApprovalNotice
        rows={approvalNoticeRows([incomplete], {})}
        expanded="exec-1"
        busy={{}}
        onToggle={() => undefined}
        onDecide={() => undefined}
      />,
    );

    expect(html).toContain('complete parameters are not available');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*Approve this call/);
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
