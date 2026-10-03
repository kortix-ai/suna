import { describe, expect, test } from 'bun:test';
import {
  APPROVAL_REPLY_CALLBACK,
  approvalActionId,
  buildApprovalCardBlocks,
  buildApprovalOutcomeBlocks,
  buildApprovalReplyView,
  parseApprovalActionId,
  readApprovalReply,
  slackUserIdsIn,
} from '../channels/slack/approval-card';

const EXEC = '0b0e7a52-6d1f-4a55-9f0e-3a3c3a1b2c4d';
const card = {
  executionId: EXEC,
  actionPath: 'gmail.send_draft',
  risk: 'write',
  argsPreview: { draft_id: 'r-1', access_token: '[redacted]' },
  approvalContext: 'Sends draft r-1 to buyer@example.test\nSubject: Re: Table pickup',
  approvalUrl: 'https://kortix.test/approve/ksl_x',
  approvable: true,
};

const text = (blocks: unknown[]) => JSON.stringify(blocks);
const actionIds = (blocks: unknown[]) =>
  (blocks as Array<{ type: string; elements?: Array<{ action_id?: string }> }>)
    .filter((b) => b.type === 'actions')
    .flatMap((b) => b.elements ?? [])
    .map((e) => e.action_id);

describe('approval card action ids', () => {
  test('round-trip every verb with a uuid execution id', () => {
    for (const verb of ['approve', 'deny', 'reply', 'view'] as const) {
      expect(parseApprovalActionId(approvalActionId(verb, EXEC))).toEqual({ verb, executionId: EXEC });
    }
  });

  test('ignore other action ids', () => {
    expect(parseApprovalActionId('review_approve_x')).toBeNull();
    expect(parseApprovalActionId('approval_merge_x')).toBeNull();
  });
});

describe('buildApprovalCardBlocks', () => {
  test("shows the agent's description as unverified, the parameters, and every decision", () => {
    const blocks = buildApprovalCardBlocks(card);
    const rendered = text(blocks);
    expect(rendered).toContain('gmail.send_draft');
    expect(rendered).toContain("Agent's description");
    expect(rendered).toContain('not verified');
    expect(rendered).toContain('> Sends draft r-1 to buyer@example.test');
    expect(rendered).toContain('`draft_id`  r-1');
    expect(rendered).toContain('hidden credential');
    expect(rendered).not.toContain('[redacted]');
    expect(actionIds(blocks)).toEqual([
      approvalActionId('approve', EXEC),
      approvalActionId('deny', EXEC),
      approvalActionId('reply', EXEC),
      approvalActionId('view', EXEC),
    ]);
  });

  test('offers no Approve when the call recorded nothing to review', () => {
    const blocks = buildApprovalCardBlocks({ ...card, argsPreview: null, approvable: false });
    expect(actionIds(blocks)).not.toContain(approvalActionId('approve', EXEC));
    expect(text(blocks)).toContain('can only be denied');
  });

  test('omits the description block when the agent gave none', () => {
    expect(text(buildApprovalCardBlocks({ ...card, approvalContext: null }))).not.toContain("Agent's description");
  });

  test('keeps every section under the 3000-character Slack limit', () => {
    const blocks = buildApprovalCardBlocks({
      ...card,
      approvalContext: 'x '.repeat(5_000),
      argsPreview: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, 'v'.repeat(400)])),
    }) as Array<{ text?: { text: string } }>;
    for (const block of blocks) expect((block.text?.text ?? '').length).toBeLessThan(3000);
  });
});

describe('buildApprovalOutcomeBlocks', () => {
  test('replaces the buttons with who decided and the message they sent', () => {
    const blocks = buildApprovalOutcomeBlocks({
      actionPath: 'gmail.send_draft',
      decision: 'deny',
      decidedBy: '<@U123>',
      note: 'Ask about Thursday instead.',
      approvalContext: null,
    });
    const rendered = text(blocks);
    expect(rendered).toContain('*Denied*');
    expect(rendered).toContain('<@U123>');
    expect(rendered).toContain('> Ask about Thursday instead.');
    expect(actionIds(blocks)).toEqual([]);
  });
});

describe('reply modal', () => {
  const meta = {
    executionId: EXEC,
    projectId: 'p',
    teamId: 'T1',
    channelId: 'C1',
    threadTs: '1.0',
    messageTs: '2.0',
  };

  test('defaults to Deny and carries the thread coordinates', () => {
    const view = buildApprovalReplyView('gmail.send_draft', meta) as {
      callback_id: string;
      private_metadata: string;
      blocks: Array<{ element?: { initial_option?: { value: string } } }>;
    };
    expect(view.callback_id).toBe(APPROVAL_REPLY_CALLBACK);
    expect(JSON.parse(view.private_metadata)).toEqual(meta);
    expect(view.blocks.find((b) => b.element?.initial_option)?.element?.initial_option?.value).toBe('deny');
  });

  test('reads the decision and the trimmed message', () => {
    expect(
      readApprovalReply({
        state: {
          values: {
            approval_decision_block: { approval_decision_input: { selected_option: { value: 'approve' } } },
            approval_note_block: { approval_note_input: { value: '  Send it.  ' } },
          },
        },
      }),
    ).toEqual({ decision: 'approve', note: 'Send it.' });
    expect(readApprovalReply({})).toEqual({ decision: 'deny', note: '' });
  });
});

// A Slack connector call showed `channel  C0…` and `user  U0…` on the card a
// person approves (2026-10-02): nobody can judge a post to an id. The id stays
// (it is the exact parameter); the name follows it.
describe('Slack ids in the parameters', () => {
  const args = { channel: 'C0TESTCHAN1', user: 'U0TESTUSER1', note: 'post in C0TESTCHAN1' };
  const parameterLines = (blocks: unknown[]) =>
    ((blocks as Array<{ text?: { text?: string } }>).find((b) => b.text?.text?.startsWith('*Parameters'))?.text?.text ?? '')
      .split('\n')
      .slice(1);

  test("a channel id gains a channel link, which Slack renders by each viewer's own access", () => {
    expect(parameterLines(buildApprovalCardBlocks({ ...card, argsPreview: args }))).toContain(
      '`channel`  C0TESTCHAN1 (<#C0TESTCHAN1>)',
    );
  });

  test('a user id gains the looked-up name as text, never a mention that pings them', () => {
    const lines = parameterLines(buildApprovalCardBlocks({ ...card, argsPreview: args }, new Map([['U0TESTUSER1', 'Sam <Rivera>']])));
    expect(lines).toContain('`user`  U0TESTUSER1 (Sam &lt;Rivera&gt;)');
    expect(lines.join('\n')).not.toContain('<@');
  });

  test('an unnamed user and an id inside other text stay as written', () => {
    const lines = parameterLines(buildApprovalCardBlocks({ ...card, argsPreview: args }));
    expect(lines).toContain('`user`  U0TESTUSER1');
    expect(lines).toContain('`note`  post in C0TESTCHAN1');
  });

  test('slackUserIdsIn lists the values that are exactly a user id', () => {
    expect(slackUserIdsIn(args)).toEqual(['U0TESTUSER1']);
    expect(slackUserIdsIn({ users: ['U0TESTUSER1'], n: 3 })).toEqual([]);
    expect(slackUserIdsIn(null)).toEqual([]);
  });
});
