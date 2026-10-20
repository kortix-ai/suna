import type { ApprovalLinkDetails } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { ApprovalDecisionPanel, ApprovalDecisionView } from './approval-decision';

// The standalone approve page has six states. Each is rendered here from the
// same view the page uses, so a state that stops showing its outcome, its
// parameters, or the right decisions fails in a test, not in front of a person.

const pending: ApprovalLinkDetails = {
  kind: 'approval',
  project_id: 'project-1',
  project_name: 'Growth research',
  execution_id: 'execution-1',
  session_id: 'session-1',
  action: 'github.merge_pull_request',
  connector: 'github',
  risk: 'write',
  status: 'pending_approval',
  pending: true,
  args_preview: { repo: 'acme/web', pull_number: 482, merge_method: 'squash' },
  review_complete: true,
  args_summary: null,
  approval_context: 'Merge pull request #482 into main',
  policy_source: null,
  requested_at: '2026-08-06T14:32:00.000Z',
  resolved_at: null,
  expires_at: '2026-08-07T14:32:00.000Z',
};

function render(props: Partial<Parameters<typeof ApprovalDecisionView>[0]>) {
  return renderToStaticMarkup(
    <ApprovalDecisionView
      loading={false}
      details={pending}
      outcome={null}
      busyDecision={null}
      error={null}
      onDecision={() => undefined}
      {...props}
    />,
  );
}

describe('ApprovalDecisionView', () => {
  test('loading: a spinner, and nothing to decide yet', () => {
    const html = render({ loading: true, details: null });
    expect(html).not.toContain('Approve this call');
    expect(html).not.toContain('This approval cannot be opened');
  });

  test('cannot open: says so, with the reason, and offers no decision', () => {
    const html = render({ details: null, error: 'This approval link has expired.' });
    expect(html).toContain('This approval cannot be opened');
    expect(html).toContain('This approval link has expired.');
    expect(html).not.toContain('Approve this call');
    expect(html).not.toContain('Deny');
  });

  test('cannot open falls back to the stock reason', () => {
    expect(render({ details: null })).toContain('The link is invalid or expired.');
  });

  test('pending decision: the call, every parameter, the reply, and both decisions', () => {
    const html = render({});
    expect(html).toContain('An agent needs your approval');
    expect(html).toContain('Merge pull request');
    expect(html).toContain('github.merge_pull_request');
    expect(html).toContain('Growth research');
    expect(html).toContain('acme/web');
    expect(html).toContain('482');
    expect(html).toContain('squash');
    // The agent's claim stays labelled as the agent's, not as the page's own words.
    expect(html).toContain('Agent&#x27;s description');
    expect(html).toContain('Merge pull request #482 into main');
    expect(html).toContain('Message to the agent (optional)');
    expect(html).toContain('Deny');
    expect(html).toContain('Approve this call');
    expect(html).not.toContain('Action approved');
  });

  test('pending decision works for any connector, not one', () => {
    const html = render({
      details: {
        ...pending,
        action: 'linear.create_issue',
        connector: 'linear',
        args_preview: { team: 'WEB', labels: ['bug', 'p1'] },
      },
    });
    expect(html).toContain('Create issue');
    expect(html).toContain('linear.create_issue');
    expect(html).toContain('logos.composio.dev/api/linear');
    expect(html).toContain('bug, p1');
  });

  test('a connector the API names is named in the title and shown with its own logo', () => {
    const html = render({
      details: {
        ...pending,
        action: 'googledrive.share_file',
        connector: 'googledrive',
        connector_name: 'Google Drive',
        connector_icon_url: 'https://cdn.example.test/drive.svg',
      },
    });
    expect(html).toContain('Approve this Google Drive action');
    expect(html).toContain('https://cdn.example.test/drive.svg');
    expect(html).not.toContain('logos.composio.dev');
    expect(html).toContain('Share file');
  });

  test('a connector with no logo and no dotted action still reads: its first letter, the raw action', () => {
    const html = render({
      details: {
        ...pending,
        action: 'run_custom_report',
        connector: 'internal_bi',
        connector_name: 'Internal BI',
        connector_icon_url: null,
      },
    });
    // "this", not "a": the name decides a/an, and the template cannot.
    expect(html).toContain('Approve this Internal BI action');
    expect(html).toContain('run_custom_report');
    expect(html).not.toContain('<img');
  });

  test('a call with no connector at all keeps the stock title', () => {
    const html = render({ details: { ...pending, connector: null, connector_name: null } });
    expect(html).toContain('An agent needs your approval');
  });

  test('approved on this screen: the outcome leads, with its mark, and the decisions are gone', () => {
    const html = render({ outcome: 'approve' });
    expect(html).toContain('Action approved');
    expect(html).toContain('text-kortix-green');
    expect(html).not.toContain('An agent needs your approval');
    expect(html).not.toContain('Approve this call');
    expect(html).not.toContain('Message to the agent');
    // The record of what was approved stays.
    expect(html).toContain('github.merge_pull_request');
    expect(html).toContain('acme/web');
  });

  test('approved elsewhere: a reopened link shows the outcome, not buttons', () => {
    const html = render({ details: { ...pending, pending: false, status: 'ok' } });
    expect(html).toContain('Action approved');
    expect(html).toContain('text-kortix-green');
    expect(html).not.toContain('Approve this call');
  });

  test('denied: the outcome leads, with a different mark from approved', () => {
    for (const html of [
      render({ outcome: 'deny' }),
      render({ details: { ...pending, pending: false, status: 'denied' } }),
    ]) {
      expect(html).toContain('Action denied');
      expect(html).toContain('text-kortix-red');
      expect(html).not.toContain('text-kortix-green');
      expect(html).not.toContain('Approve this call');
      expect(html).not.toContain('Deny</button>');
    }
  });

  test('unreviewable: nothing to look at means no approve path, only deny', () => {
    const html = render({ details: { ...pending, args_preview: null, review_complete: false } });
    expect(html).toContain('An agent needs your approval');
    expect(html).toContain('Deny');
    expect(html).not.toContain('Approve this call');
    // It says why, instead of showing a control that can never fire.
    expect(html).toContain('text-kortix-orange');
  });

  test('a failed decision keeps the buttons and shows the reason', () => {
    const html = render({ error: 'Could not record your decision.' });
    expect(html).toContain('Could not record your decision.');
    expect(html).toContain('Approve this call');
  });

  test('one fact per row: what runs, the tool path, and the access level', () => {
    const html = render({});
    expect(html).toContain('>Run<');
    expect(html).toContain('>Tool<');
    expect(html).toContain('>Access<');
    expect(html).toContain('>Write<');
  });

  // Nothing recorded and nothing loaded: no empty "Parameters" box.
  test('a call with no parameters shows no parameters section, and keeps the agent description', () => {
    const html = render({ details: { ...pending, args_preview: null } });
    expect(html).not.toContain('>Parameters<');
    expect(html).not.toContain('No parameters were recorded for this call.');
    expect(html).toContain('Merge pull request #482 into main');
    // Nothing was withheld, so the call is still decidable.
    expect(html).toContain('Approve this call');
  });

  test('a send-draft call with only an id says the agent description is unverified', () => {
    const html = render({
      details: {
        ...pending,
        action: 'gmail.send_draft',
        args_preview: { draft_id: 'r-1' },
        approval_context: 'Sends the Q3 draft',
      },
    });
    expect(html).toContain('r-1');
    expect(html).toContain('Any description from the agent is unverified.');
  });

  test('a send-draft call shows the draft the server loaded, or warns that it could not', () => {
    const draftCall = { ...pending, action: 'gmail.send_draft', connector: 'gmail', connector_name: 'Gmail', args_preview: { draft_id: 'r-1' } };
    const loaded = render({
      details: { ...draftCall, resolved_preview: { to: 'sam@example.test', body: 'Draft body' }, resolved_error: null },
    });
    expect(loaded).toContain('Loaded from Gmail');
    expect(loaded).toContain('Draft body');
    expect(loaded).not.toContain('Any description from the agent is unverified.');
    expect(loaded).not.toContain('This call shows no content to check');
    expect(loaded).not.toContain('>Parameters<');

    const failed = render({ details: { ...draftCall, resolved_preview: null, resolved_error: 'unavailable' } });
    expect(failed).toContain('Couldn&#x27;t load the draft.');
    expect(failed).not.toContain('Loaded from');
  });

  test('an email-shaped call reads as a message', () => {
    const html = render({
      details: {
        ...pending,
        action: 'gmail.send_email',
        args_preview: { to: 'sam@example.test', subject: 'Q3 numbers', body: 'Draft body' },
      },
    });
    expect(html).toContain('>To<');
    expect(html).toContain('>Subject<');
    expect(html).toContain('Draft body');
    expect(html).not.toContain('>body<');
  });

  test('a call that is not an email keeps the key/value list, and no unverified hint', () => {
    const html = render({});
    expect(html).toContain('>repo<');
    expect(html).toContain('acme/web');
    expect(html).not.toContain('>Subject<');
    expect(html).not.toContain('Any description from the agent is unverified.');
  });

  test('no agent description and no parameters: neither section renders', () => {
    const html = render({
      details: { ...pending, args_preview: null, approval_context: null },
    });
    expect(html).not.toContain('Agent&#x27;s description');
    expect(html).not.toContain('>Parameters<');
  });
});

describe('ApprovalDecisionPanel', () => {
  const panel = (props: Partial<Parameters<typeof ApprovalDecisionPanel>[0]>) =>
    renderToStaticMarkup(
      <ApprovalDecisionPanel
        details={pending}
        outcome={null}
        busyDecision={null}
        error={null}
        onDecision={() => undefined}
        {...props}
      />,
    );

  test('renders the same call and decisions as the page, without the page frame', () => {
    const html = panel({});
    expect(html).toContain('An agent needs your approval');
    expect(html).toContain('github.merge_pull_request');
    expect(html).toContain('acme/web');
    expect(html).toContain('Approve this call');
    expect(html).toContain('Deny');
    expect(html).not.toContain('min-h-svh');
  });

  test('no decision handler: the call reads, but nothing can be decided', () => {
    const html = panel({ onDecision: undefined });
    expect(html).toContain('github.merge_pull_request');
    expect(html).not.toContain('Approve this call');
    expect(html).not.toContain('Message to the agent');
  });

  test('no decision handler on a pending call: it says who decides (KRTX-1724)', () => {
    const html = panel({ onDecision: undefined });
    expect(html).toContain('Waiting for the person who started this session or anyone who manages this project to approve or deny it.');
    expect(html).not.toContain('An agent needs your approval');
    // A decided call needs no waiting line.
    expect(panel({ onDecision: undefined, outcome: 'approve' })).not.toContain('Waiting for');
    // A session started with an API token: only managers decide.
    expect(panel({ onDecision: undefined, resolvers: 'managers' })).toContain(
      'Waiting for anyone who manages this project to approve or deny it.',
    );
  });

  test('a session to return to is one row, and only when it can be opened', () => {
    expect(panel({ onOpenSession: () => undefined })).toContain('Open session');
    expect(panel({})).not.toContain('Open session');
  });

  test('the connector mark hides on mobile on the page, and stays in the modal', () => {
    // The page's AuthFrame pins a Kortix logo in the mobile corner instead;
    // the modal has no frame, so its mark must not hide below `md`.
    expect(panel({})).toContain('hidden md:block');
    const modal = panel({ markOnMobile: true });
    expect(modal).not.toContain('hidden md:block');
    expect(modal).toContain('logos.composio.dev/api/github');
  });

  test('an Expires row sits next to Requested', () => {
    const html = panel({});
    expect(html).toContain('Requested');
    expect(html).toContain('Expires');
    expect(html.indexOf('Expires')).toBeGreaterThan(html.indexOf('Requested'));
    expect(panel({ outcome: 'approve' })).not.toContain('Expires');
  });

  test('expired: the outcome reads Expired, says what to do, and both decisions are off', () => {
    const html = panel({ details: { ...pending, status: 'expired', pending: false } });
    expect(html).toContain('Expired');
    expect(html).toContain('This approval expired. Ask the agent to request it again.');
    expect(html).toContain('data-slot="alert"');
    expect(html).not.toContain('An agent needs your approval');
    // Deny, Approve and the note: each one carries the disabled attribute.
    // The description's info trigger is not a decision control.
    const controls = (html.match(/<(button|textarea)[^>]*>/g) ?? []).filter(
      (tag) => !tag.includes('hover-card-trigger'),
    );
    expect(controls).toHaveLength(3);
    expect(controls.every((tag) => / disabled=""/.test(tag))).toBe(true);
    expect(html).toContain('Approve this call');
  });

  test('expired, for a viewer who may not decide: the reason, and no decisions', () => {
    const html = panel({
      details: { ...pending, status: 'expired', pending: false },
      onDecision: undefined,
    });
    expect(html).toContain('This approval expired. Ask the agent to request it again.');
    expect(html).not.toContain('Approve this call');
    expect(html).not.toContain('Waiting for');
  });

  test('a viewer without argument visibility is told why, not that nothing was recorded', () => {
    const html = panel({
      details: { ...pending, args_preview: null, review_complete: false },
      previewAuthorized: false,
    });
    expect(html).not.toContain('Approve this call');
    expect(html).toContain('text-kortix-orange');
    expect(html).toContain('data-slot="alert"');
    expect(html).not.toContain('No parameters were recorded');
  });

  test('a call with nothing recorded warns in the design-system Alert', () => {
    const html = panel({ details: { ...pending, args_preview: null, review_complete: false } });
    expect(html).toContain('data-slot="alert"');
    expect(html).toContain('bg-kortix-orange/15');
    expect(html).toContain('cannot be reviewed here');
    expect(html).not.toContain('>Parameters<');
  });
});
