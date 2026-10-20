import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ApprovalDecisionActions,
  ApprovalParameters,
  ApprovalRequest,
  approvalReviewable,
} from './approval-request';

const request = {
  action: 'gmail.send_email',
  risk: 'write',
  projectName: 'Approval proof',
  requestedAt: '2026-08-06T00:00:00.000Z',
  argsPreview: {
    to: ['sam@example.test'],
    cc: ['audit@example.test'],
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
    expect(html).toContain('sam@example.test');
    expect(html).toContain('audit@example.test');
    expect(html).toContain('Review this exact email');
    expect(html).toContain('The approver must see the complete email content.');
    expect(html).toContain('Hidden credential');
    expect(html).toContain('Approve this call');
    expect(html).toContain('Deny');
    expect(html).not.toContain('Allow for session');
    expect(html).not.toContain('Allow everything');
    expect(html).not.toContain('Always allow');
  });

  // KRTX-1724: a viewer the resolve route would refuse gets who decides, not
  // a Deny / Approve that answers 403.
  test('a viewer who may not decide sees who decides, and no decision', () => {
    const named = renderToStaticMarkup(
      <ApprovalRequest
        request={{ ...request, canResolve: false }}
        resolverName="Ada"
        onDecision={() => undefined}
      />,
    );
    expect(named).toContain('Waiting for Ada or anyone who manages this project to approve or deny it.');
    expect(named).not.toContain('Approve this call');
    expect(named).not.toContain('>Deny<');
    expect(named).toContain('sam@example.test');

    const plain = renderToStaticMarkup(
      <ApprovalRequest request={{ ...request, canResolve: false }} onDecision={() => undefined} />,
    );
    expect(plain).toContain('Waiting for the person who started this session or anyone who manages this project to approve or deny it.');

    // A session started with an API token: its launcher does not decide.
    const managers = renderToStaticMarkup(
      <ApprovalRequest
        request={{ ...request, canResolve: false, resolvers: 'managers' }}
        resolverName="Ada"
        onDecision={() => undefined}
      />,
    );
    expect(managers).toContain('Waiting for anyone who manages this project to approve or deny it.');
    expect(managers).not.toContain('Ada');
  });

  test("shows the agent's description as unverified, next to the parameters", () => {
    const html = renderToStaticMarkup(
      <ApprovalRequest
        request={{
          ...request,
          argsPreview: { draft_id: 'r-1' },
          approvalContext: 'Sends draft r-1 to a@example.test, subject "Q3"',
        }}
        onDecision={() => undefined}
      />,
    );
    expect(html).toContain('Agent&#x27;s description');
    expect(html).toContain('not verified');
    expect(html).toContain('Sends draft r-1 to a@example.test');
    expect(html).toContain('r-1');
  });

  test('offers a message to the agent with the decision', () => {
    const html = renderToStaticMarkup(
      <ApprovalRequest request={request} onDecision={() => undefined} />,
    );
    expect(html).toContain('Message to the agent (optional)');
    expect(html).not.toContain('Agent&#x27;s description');
  });

  test('a SHORTENED value still leaves the call approvable', () => {
    // The shape the gateway writes for a mail carrying an attachment: every
    // field is legible, the blob is described, `reviewComplete` is false. This
    // used to render a disabled button beside an orange warning, so the only
    // possible answer was Deny.
    const html = renderToStaticMarkup(
      <ApprovalRequest
        request={{
          ...request,
          reviewComplete: false,
          argsPreview: { ...request.argsPreview, attachment: '[204800 chars omitted]' },
        }}
        onDecision={() => undefined}
      />,
    );

    expect(html).toContain('[204800 chars omitted]');
    expect(html).toContain('marked in place');
    expect(html).toContain('Approve this call');
    expect(html).not.toContain('cannot be reviewed here');
    expect(html).not.toMatch(/<button[^>]*disabled=""/);
  });

  test('a call with NOTHING to review offers no Approve button at all', () => {
    const html = renderToStaticMarkup(
      <ApprovalRequest
        request={{ ...request, reviewComplete: false, argsPreview: null }}
        onDecision={() => undefined}
      />,
    );

    expect(html).toContain('cannot be reviewed here');
    expect(html).toContain('Deny');
    // The point of the change: no dead control. Not disabled — absent.
    expect(html).not.toContain('Approve this call');
  });

  test('an unauthorised viewer is told THAT, not that nothing was recorded', () => {
    const html = renderToStaticMarkup(
      <ApprovalRequest
        request={{
          ...request,
          reviewComplete: false,
          argsPreview: null,
          previewAuthorized: false,
        }}
        onDecision={() => undefined}
      />,
    );

    expect(html).toContain('not allowed to see');
    expect(html).not.toContain('Nothing was recorded');
    expect(html).not.toContain('Approve this call');
  });
});

describe('approvalReviewable', () => {
  test('separates "shortened" from "shows nothing"', () => {
    expect(approvalReviewable({ to: 'a@b.c' }, false)).toBe(true);
    expect(approvalReviewable({ to: 'a@b.c' }, true)).toBe(true);
    // No arguments at all: the server confirms nothing was withheld.
    expect(approvalReviewable(null, true)).toBe(true);
    expect(approvalReviewable({}, true)).toBe(true);
    // No preview AND something was withheld — nothing to judge.
    expect(approvalReviewable(null, false)).toBe(false);
    expect(approvalReviewable({}, false)).toBe(false);
  });
});

describe('ApprovalParameters', () => {
  test('shows the same redacted values in the dense in-session rendering', () => {
    const html = renderToStaticMarkup(
      <ApprovalParameters dense argsPreview={request.argsPreview} reviewComplete />,
    );

    expect(html).toContain('Parameters');
    expect(html).toContain('sam@example.test');
    expect(html).toContain('audit@example.test');
    expect(html).toContain('The approver must see the complete email content.');
    expect(html).toContain('Hidden credential');
  });

  test('says so when the row carries no preview — and does not tell you to approve it', () => {
    const html = renderToStaticMarkup(<ApprovalParameters dense argsPreview={null} />);

    expect(html).toContain('No parameters were recorded for this call.');
    // The old empty state said "Review the session context before you approve
    // it", next to an Approve button that could not be clicked.
    expect(html).not.toContain('before you approve');
    expect(html).not.toContain('the redacted values the connector will receive');
  });
});

describe('ApprovalDecisionActions', () => {
  test('offers exactly one-call decisions', () => {
    const html = renderToStaticMarkup(
      <ApprovalDecisionActions dense onDecision={() => undefined} />,
    );

    expect(html).toContain('Approve this call');
    expect(html).toContain('Deny');
    expect(html).not.toContain('Allow for session');
    expect(html).not.toContain('Allow everything');
    expect(html).not.toContain('Always allow');
  });

  test('drops Approve entirely when the call cannot be reviewed', () => {
    const html = renderToStaticMarkup(
      <ApprovalDecisionActions dense approvable={false} onDecision={() => undefined} />,
    );

    expect(html).toContain('Deny');
    expect(html).not.toContain('Approve this call');
  });
});

// A Slack connector call needing approval showed `channel: C0…` in the session
// (2026-10-02). The session passes the project's bound channel names: the
// summary reads the name, and the parameters keep the exact id beside it.
describe('ApprovalParameters with Slack channel names', () => {
  test('a bound channel id keeps its value and shows its name beside it', () => {
    const html = renderToStaticMarkup(
      <ApprovalParameters dense argsPreview={{ channel: 'C0TEST1', text: 'hi' }} channelNames={new Map([['C0TEST1', '#general']])} />,
    );
    expect(html).toContain('C0TEST1');
    expect(html).toContain('#general');
  });

  test('without names, the value alone', () => {
    const html = renderToStaticMarkup(<ApprovalParameters dense argsPreview={{ channel: 'C0TEST1' }} />);
    expect(html).toContain('C0TEST1');
    expect(html).not.toContain('#general');
  });
});

// A Gmail "send draft" approval showed the reviewer nothing: the call carried
// only `draft_id`, and the panel hid an empty parameters box. Every call now
// shows its parameters, an email reads as an email, and content the server
// loads for the reviewer sits above the call's own arguments.
describe('ApprovalParameters rendering', () => {
  test('an empty preview still shows the parameters section', () => {
    const html = renderToStaticMarkup(<ApprovalParameters argsPreview={{}} />);
    expect(html).toContain('Parameters');
    expect(html).toContain('No parameters were recorded for this call.');
    expect(html).toContain('Any description from the agent is unverified.');
  });

  test('a call that names its target only by id says the content is not shown', () => {
    const html = renderToStaticMarkup(<ApprovalParameters argsPreview={{ draft_id: 'r-1' }} />);
    expect(html).toContain('r-1');
    expect(html).toContain('Any description from the agent is unverified.');
    const named = renderToStaticMarkup(
      <ApprovalParameters argsPreview={{ threadId: 't-1', id: 'x', user_id: 'u' }} />,
    );
    expect(named).toContain('Any description from the agent is unverified.');
  });

  test('an email-shaped preview renders To, Cc, Subject and the body as a message', () => {
    const html = renderToStaticMarkup(
      <ApprovalParameters
        argsPreview={{
          recipient_email: 'sam@example.test',
          cc: ['audit@example.test'],
          subject: 'Q3 numbers',
          message_body: 'Hi Sam,\nThe numbers are attached.',
          is_html: false,
        }}
      />,
    );
    expect(html).toContain('>To<');
    expect(html).toContain('>Cc<');
    expect(html).toContain('>Subject<');
    expect(html).not.toContain('>Bcc<');
    expect(html).toContain('sam@example.test');
    expect(html).toContain('Q3 numbers');
    expect(html).toContain('Hi Sam,\nThe numbers are attached.');
    // Header keys leave the key/value list; the rest stays in it.
    expect(html).not.toContain('>recipient_email<');
    expect(html).not.toContain('>message_body<');
    expect(html).toContain('>is_html<');
    expect(html).not.toContain('Any description from the agent is unverified.');
  });

  test('a preview that is not an email renders as a key/value list', () => {
    const html = renderToStaticMarkup(
      <ApprovalParameters argsPreview={{ repo: 'acme/web', subject: 'not mail' }} />,
    );
    expect(html).toContain('>repo<');
    expect(html).toContain('>subject<');
    expect(html).not.toContain('>Subject<');
  });

  test('a redacted email body stays hidden', () => {
    const html = renderToStaticMarkup(
      <ApprovalParameters argsPreview={{ to: 'a@example.test', subject: 's', body: '[redacted]' }} />,
    );
    expect(html).toContain('Hidden credential');
    expect(html).not.toContain('[redacted]');
  });

  test('a resolved preview renders above the call arguments, labelled by connector', () => {
    const html = renderToStaticMarkup(
      <ApprovalParameters
        argsPreview={{ draft_id: 'r-1' }}
        resolvedPreview={{ to: 'sam@example.test', subject: 'Q3 numbers', body: 'Draft body' }}
        resolvedFrom="Gmail"
      />,
    );
    const loaded = html.indexOf('Loaded from Gmail');
    expect(loaded).toBeGreaterThan(-1);
    expect(html.indexOf('Draft body')).toBeGreaterThan(loaded);
    expect(html.indexOf('r-1')).toBeGreaterThan(html.indexOf('Draft body'));
    // The content is shown, so the blind-approval hint is not.
    expect(html).not.toContain('Any description from the agent is unverified.');
  });

  test('ApprovalRequest passes the resolved preview through', () => {
    const html = renderToStaticMarkup(
      <ApprovalRequest
        request={{ ...request, argsPreview: { draft_id: 'r-1' }, resolvedPreview: { subject: 'Loaded' } }}
        onDecision={() => undefined}
      />,
    );
    expect(html).toContain('Loaded from the connector');
    expect(html).toContain('Loaded');
  });
});
