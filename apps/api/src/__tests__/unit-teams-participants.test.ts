import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { chatIdentityStub } from './helpers/chat-identity-stub';

/**
 * Who may continue a Teams session — the Teams twin of the Slack join
 * policies. Slack whispers to the requester with an ephemeral; Teams has none,
 * so the verdict carries a `notice` for the requester's own live card and the
 * owner's Approve / Deny is a normal card.
 */

const TENANT = '36009a52-46d2-44bc-ba56-57a87e485e0a';
const CONV = '19:chan@thread.tacv2;messageid=1';
const REF = { serviceUrl: 'https://smba.trafficmanager.net/emea/', conversationId: CONV, tenantId: TENANT, projectId: 'p1' };

let selectQueue: unknown[][] = [];
let insertResult: unknown[] = [{ participantId: 'pp-1' }];
const ops: string[] = [];
const cards: unknown[] = [];
let identity: { userId: string } | null = { userId: 'owner-1' };
let updateResult: unknown[] = [{ participantId: 'pp-1' }];
let deciderMayWork = true;

function chain(result: unknown[]): any {
  const c: any = {};
  for (const m of ['from', 'innerJoin', 'where', 'limit', 'values', 'onConflictDoNothing', 'onConflictDoUpdate', 'returning', 'set']) c[m] = () => c;
  c.then = (resolve: (rows: unknown[]) => unknown) => Promise.resolve(resolve(result));
  c.catch = () => Promise.resolve(result);
  return c;
}

mock.module('../shared/db', () => ({
  hasDatabase: true,
  db: {
    select: () => {
      ops.push('select');
      return chain(selectQueue.length ? selectQueue.shift()! : []);
    },
    insert: () => {
      ops.push('insert');
      return chain(insertResult);
    },
    update: () => {
      ops.push('update');
      return chain(updateResult);
    },
  },
}));
mock.module('../config', () => ({ SANDBOX_VERSION: 'test', config: { FRONTEND_URL: 'https://dev.kortix.com' } }));
mock.module('../projects/lib/access', () => ({ lookupEmailsByUserIds: async () => new Map([['req-1', 'marko@example.com']]) }));
mock.module('../channels/teams-api', () => ({
  sendCard: async (_ref: unknown, card: unknown) => {
    cards.push(card);
    return 'card-1';
  },
}));
mock.module('../channels/core/identity', () =>
  chatIdentityStub({
    lookupChatIdentity: async () => identity,
    resolveProjectChatActor: async () => (deciderMayWork && identity ? { userId: identity.userId } : { reason: 'not_member' }),
  }),
);

const { ensureTeamsThreadParticipant, decideTeamsThreadJoin, policyFromMetadata, normalizeConversationPolicy } = await import(
  '../channels/teams/participants'
);

const base = {
  projectId: 'p1',
  tenantId: TENANT,
  conversationId: CONV,
  sessionId: 's1',
  sessionOwnerId: 'owner-1',
  sessionMetadata: null,
  channelPolicy: null,
  teamsUserId: 'aad-req',
  requesterName: 'Marko',
  actorUserId: 'req-1',
  ref: REF,
};

beforeEach(() => {
  selectQueue = [];
  insertResult = [{ participantId: 'pp-1' }];
  ops.length = 0;
  cards.length = 0;
  identity = { userId: 'owner-1' };
  updateResult = [{ participantId: 'pp-1' }];
  deciderMayWork = true;
});

afterAll(() => mock.restore());

describe('ensureTeamsThreadParticipant', () => {
  test('the owner is always allowed, without touching the table', async () => {
    expect(await ensureTeamsThreadParticipant({ ...base, actorUserId: 'owner-1' })).toEqual({ allowed: true });
    expect(ops).toEqual([]);
  });

  test('project_open (default): a linked member is granted and allowed', async () => {
    expect(await ensureTeamsThreadParticipant(base)).toEqual({ allowed: true });
    expect(ops).toEqual(['insert']);
  });

  test('owner_only: refused with a notice for the requester\'s card', async () => {
    const v = await ensureTeamsThreadParticipant({ ...base, channelPolicy: 'owner_only' });
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.notice).toMatch(/owner-only/);
    expect(cards).toHaveLength(0);
  });

  test('owner_approval, first ask: pending row, Approve/Deny card for the owner, "asked the owner" notice', async () => {
    selectQueue = [[]];
    const v = await ensureTeamsThreadParticipant({ ...base, channelPolicy: 'owner_approval' });
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.notice).toMatch(/asked the session owner/);
    expect(cards).toHaveLength(1);
    const card = cards[0] as { actions: Array<{ title: string; data: Record<string, unknown> }>; body: Array<{ text: string }> };
    expect(card.actions.map((a) => a.title)).toEqual(['Approve', 'Deny']);
    expect(card.actions[0].data).toMatchObject({ verb: 'teams_thread_join', decision: 'approved', sessionId: 's1', requesterUserId: 'req-1', requesterTeamsUserId: 'aad-req' });
    expect(card.body[0].text).toContain('marko@example.com');
  });

  test('owner_approval, asked again while pending: no second card, "still waiting"', async () => {
    selectQueue = [[{ participantId: 'pp-1', status: 'pending', userId: 'req-1', sessionId: 's1' }]];
    const v = await ensureTeamsThreadParticipant({ ...base, channelPolicy: 'owner_approval' });
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.notice).toMatch(/still waiting/);
    expect(cards).toHaveLength(0);
  });

  test('owner_approval, already approved: allowed and granted', async () => {
    selectQueue = [[{ participantId: 'pp-1', status: 'approved', userId: 'req-1', sessionId: 's1' }]];
    expect(await ensureTeamsThreadParticipant({ ...base, channelPolicy: 'owner_approval' })).toEqual({ allowed: true });
  });

  test('owner_approval, denied earlier: refused with the declined notice', async () => {
    selectQueue = [[{ participantId: 'pp-1', status: 'denied', userId: 'req-1', sessionId: 's1' }]];
    const v = await ensureTeamsThreadParticipant({ ...base, channelPolicy: 'owner_approval' });
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.notice).toMatch(/declined/);
  });

  test('the policy frozen on the session wins over the conversation\'s current one', async () => {
    const v = await ensureTeamsThreadParticipant({
      ...base,
      channelPolicy: 'project_open',
      sessionMetadata: { teams: { conversation_policy: 'owner_only' } },
    });
    expect(v.allowed).toBe(false);
  });
});

describe('decideTeamsThreadJoin', () => {
  const decision = {
    tenantId: TENANT,
    conversationId: CONV,
    deciderTeamsUserId: 'aad-owner',
    requesterTeamsUserId: 'aad-req',
    ref: REF,
  };
  const thread = [{ sessionId: 's1' }];
  const pending = [{ participantId: 'pp-1', status: 'pending', userId: 'req-1', sessionId: 's1' }];
  const session = [{ createdBy: 'owner-1', projectId: 'p1' }];

  test('someone who is not the session owner cannot decide', async () => {
    identity = { userId: 'other-2' };
    selectQueue = [thread, pending, session];
    const r = await decideTeamsThreadJoin({ ...decision, decision: 'approved' });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/Only the session owner/);
    expect(ops.filter((o) => o === 'insert' || o === 'update')).toHaveLength(0);
  });

  test('the owner approves: the request is approved, the account that asked is granted, and told to send again', async () => {
    selectQueue = [thread, pending, session];
    const r = await decideTeamsThreadJoin({ ...decision, decision: 'approved' });
    expect(r).toEqual({ ok: true, text: 'Approved marko@example.com for this Kortix session.' });
    expect(ops.filter((o) => o === 'update')).toHaveLength(1);
    expect(ops.filter((o) => o === 'insert')).toHaveLength(1);
    expect(JSON.stringify(cards[0])).toContain('Send your message again');
  });

  test('the owner denies: no grant, requester told', async () => {
    selectQueue = [thread, pending, session];
    const r = await decideTeamsThreadJoin({ ...decision, decision: 'denied' });
    expect(r.ok).toBe(true);
    expect(ops.filter((o) => o === 'insert')).toHaveLength(0);
    expect(JSON.stringify(cards[0])).toContain('declined');
  });

  test('an unlinked clicker is asked to /login first', async () => {
    identity = null;
    const r = await decideTeamsThreadJoin({ ...decision, decision: 'approved' });
    expect(r.ok).toBe(false);
    expect(r.text).toContain('/login');
  });

  // An agent can post any Adaptive Card. A look-alike Approve with no request
  // behind it, or one from an earlier session here, must grant nothing.
  test('a card with no pending request behind it changes nothing', async () => {
    selectQueue = [thread, []];
    expect(await decideTeamsThreadJoin({ ...decision, decision: 'approved' })).toEqual({ ok: false, text: 'This request is no longer open.' });
    expect(ops.filter((o) => o === 'insert' || o === 'update')).toHaveLength(0);
    expect(cards).toHaveLength(0);
  });

  test('a request raised for another session than the conversation\'s current one is not open', async () => {
    selectQueue = [thread, [{ ...pending[0], sessionId: 's-old' }]];
    expect((await decideTeamsThreadJoin({ ...decision, decision: 'approved' })).ok).toBe(false);
    expect(ops.filter((o) => o === 'insert' || o === 'update')).toHaveLength(0);
  });

  test('a request someone already decided is not decided twice', async () => {
    selectQueue = [thread, pending, session];
    updateResult = [];
    expect(await decideTeamsThreadJoin({ ...decision, decision: 'approved' })).toEqual({ ok: false, text: 'This request is no longer open.' });
    expect(ops.filter((o) => o === 'insert')).toHaveLength(0);
  });

  test('an owner who lost access to the project cannot approve anyone', async () => {
    deciderMayWork = false;
    selectQueue = [thread, pending, session];
    const r = await decideTeamsThreadJoin({ ...decision, decision: 'approved' });
    expect(r.ok).toBe(false);
    expect(r.text).toContain('no longer has access');
    expect(ops.filter((o) => o === 'insert' || o === 'update')).toHaveLength(0);
  });
});

describe('ensureTeamsThreadParticipant: a decision belongs to one session', () => {
  test('an approval from an earlier session here does not let the person into the current one', async () => {
    selectQueue = [[{ participantId: 'pp-1', status: 'approved', userId: 'req-1', sessionId: 's-old' }]];
    const v = await ensureTeamsThreadParticipant({ ...base, channelPolicy: 'owner_approval' });
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.notice).toMatch(/asked the session owner/);
    // The old row is reset to a pending request for the current session.
    expect(ops).toContain('update');
    expect(cards).toHaveLength(1);
  });
});

describe('policy helpers', () => {
  test('normalize + metadata', () => {
    expect(normalizeConversationPolicy('nonsense')).toBe('project_open');
    expect(policyFromMetadata({ teams: { conversation_policy: 'owner_only' } })).toBe('owner_only');
    expect(policyFromMetadata({ slack: { conversation_policy: 'owner_only' } })).toBeNull();
    expect(policyFromMetadata(null)).toBeNull();
  });
});
