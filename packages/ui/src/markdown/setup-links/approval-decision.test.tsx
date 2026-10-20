import type { ApprovalLinkDetails } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { ApprovalDecisionPanel, ApprovalDecisionView, expiryChip } from './approval-decision';

// The standalone approve page and the Review Center modal render one panel
// (Paper V01, sentence-first). Each state is rendered here from the same view
// the page uses, so a state that stops showing its outcome, its call, or the
// right decisions fails in a test, not in front of a person.

const HOUR = 60 * 60 * 1000;

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
  // Far enough out that the chip is neutral and the day is not today.
  expires_at: new Date(Date.now() + 72 * HOUR).toISOString(),
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

const call = (details: Partial<ApprovalLinkDetails>) => ({
  ...pending,
  ...details,
});

describe('ApprovalDecisionView', () => {
  test('loading: nothing to decide yet', () => {
    const html = render({ loading: true, details: null });
    expect(html).not.toContain('Approve');
    expect(html).not.toContain('This approval cannot be opened');
  });

  test('cannot open: says so, with the reason, and offers no decision', () => {
    const html = render({
      details: null,
      error: 'This approval link has expired.',
    });
    expect(html).toContain('This approval cannot be opened');
    expect(html).toContain('This approval link has expired.');
    expect(html).not.toContain('Deny');
  });

  test('cannot open falls back to the stock reason', () => {
    expect(render({ details: null })).toContain('The link is invalid or expired.');
  });

  test('pending: the page frames the panel in one bordered card', () => {
    const html = render({});
    expect(html).toContain('rounded-xl border');
    expect(html).toContain('An agent wants to merge PR #482');
    expect(html).toContain('Approve and merge');
  });
});

describe('ApprovalDecisionPanel headline', () => {
  test('gmail send_email: "email {first To}"', () => {
    const html = panel({
      agentName: 'Writer',
      details: call({
        action: 'gmail.send_email',
        connector: 'gmail',
        args_preview: {
          to: 'reviewer@example.test',
          subject: 'Q3',
          body: 'Hi',
        },
      }),
    });
    expect(html).toContain('Writer wants to email reviewer@example.test');
  });

  test('gmail send_email with more recipients: "and N others"', () => {
    const html = panel({
      agentName: 'Writer',
      details: call({
        action: 'gmail.send_email',
        connector: 'gmail',
        args_preview: {
          to: ['a@example.test', 'b@example.test'],
          extra_recipients: ['c@example.test'],
          body: 'Hi',
        },
      }),
    });
    expect(html).toContain('Writer wants to email a@example.test and 2 others');
  });

  test('gmail send_draft: the recipient comes from the loaded draft', () => {
    const html = panel({
      details: call({
        action: 'gmail.send_draft',
        connector: 'gmail',
        args_preview: { draft_id: 'r-1' },
        resolved_preview: { to: 'sam@example.test', body: 'Draft body' },
      }),
    });
    expect(html).toContain('An agent wants to email sam@example.test');
  });

  test('github merge: "merge PR #n into {base}", and no base is never guessed', () => {
    expect(
      panel({
        agentName: 'Writer',
        details: call({
          args_preview: { repo: 'acme/web', pull_number: 482, base: 'main' },
        }),
      }),
    ).toContain('Writer wants to merge PR #482 into main');
    const noBase = panel({ agentName: 'Writer' });
    expect(noBase).toContain('Writer wants to merge PR #482');
    expect(noBase).not.toContain('default branch');
  });

  test('linear create_issue: "file a/an {priority}-priority issue for {team}", else "create an issue"', () => {
    const issue = (args: Record<string, unknown>) =>
      panel({
        agentName: 'Writer',
        details: call({
          action: 'linear.create_issue',
          connector: 'linear',
          args_preview: args,
        }),
      });
    expect(issue({ title: 'Bug', team: 'Platform', priority: 2 })).toContain(
      'Writer wants to file a High-priority issue for Platform',
    );
    expect(issue({ title: 'Bug', team: 'Platform', priority: 1 })).toContain(
      'Writer wants to file an Urgent-priority issue for Platform',
    );
    expect(issue({ title: 'Bug', team_id: 'team-uuid' })).toContain(
      'Writer wants to create an issue',
    );
  });

  test('every other action: the humanized action label, lowercased', () => {
    const html = panel({
      agentName: 'Writer',
      details: call({
        action: 'slack.post_message',
        connector: 'slack',
        args_preview: { channel: 'C1', text: 'hi' },
      }),
    });
    expect(html).toContain('Writer wants to post message');
  });

  test('no agent name: "An agent"', () => {
    expect(panel({})).toContain('An agent wants to merge PR #482');
  });
});

describe('ApprovalDecisionPanel header', () => {
  test('the connector and action, with the tool id as the tooltip', () => {
    const html = panel({ details: call({ connector_name: 'GitHub' }) });
    expect(html).toContain('GitHub · Merge pull request');
    expect(html).toContain('title="github.merge_pull_request"');
  });

  test('a connector the API names shows its own logo; an unknown one its first letter', () => {
    const named = panel({
      details: call({ connector_icon_url: 'https://cdn.example.test/gh.svg' }),
    });
    expect(named).toContain('https://cdn.example.test/gh.svg');
    expect(named).not.toContain('logos.composio.dev');
    expect(panel({})).toContain('logos.composio.dev/api/github');
    expect(panel({ details: call({ connector_icon_url: null }) })).not.toContain('<img');
  });

  test('expiry chip: < 6 h warns, ≥ 6 h is neutral, and the words stay ink', () => {
    const soon = panel({
      details: call({
        expires_at: new Date(Date.now() + 2 * HOUR + 15 * 60_000).toISOString(),
      }),
    });
    expect(soon).toMatch(/2h 1[45]m left/);
    expect(soon).toContain('bg-kortix-orange/15');
    expect(soon).toContain('text-kortix-orange');
    const later = panel({
      details: call({
        expires_at: new Date(Date.now() + 23 * HOUR + 30 * 60_000).toISOString(),
      }),
    });
    expect(later).toContain('23h left');
    expect(later).not.toContain('bg-kortix-orange/15');
    expect(later).toContain('bg-muted');
  });

  test('expiryChip: the words and the tone per window', () => {
    expect(expiryChip(38 * 60_000)).toEqual({
      key: 'leftMinutes',
      values: { minutes: 38 },
      warn: true,
    });
    expect(expiryChip(2 * HOUR + 14 * 60_000)).toEqual({
      key: 'leftHoursMinutes',
      values: { hours: 2, minutes: 14 },
      warn: true,
    });
    expect(expiryChip(6 * HOUR)).toEqual({
      key: 'leftHours',
      values: { hours: 6 },
      warn: false,
    });
    expect(expiryChip(72 * HOUR)).toEqual({
      key: 'leftDays',
      values: { days: 3 },
      warn: false,
    });
  });
});

describe('ApprovalDecisionPanel body', () => {
  test("the agent's description is a quotation with its info trigger; none, no line", () => {
    const html = panel({});
    expect(html).toContain('“Merge pull request #482 into main”');
    expect(html).toContain('About this description');
    expect(html).not.toContain('Agent&#x27;s description');
    expect(panel({ details: call({ approval_context: null }) })).not.toContain(
      'About this description',
    );
  });

  test('github merge: repo line, pull request title, merge method; no invented facts', () => {
    const html = panel({
      details: call({
        args_preview: {
          owner: 'acme',
          repo: 'web',
          pull_number: 482,
          merge_method: 'squash',
          head: 'fix/cache',
          base: 'main',
          sha: 'abc123',
        },
      }),
    });
    expect(html).toContain('acme/web');
    expect(html).toContain('Pull request #482');
    expect(html).toContain('fix/cache');
    expect(html).toContain('Squash and merge');
    // Arguments the card does not show stay visible under it.
    expect(html).toContain('>sha<');
    expect(html).toContain('abc123');
    expect(html).not.toContain('checks passing');
  });

  test('gmail: header rows, subject over the body, attachment tile with its size', () => {
    const html = panel({
      details: call({
        action: 'gmail.send_email',
        connector: 'gmail',
        args_preview: {
          to: 'reviewer@example.test',
          subject: 'Q3 launch notes',
          body: 'Hi, attached.',
          attachments: [{ name: 'q3.pdf', size: 245_760 }],
          reply_to: 'ops@example.test',
        },
      }),
    });
    expect(html).toContain('>To<');
    expect(html).toContain('Q3 launch notes');
    expect(html).toContain('Hi, attached.');
    expect(html).toContain('q3.pdf');
    expect(html).toMatch(/240\s?kB/);
    expect(html).not.toContain('>Cc<');
    expect(html).toContain('>reply_to<');
  });

  test('linear: team › New issue, title, description, property chips', () => {
    const html = panel({
      details: call({
        action: 'linear.create_issue',
        connector: 'linear',
        args_preview: {
          team: 'Platform',
          title: 'Session list skips archived projects',
          description: 'Steps',
          priority: 2,
          assignee: 'Sam Lee',
          labels: ['Bug'],
        },
      }),
    });
    expect(html).toContain('New issue');
    expect(html).toContain('Session list skips archived projects');
    expect(html).toContain('Sam Lee');
    expect(html).toContain('Bug');
    expect(html).toContain('High');
  });

  test('every other call keeps the key/value parameter list', () => {
    const html = panel({
      details: call({
        action: 'slack.post_message',
        args_preview: { channel: 'C1' },
      }),
    });
    expect(html).toContain('>channel<');
    expect(html).toContain('>Parameters<');
  });

  test('a call with no parameters shows no parameters section and stays decidable', () => {
    const html = panel({ details: call({ args_preview: null }) });
    expect(html).not.toContain('>Parameters<');
    expect(html).toContain('Approve and merge');
  });

  test('the old metadata table is gone', () => {
    const html = panel({});
    for (const word of ['>Run<', '>Tool<', '>Access<', '>Project<', '>Requested<', '>Expires<']) {
      expect(html).not.toContain(word);
    }
    expect(html).not.toContain('An agent needs your approval');
    expect(html).not.toContain('Growth research');
  });
});

describe('ApprovalDecisionPanel facts', () => {
  test('risk line per access level', () => {
    const destructive = panel({ details: call({ risk: 'destructive' }) });
    expect(destructive).toContain('Destructive · cannot be undone from Kortix');
    expect(destructive).toContain('text-kortix-red');
    expect(panel({})).toContain('Write access · merge pull request');
    expect(panel({ details: call({ risk: 'read' }) })).toContain('Read access');
    expect(panel({ details: call({ risk: null }) })).not.toContain('access');
  });

  test('asked by: agent, session (a link when it opens), expiry day', () => {
    const today = new Date();
    today.setHours(23, 59, 0, 0);
    const html = panel({
      agentName: 'Writer',
      sessionTitle: 'Q3 launch prep',
      onOpenSession: () => undefined,
      details: call({ expires_at: today.toISOString() }),
    });
    expect(html).toMatch(
      /Asked by Writer in <button[^>]*>Q3 launch prep<\/button> · expires Today /,
    );
    expect(panel({ sessionTitle: 'Q3 launch prep' })).toContain(
      'Asked by an agent in Q3 launch prep',
    );
    expect(panel({})).toContain('Asked by an agent · expires ');
    // A decided call no longer expires.
    expect(panel({ outcome: 'approve' })).not.toContain('expires');
  });
});

describe('ApprovalDecisionPanel decisions', () => {
  test('the note names the agent and Approve names what it does', () => {
    const html = panel({ agentName: 'Writer' });
    expect(html).toContain('Add a note for Writer (optional)');
    expect(html).toContain('Deny');
    expect(html).toContain('Approve and merge');
    expect(panel({})).toContain('Add a note for the agent (optional)');
    expect(
      panel({
        details: call({
          action: 'gmail.send_email',
          args_preview: { to: 'a@example.test', body: 'x' },
        }),
      }),
    ).toContain('Approve and send');
    expect(
      panel({
        details: call({
          action: 'linear.create_issue',
          args_preview: { title: 'x' },
        }),
      }),
    ).toContain('Approve and create');
    expect(
      panel({
        details: call({
          action: 'slack.post_message',
          args_preview: { text: 'x' },
        }),
      }),
    ).toMatch(/>Approve<\/button>/);
  });

  test('approved on this screen: the outcome chip, and the decisions are gone', () => {
    const html = panel({ outcome: 'approve' });
    expect(html).toContain('Action approved');
    expect(html).toContain('text-kortix-green');
    expect(html).not.toContain('Approve and merge');
    expect(html).not.toContain('Add a note');
    // The record of what was approved stays.
    expect(html).toContain('acme/web');
  });

  test('approved elsewhere: a reopened link shows the outcome, not buttons', () => {
    const html = panel({ details: call({ pending: false, status: 'ok' }) });
    expect(html).toContain('Action approved');
    expect(html).not.toContain('Approve and merge');
  });

  test('denied: the outcome chip with a different mark from approved', () => {
    for (const html of [
      panel({ outcome: 'deny' }),
      panel({ details: call({ pending: false, status: 'denied' }) }),
    ]) {
      expect(html).toContain('Action denied');
      expect(html).toContain('text-kortix-red');
      expect(html).not.toContain('text-kortix-green');
      expect(html).not.toContain('Deny</button>');
    }
  });

  test('unreviewable: no approve path, only deny, and the Alert says why', () => {
    const html = panel({
      details: call({ args_preview: null, review_complete: false }),
    });
    expect(html).toContain('Deny');
    expect(html).not.toContain('Approve and merge');
    expect(html).toContain('data-slot="alert"');
    expect(html).toContain('bg-kortix-orange/15');
    expect(html).toContain('cannot be reviewed here');
  });

  test('a viewer without argument visibility is told why', () => {
    const html = panel({
      details: call({ args_preview: null, review_complete: false }),
      previewAuthorized: false,
    });
    expect(html).not.toContain('Approve and merge');
    expect(html).toContain('data-slot="alert"');
    expect(html).not.toContain('No parameters were recorded');
  });

  test('a failed decision keeps the buttons and shows the reason', () => {
    const html = panel({ error: 'Could not record your decision.' });
    expect(html).toContain('Could not record your decision.');
    expect(html).toContain('Approve and merge');
  });

  test('no decision handler: the call reads, nothing can be decided, and it says who decides', () => {
    const html = panel({ onDecision: undefined });
    expect(html).toContain('acme/web');
    expect(html).not.toContain('Approve and merge');
    expect(html).not.toContain('Add a note');
    expect(html).toContain(
      'Waiting for the person who started this session or anyone who manages this project to approve or deny it.',
    );
    expect(panel({ onDecision: undefined, outcome: 'approve' })).not.toContain('Waiting for');
    expect(panel({ onDecision: undefined, resolvers: 'managers' })).toContain(
      'Waiting for anyone who manages this project to approve or deny it.',
    );
  });

  test('expired: the chip reads Expired, the Alert says what to do, and every control is off', () => {
    const html = panel({
      details: call({ status: 'expired', pending: false }),
    });
    expect(html).toContain('Expired');
    expect(html).not.toContain(' left<');
    expect(html).toContain('This approval expired. Ask the agent to request it again.');
    expect(html).toContain('data-slot="alert"');
    // Deny, Approve and the note: each one carries the disabled attribute.
    // The description's info trigger is not a decision control.
    const controls = (html.match(/<(button|textarea)[^>]*>/g) ?? []).filter(
      (tag) => !tag.includes('hover-card-trigger'),
    );
    expect(controls).toHaveLength(3);
    expect(controls.every((tag) => / disabled=""/.test(tag))).toBe(true);
  });

  test('expired, for a viewer who may not decide: the reason, and no decisions', () => {
    const html = panel({
      details: call({ status: 'expired', pending: false }),
      onDecision: undefined,
    });
    expect(html).toContain('This approval expired. Ask the agent to request it again.');
    expect(html).not.toContain('Approve and merge');
    expect(html).not.toContain('Waiting for');
  });
});
