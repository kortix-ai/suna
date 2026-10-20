import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ApprovalAgentContext,
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
    expect(html).toContain('Sends draft r-1 to a@example.test');
    expect(html).toContain('r-1');
    // The unverified note sits in a hover card behind an info trigger, not inline.
    const note = 'Written by the agent and not verified. The parameters below are what the connector receives.';
    expect(html).toContain(`aria-label="${note}"`);
    expect(html).toContain('data-slot="hover-card-trigger"');
    expect(html).not.toContain(`>${note}<`);
  });

  test('the dense agent description keeps the same info trigger', () => {
    const html = renderToStaticMarkup(<ApprovalAgentContext dense context="Sends the Q3 draft" />);
    expect(html).toContain('data-slot="hover-card-trigger"');
    expect(html).toContain('aria-label="Written by the agent and not verified.');
    expect(html).toContain('Sends the Q3 draft');
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
          action: 'drive.upload',
          reviewComplete: false,
          argsPreview: { folder: 'reports', attachment: '[204800 chars omitted]' },
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
  test('shows the same values in the dense in-session rendering', () => {
    const html = renderToStaticMarkup(
      <ApprovalParameters dense argsPreview={request.argsPreview} reviewComplete />,
    );

    expect(html).toContain('sam@example.test');
    expect(html).toContain('audit@example.test');
    expect(html).toContain('The approver must see the complete email content.');
    const list = renderToStaticMarkup(
      <ApprovalParameters dense argsPreview={{ repo: 'acme/web', token: '[redacted]' }} reviewComplete />,
    );
    expect(list).toContain('Parameters');
    expect(list).toContain('Hidden credential');
  });

  test('renders nothing when the row carries no preview and nothing was loaded', () => {
    expect(renderToStaticMarkup(<ApprovalParameters dense argsPreview={null} />)).toBe('');
    expect(renderToStaticMarkup(<ApprovalParameters argsPreview={{}} resolvedPreview={{}} />)).toBe('');
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
  test('a call that names its target only by id says the content is not shown', () => {
    const html = renderToStaticMarkup(<ApprovalParameters argsPreview={{ draft_id: 'r-1' }} />);
    expect(html).toContain('r-1');
    expect(html).toContain('Any description from the agent is unverified.');
    const named = renderToStaticMarkup(
      <ApprovalParameters argsPreview={{ threadId: 't-1', id: 'x', user_id: 'u' }} />,
    );
    expect(named).toContain('Any description from the agent is unverified.');
  });

  test('an email reads as ONE email: From, To, Cc, Bcc, Subject, then the body', () => {
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
    const order = ['>From<', '>To<', '>Cc<', '>Subject<', 'Hi Sam,'].map((needle) => html.indexOf(needle));
    expect(order.every((index) => index > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // Cc shows because it is set; an unset Bcc has no row. An empty From reads None.
    expect(html).not.toContain('>Bcc<');
    expect(html.match(/>None</g)?.length).toBe(1); // From
    expect(html).toContain('sam@example.test');
    expect(html).toContain('Q3 numbers');
    // One card: no section header, no raw keys, no arguments outside the email.
    expect(html).not.toContain('>Parameters<');
    expect(html).not.toContain('>recipient_email<');
    expect(html).not.toContain('>is_html<');
    expect(html).not.toContain('Any description from the agent is unverified.');
    expect(html).not.toContain('Loaded from');
  });

  test('an email without a subject or body still shows those rows as None; no Cc or Bcc rows', () => {
    const html = renderToStaticMarkup(<ApprovalParameters argsPreview={{ to: 'sam@example.test', subject: '' }} />);
    expect(html).toContain('>Subject<');
    expect(html).not.toContain('>Cc<');
    expect(html).not.toContain('>Bcc<');
    expect(html.match(/>None</g)?.length).toBe(3); // From, Subject, body
  });

  test('send_email: From comes from the resolved preview, the rest from the arguments', () => {
    const html = renderToStaticMarkup(
      <ApprovalParameters
        argsPreview={{ to: 'sam@example.test', subject: 'Hi', body: 'Text', user_id: 'me' }}
        resolvedPreview={{ from: 'ops@example.test' }}
        resolvedFrom="gmail"
      />,
    );
    expect(html.indexOf('ops@example.test')).toBeGreaterThan(html.indexOf('>From<'));
    expect(html.indexOf('ops@example.test')).toBeLessThan(html.indexOf('>To<'));
    // The caption names the connector, capitalised, below the body.
    expect(html.indexOf('Loaded from Gmail')).toBeGreaterThan(html.indexOf('Text'));
    expect(html).not.toContain('>from<');
    expect(html).not.toContain('>user_id<');
  });

  test('an empty resolved preview counts as absent', () => {
    const html = renderToStaticMarkup(
      <ApprovalParameters argsPreview={{ draft_id: 'r-1' }} resolvedPreview={{}} resolvedFrom="Gmail" />,
    );
    expect(html).not.toContain('Loaded from');
    expect(html).toContain('Any description from the agent is unverified.');
  });

  test('a failed load warns that the agent description is all there is', () => {
    const html = renderToStaticMarkup(
      <ApprovalParameters argsPreview={{ draft_id: 'r-1' }} resolvedError="unavailable" />,
    );
    expect(html).toContain('Couldn&#x27;t load the draft. Review the agent&#x27;s description carefully.');
    expect(html).not.toContain('Any description from the agent is unverified.');
    const passed = renderToStaticMarkup(
      <ApprovalRequest
        request={{ ...request, argsPreview: { draft_id: 'r-1' }, resolvedError: 'unavailable' }}
        onDecision={() => undefined}
      />,
    );
    expect(passed).toContain('Couldn&#x27;t load the draft.');
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

  test('send_draft: the loaded draft is the email, and the draft id stays out of it', () => {
    const html = renderToStaticMarkup(
      <ApprovalParameters
        argsPreview={{ draft_id: 'r-1' }}
        resolvedPreview={{
          from: 'ops@example.test',
          to: 'sam@example.test',
          cc: '',
          bcc: 'audit@example.test',
          subject: 'Q3 numbers',
          body: 'Draft body',
          attachments: ['q3.pdf'],
        }}
        resolvedFrom="Gmail"
      />,
    );
    const order = ['>From<', '>To<', '>Bcc<', '>Subject<', 'Draft body', 'Loaded from Gmail'].map((n) =>
      html.indexOf(n),
    );
    expect(order.every((index) => index > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain('q3.pdf');
    // The empty Cc has no row.
    expect(html).not.toContain('>Cc<');
    expect(html).not.toContain('>None<');
    expect(html).not.toContain('r-1');
    expect(html).not.toContain('>Parameters<');
    // The content is shown, so the blind-approval hint is not.
    expect(html).not.toContain('Any description from the agent is unverified.');
    expect(html).not.toContain('This call shows no content to check');
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
