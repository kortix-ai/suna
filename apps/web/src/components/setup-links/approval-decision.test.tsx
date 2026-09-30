import type { ApprovalLinkDetails } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { ApprovalDecisionView } from './approval-decision';

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

  test('a call with no parameters shows no parameters box, and keeps the agent description', () => {
    const html = render({ details: { ...pending, args_preview: null } });
    expect(html).not.toContain('>Parameters<');
    expect(html).not.toContain('No parameters were recorded');
    expect(html).toContain('Merge pull request #482 into main');
    // Nothing was withheld, so the call is still decidable.
    expect(html).toContain('Approve this call');
  });

  test('no agent description and no parameters shows neither box', () => {
    const html = render({
      details: { ...pending, args_preview: null, approval_context: null },
    });
    expect(html).not.toContain('Agent&#x27;s description');
    expect(html).not.toContain('>Parameters<');
  });
});
