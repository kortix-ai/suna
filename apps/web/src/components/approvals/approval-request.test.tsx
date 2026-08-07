import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ApprovalRequest } from './approval-request';

const request = {
  action: 'gmail.send_email',
  risk: 'write',
  projectName: 'Approval proof',
  requestedAt: '2026-08-06T00:00:00.000Z',
  argsPreview: {
    to: ['marko@kortix.ai'],
    cc: ['audit@kortix.ai'],
    subject: 'Review this exact email',
    body: 'The approver must see the complete email content.',
    access_token: '[redacted]',
  },
  reviewComplete: true,
  pending: true,
};

describe('ApprovalRequest', () => {
  test('shows every redacted parameter and only one-call decisions', () => {
    const html = renderToStaticMarkup(
      <ApprovalRequest request={request} onDecision={() => undefined} />,
    );

    expect(html).toContain('gmail.send_email');
    expect(html).toContain('marko@kortix.ai');
    expect(html).toContain('audit@kortix.ai');
    expect(html).toContain('Review this exact email');
    expect(html).toContain('The approver must see the complete email content.');
    expect(html).toContain('Hidden credential');
    expect(html).toContain('Approve this call');
    expect(html).toContain('Deny');
    expect(html).not.toContain('Allow for session');
    expect(html).not.toContain('Allow everything');
    expect(html).not.toContain('Always allow');
  });

  test('blocks approval when the complete parameter preview is unavailable', () => {
    const html = renderToStaticMarkup(
      <ApprovalRequest
        request={{ ...request, reviewComplete: false }}
        onDecision={() => undefined}
      />,
    );

    expect(html).toContain('complete parameters are not available');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*Approve this call/);
  });
});
