import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { chatIdentityStub } from './helpers/chat-identity-stub';
import * as realAccess from '../projects/lib/access';

let dbResults: unknown[][] = [];
const inserts: unknown[] = [];
const ephemerals: Array<{ channel: string; user: string; text: string; blocks?: unknown[]; threadTs?: string }> = [];
let requesterHasEmail = true;

function makeChain(kind?: string): any {
  const chain: any = {};
  for (const m of ['from', 'where', 'limit', 'values', 'onConflictDoUpdate', 'onConflictDoNothing', 'set']) {
    chain[m] = (...args: unknown[]) => {
      if (kind === 'insert' && m === 'values') inserts.push(args[0]);
      return chain;
    };
  }
  chain.returning = () => chain;
  chain.then = (resolve: (rows: unknown[]) => unknown) => Promise.resolve(resolve(dbResults.shift() ?? []));
  return chain;
}

mock.module('../shared/db', () => ({
  db: {
    select: () => makeChain('select'),
    insert: () => makeChain('insert'),
    update: () => makeChain('update'),
  },
  hasDatabase: () => true,
}));

mock.module('../channels/install-store', () => ({
  loadSlackTokenForProject: async () => 'xoxb',
}));

mock.module('../channels/slack-api', () => ({
  postEphemeral: async (_token: string, channel: string, user: string, text: string, blocks?: unknown[], threadTs?: string) => {
    ephemerals.push({ channel, user, text, blocks, threadTs });
    return true;
  },
}));

// Spread the real module: `mock.module` replaces it WHOLESALE, so a stub that
// lists exports by hand deletes every export it omits — the failure surfaces in
// whatever unrelated file imports the missing name next, attributed to no test.
mock.module('../projects/lib/access', () => ({
  ...realAccess,
  lookupEmailsByUserIds: async (ids: string[]) =>
    new Map(requesterHasEmail ? ids.map((id) => [id, `${id}@example.com`]) : []),
}));

let deciderMayWork = true;
mock.module('../channels/core/identity', () =>
  chatIdentityStub({
  
  lookupChatIdentity: async (user: { platformUserId: string }) =>
    user.platformUserId === 'Uowner' ? { userId: 'owner-user' } : { userId: 'requester-user' },
  lookupChatUserForKortixUser: async (_platform: string, _teamId: string, userId: string) =>
    userId === 'owner-user' ? 'Uowner' : null,
  resolveProjectChatActor: async () => (deciderMayWork ? { userId: 'owner-user' } : { reason: 'not_member' }),
}),
);

const {
  decideSlackThreadJoin,
  ensureSlackThreadParticipant,
  normalizeConversationPolicy,
} = await import('../channels/slack/participants');

beforeEach(() => {
  dbResults = [];
  inserts.length = 0;
  ephemerals.length = 0;
  deciderMayWork = true;
  requesterHasEmail = true;
});

/** The mrkdwn of the owner's approval card: its first section. */
function ownerCardText(): string {
  const blocks = ephemerals[1]?.blocks as Array<{ text?: { text?: string } }> | undefined;
  return blocks?.[0]?.text?.text ?? '';
}

describe('Slack thread participants', () => {
  test('unknown policy defaults to project-open sharing', () => {
    expect(normalizeConversationPolicy('wat')).toBe('project_open');
  });

  test('session owner is allowed without a participant request', async () => {
    const allowed = await ensureSlackThreadParticipant({
      projectId: 'proj-1',
      teamId: 'T1',
      channel: 'C1',
      threadId: '90.0',
      sessionId: 'sess-1',
      sessionOwnerId: 'owner-user',
      sessionMetadata: { slack: { conversation_policy: 'owner_approval' } },
      channelPolicy: null,
      slackUserId: 'Uowner',
      actorUserId: 'owner-user',
    });

    expect(allowed).toBe(true);
    expect(inserts).toHaveLength(0);
    expect(ephemerals).toHaveLength(0);
  });

  test('owner approval blocks an unapproved participant and posts Slack approval UI', async () => {
    dbResults = [
      [], // approvedParticipantExists
      [], // loadParticipant
      [{ participantId: 'p1' }], // insert pending
    ];

    const allowed = await ensureSlackThreadParticipant({
      projectId: 'proj-1',
      teamId: 'T1',
      channel: 'C1',
      threadId: '90.0',
      sessionId: 'sess-1',
      sessionOwnerId: 'owner-user',
      sessionMetadata: { slack: { conversation_policy: 'owner_approval' } },
      channelPolicy: null,
      slackUserId: 'Urequester',
      actorUserId: 'requester-user',
    });

    expect(allowed).toBe(false);
    expect(inserts[0]).toMatchObject({
      workspaceId: 'T1',
      threadId: '90.0',
      sessionId: 'sess-1',
      platformUserId: 'Urequester',
      userId: 'requester-user',
      status: 'pending',
    });
    expect(ephemerals.map((e) => e.user)).toEqual(['Urequester', 'Uowner']);
    expect(ephemerals[0]?.text).toContain('asked the session owner');
    expect(ephemerals[1]?.text).toContain('wants to join');
  });

  // The owner's card printed `<@U…>` as literal text (2026-10-02): the label
  // went through `escapeMrkdwn`, which turns a mention into `&lt;@U…&gt;`.
  // A live mention is Slack's own label: every client shows the person's name.
  const requestJoin = () => {
    dbResults = [[], [], [{ participantId: 'p1' }]];
    return ensureSlackThreadParticipant({
      projectId: 'proj-1',
      teamId: 'T1',
      channel: 'C1',
      threadId: '90.0',
      sessionId: 'sess-1',
      sessionOwnerId: 'owner-user',
      sessionMetadata: { slack: { conversation_policy: 'owner_approval' } },
      channelPolicy: null,
      slackUserId: 'Urequester',
      actorUserId: 'requester-user',
    });
  };

  test("the owner's card names the requester with a live Slack mention and their Kortix email", async () => {
    await requestJoin();
    expect(ownerCardText()).toStartWith('*<@Urequester> (requester-user@example.com)* wants to join');
    expect(ephemerals[1]?.text).toStartWith('<@Urequester> (requester-user@example.com) wants to join');
  });

  test('a requester with no Kortix email is still a live mention, never escaped markup', async () => {
    requesterHasEmail = false;
    await requestJoin();
    expect(ownerCardText()).toStartWith('*<@Urequester>* wants to join');
    expect(ownerCardText()).not.toContain('&lt;');
  });

  const pendingRequest = { participantId: 'p1', status: 'pending', userId: 'requester-user', sessionId: 'sess-1' };
  const decide = (decision: 'approved' | 'denied' = 'approved') =>
    decideSlackThreadJoin({
      teamId: 'T1',
      channelId: 'C1',
      deciderSlackUserId: 'Uowner',
      sessionId: 'sess-1',
      threadId: '90.0',
      requesterSlackUserId: 'Urequester',
      decision,
    });

  test('approving a pending request stores approval and grants the account that asked', async () => {
    dbResults = [
      [pendingRequest], // the pending request
      [{ createdBy: 'owner-user', projectId: 'proj-1' }], // projectSessions lookup
      [{ participantId: 'p1' }], // pending → approved
      [], // projectSessionGrants insert
    ];

    const result = await decide();

    expect(result).toEqual({ ok: true, text: 'Approved <@Urequester> (requester-user@example.com) for this Kortix session.' });
    expect(inserts[0]).toMatchObject({ sessionId: 'sess-1', principalType: 'member', principalId: 'requester-user' });
    expect(ephemerals[0]?.user).toBe('Urequester');
    expect(ephemerals[0]?.text).toContain('approved');
  });

  // An agent can post any button through the bot. A look-alike Approve with no
  // request behind it, or one from an earlier session in the thread, grants
  // nothing, and the grant never goes to an account the value names.
  test('a button with no pending request behind it changes nothing', async () => {
    dbResults = [[]];
    expect(await decide()).toEqual({ ok: false, text: 'This request is no longer open.' });
    expect(inserts).toEqual([]);
    expect(ephemerals).toEqual([]);
  });

  test('a request raised for an earlier session in the thread is not open', async () => {
    dbResults = [[{ ...pendingRequest, sessionId: 'sess-old' }]];
    expect(await decide()).toEqual({ ok: false, text: 'This request is no longer open.' });
    expect(inserts).toEqual([]);
  });

  test('a request someone already decided is not decided again', async () => {
    dbResults = [[{ ...pendingRequest, status: 'approved' }]];
    expect(await decide('denied')).toEqual({ ok: false, text: 'This request is no longer open.' });
  });

  test('an owner who lost access to the project cannot approve anyone', async () => {
    deciderMayWork = false;
    dbResults = [[pendingRequest], [{ createdBy: 'owner-user', projectId: 'proj-1' }]];
    const result = await decide();
    expect(result.ok).toBe(false);
    expect(result.text).toContain('no longer has access');
    expect(inserts).toEqual([]);
  });

  test('owner-only blocks linked project members without creating an approval request', async () => {
    const allowed = await ensureSlackThreadParticipant({
      projectId: 'proj-1',
      teamId: 'T1',
      channel: 'C1',
      threadId: '90.0',
      sessionId: 'sess-1',
      sessionOwnerId: 'owner-user',
      sessionMetadata: { slack: { conversation_policy: 'owner_only' } },
      channelPolicy: null,
      slackUserId: 'Urequester',
      actorUserId: 'requester-user',
    });

    expect(allowed).toBe(false);
    expect(inserts).toHaveLength(0);
    expect(ephemerals).toHaveLength(1);
    expect(ephemerals[0]).toMatchObject({
      channel: 'C1',
      user: 'Urequester',
      text: 'This Kortix session is owner-only.',
      threadTs: '90.0',
    });
  });

  test('previously denied participant stays blocked and is told to start a new thread', async () => {
    dbResults = [
      [], // approvedParticipantExists
      [{ participantId: 'p1', status: 'denied', userId: 'requester-user', sessionId: 'sess-1' }], // loadParticipant
    ];

    const allowed = await ensureSlackThreadParticipant({
      projectId: 'proj-1',
      teamId: 'T1',
      channel: 'C1',
      threadId: '90.0',
      sessionId: 'sess-1',
      sessionOwnerId: 'owner-user',
      sessionMetadata: { slack: { conversation_policy: 'owner_approval' } },
      channelPolicy: null,
      slackUserId: 'Urequester',
      actorUserId: 'requester-user',
    });

    expect(allowed).toBe(false);
    expect(inserts).toHaveLength(0);
    expect(ephemerals).toHaveLength(1);
    expect(ephemerals[0]?.text).toContain('declined your request');
  });

  test('project_open explicitly grants linked project members without owner approval', async () => {
    dbResults = [[]]; // projectSessionGrants insert

    const allowed = await ensureSlackThreadParticipant({
      projectId: 'proj-1',
      teamId: 'T1',
      channel: 'C1',
      threadId: '90.0',
      sessionId: 'sess-1',
      sessionOwnerId: 'owner-user',
      sessionMetadata: { slack: { conversation_policy: 'project_open' } },
      channelPolicy: null,
      slackUserId: 'Urequester',
      actorUserId: 'requester-user',
    });

    expect(allowed).toBe(true);
    expect(inserts[0]).toMatchObject({ sessionId: 'sess-1', principalType: 'member', principalId: 'requester-user' });
  });
});

// A thread keeps one participant row per person across sessions. A decision
// from an earlier session must not carry over to the next session's owner.
describe('Slack thread participants: a decision belongs to one session', () => {
  test('a denial from an earlier session becomes a new request for the current one', async () => {
    dbResults = [
      [], // approvedParticipantExists (current session only)
      [{ participantId: 'p1', status: 'denied', userId: 'requester-user', sessionId: 'sess-old' }], // loadParticipant
      [], // reset the row to pending for sess-1
    ];
    const allowed = await ensureSlackThreadParticipant({
      projectId: 'proj-1',
      teamId: 'T1',
      channel: 'C1',
      threadId: '90.0',
      sessionId: 'sess-1',
      sessionOwnerId: 'owner-user',
      sessionMetadata: { slack: { conversation_policy: 'owner_approval' } },
      channelPolicy: null,
      slackUserId: 'Urequester',
      actorUserId: 'requester-user',
    });
    expect(allowed).toBe(false);
    expect(ephemerals.map((e) => e.user)).toEqual(['Urequester', 'Uowner']);
    expect(ephemerals[0]?.text).not.toContain('declined');
  });
});
