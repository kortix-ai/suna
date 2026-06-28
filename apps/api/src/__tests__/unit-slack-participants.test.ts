import { beforeEach, describe, expect, mock, test } from 'bun:test';

let dbResults: unknown[][] = [];
const inserts: unknown[] = [];
const ephemerals: Array<{ channel: string; user: string; text: string; threadTs?: string }> = [];

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
  postEphemeral: async (_token: string, channel: string, user: string, text: string, _blocks?: unknown[], threadTs?: string) => {
    ephemerals.push({ channel, user, text, threadTs });
    return true;
  },
}));

mock.module('../projects/lib/access', () => ({
  lookupEmailsByUserIds: async (ids: string[]) => new Map(ids.map((id) => [id, `${id}@example.com`])),
}));

mock.module('../channels/slack/identity', () => ({
  lookupSlackIdentity: async (_teamId: string, slackUserId: string) =>
    slackUserId === 'Uowner' ? { userId: 'owner-user' } : { userId: 'requester-user' },
  lookupSlackUserIdForKortixUser: async (_teamId: string, userId: string) =>
    userId === 'owner-user' ? 'Uowner' : null,
}));

const {
  decideSlackThreadJoin,
  ensureSlackThreadParticipant,
  normalizeConversationPolicy,
} = await import('../channels/slack/participants');

beforeEach(() => {
  dbResults = [];
  inserts.length = 0;
  ephemerals.length = 0;
});

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

  test('approving a participant stores approval and grants the session member', async () => {
    dbResults = [
      [{ createdBy: 'owner-user' }], // projectSessions lookup
      [], // participant upsert
      [], // projectSessionGrants insert
    ];

    const result = await decideSlackThreadJoin({
      teamId: 'T1',
      channelId: 'C1',
      deciderSlackUserId: 'Uowner',
      projectId: 'proj-1',
      sessionId: 'sess-1',
      threadId: '90.0',
      requesterUserId: 'requester-user',
      requesterSlackUserId: 'Urequester',
      decision: 'approved',
    });

    expect(result).toEqual({ ok: true, text: 'Approved requester-user@example.com for this Kortix session.' });
    expect(inserts[0]).toMatchObject({ status: 'approved', sessionId: 'sess-1' });
    expect(inserts[1]).toMatchObject({ sessionId: 'sess-1', principalType: 'member', principalId: 'requester-user' });
    expect(ephemerals[0]?.user).toBe('Urequester');
    expect(ephemerals[0]?.text).toContain('approved');
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
      [{ status: 'denied', userId: 'requester-user' }], // loadParticipant
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
