import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

// Stage A of the Slack access-flow redesign: connecting your Kortix account is
// decoupled from having access, and a connected-but-no-access user requests
// access right in the thread (no DM wall). These tests pin (1) the action_id
// contract the interactivity router dispatches on, and (2) the branch logic of
// filing an access request.

// ─── DB mock: FIFO of query results ──────────────────────────────────────────
let dbResults: unknown[][] = [];
let authorizeAllowed = true;
let sentBlocks: Array<{ channel: string; text: string; blocks: any[] }> = [];
let ephemeralCalls = 0;
let openDmCalls = 0;
function makeChain(): any {
  const chain: any = {};
  for (const m of ['from', 'where', 'limit', 'values', 'returning', 'onConflictDoNothing', 'onConflictDoUpdate', 'set']) {
    chain[m] = () => chain;
  }
  chain.then = (resolve: (rows: unknown[]) => unknown) => Promise.resolve(resolve(dbResults.shift() ?? []));
  return chain;
}
mock.module('../shared/db', () => ({
  db: { select: () => makeChain(), insert: () => makeChain(), update: () => makeChain() },
  hasDatabase: () => true,
}));

// lookupEmailsByUserIds hits Supabase — mock it so the 'created' path stays offline.
mock.module('../projects/lib/access', () => ({
  lookupEmailsByUserIds: async () => new Map<string, string | null>(),
  grantProjectRole: async () => {},
  ensureOrgMembership: async () => 'member',
  loadProjectForUser: async () => null,
}));
mock.module('../iam', () => ({
  authorize: async () => ({ allowed: authorizeAllowed }),
}));
mock.module('../channels/install-store', () => ({
  loadSlackTokenForProject: async () => 'xoxb-test',
}));
mock.module('../channels/slack-api', () => ({
  openDmChannel: async () => {
    openDmCalls++;
    return 'D1';
  },
  postBlocks: async (_token: string, channel: string, text: string, blocks: any[]) => {
    sentBlocks.push({ channel, text, blocks });
    return 'ts';
  },
  postEphemeral: async () => {
    ephemeralCalls++;
    return true;
  },
}));

const {
  connectAccountBlocks,
  requestAccessBlocks,
  createSlackAccessRequest,
  notifyAdminsOfAccessRequest,
  postIdentityPrompt,
} = await import(
  '../channels/slack/identity'
);

afterAll(() => mock.restore());
beforeEach(() => {
  dbResults = [];
  authorizeAllowed = true;
  sentBlocks = [];
  ephemeralCalls = 0;
  openDmCalls = 0;
});

// Pull the first button out of an actions block.
const firstButton = (blocks: any[]) =>
  blocks.find((b) => b.type === 'actions')?.elements?.find((e: any) => e.type === 'button');

describe('access nudge blocks — the action_id contract the router relies on', () => {
  test('connect block carries the login URL and the slack_login_connect action_id', () => {
    const btn = firstButton(connectAccountBlocks('https://kortix.com/login?x=1', 'pending-1') as any[]);
    expect(btn.action_id).toBe('slack_login_connect');
    expect(btn.url).toBeUndefined();
    expect(JSON.parse(btn.value)).toEqual({ url: 'https://kortix.com/login?x=1', pendingId: 'pending-1' });
  });

  test('request-access block carries slack_request_access and the projectId in its value', () => {
    const btn = firstButton(requestAccessBlocks('proj-1') as any[]);
    expect(btn.action_id).toBe('slack_request_access');
    expect(JSON.parse(btn.value)).toEqual({ projectId: 'proj-1' });
    expect(btn.url).toBeUndefined(); // it's an action button, not a link
  });
});

describe('postIdentityPrompt — never invisible: in-thread ephemeral AND a DM', () => {
  test('not_member prompt posts BOTH an ephemeral and a DM', async () => {
    await postIdentityPrompt({
      projectId: 'proj-1',
      teamId: 'T1',
      channel: 'C1',
      threadTs: '90.0',
      slackUserId: 'U1',
      reason: 'not_member',
    });
    expect(ephemeralCalls).toBe(1); // in-thread notice
    expect(openDmCalls).toBe(1);
    expect(sentBlocks).toHaveLength(1); // the DM (the part you can't miss)
  });

  test('still DMs even with no channel to post the ephemeral into', async () => {
    await postIdentityPrompt({
      projectId: 'proj-1',
      teamId: 'T1',
      slackUserId: 'U1',
      reason: 'not_member',
    });
    expect(ephemeralCalls).toBe(0);
    expect(sentBlocks).toHaveLength(1);
  });
});

describe('createSlackAccessRequest — file (or find) a project access request', () => {
  test('unlinked Slack user → no-identity (nothing to request as)', async () => {
    dbResults = [[]]; // lookupSlackIdentity → none
    const r = await createSlackAccessRequest({ teamId: 'T1', slackUserId: 'U1', projectId: 'proj-1' });
    expect(r.status).toBe('no-identity');
  });

  test('unknown project → no-project', async () => {
    dbResults = [[{ userId: 'u1' }], []]; // identity ok, project missing
    const r = await createSlackAccessRequest({ teamId: 'T1', slackUserId: 'U1', projectId: 'proj-1' });
    expect(r.status).toBe('no-project');
  });

  test('already project-write-capable → already-member (no request filed)', async () => {
    dbResults = [
      [{ userId: 'u1' }], // identity
      [{ accountId: 'a1' }], // project
      [{ userId: 'u1' }], // isAccountMember → member
    ];
    const r = await createSlackAccessRequest({ teamId: 'T1', slackUserId: 'U1', projectId: 'proj-1' });
    expect(r).toEqual({ status: 'already-member', requesterUserId: 'u1', accountId: 'a1' });
  });

  test('org member without project write can still request Slack access', async () => {
    authorizeAllowed = false;
    dbResults = [
      [{ userId: 'u1' }], // identity
      [{ accountId: 'a1' }], // project
      [{ userId: 'u1' }], // isAccountMember → member
      [], // no existing pending
      [], // insert
    ];
    const r = await createSlackAccessRequest({ teamId: 'T1', slackUserId: 'U1', projectId: 'proj-1' });
    expect(r).toEqual({ status: 'created', requesterUserId: 'u1', accountId: 'a1' });
  });

  test('already has a pending request → pending (idempotent, no duplicate)', async () => {
    dbResults = [
      [{ userId: 'u1' }], // identity
      [{ accountId: 'a1' }], // project
      [], // not a member
      [{ requestId: 'r1' }], // existing pending request
    ];
    const r = await createSlackAccessRequest({ teamId: 'T1', slackUserId: 'U1', projectId: 'proj-1' });
    expect(r).toEqual({ status: 'pending', requesterUserId: 'u1', accountId: 'a1' });
  });

  test('connected non-member, none pending → created', async () => {
    dbResults = [
      [{ userId: 'u1' }], // identity
      [{ accountId: 'a1' }], // project
      [], // not a member
      [], // no existing pending
      [], // insert
    ];
    const r = await createSlackAccessRequest({ teamId: 'T1', slackUserId: 'U1', projectId: 'proj-1' });
    expect(r).toEqual({ status: 'created', requesterUserId: 'u1', accountId: 'a1' });
  });
});

describe('notifyAdminsOfAccessRequest', () => {
  test('links admins directly to the project Members review surface', async () => {
    dbResults = [
      [{ name: 'Slack Auth' }], // email notification project lookup
      [{ userId: 'admin-1' }], // email notification account managers
      [], // email notification explicit project managers
      [{ userId: 'admin-1' }], // Slack DM account admins
      [{ slackUserId: 'UADMIN' }], // lookupSlackUserIdForKortixUser
    ];

    await notifyAdminsOfAccessRequest({
      teamId: 'T1',
      projectId: 'proj-1',
      accountId: 'acct-1',
      requesterUserId: 'user-1',
      requesterSlackUserId: 'UREQ',
    });

    const button = firstButton(sentBlocks[0]?.blocks ?? []);
    expect(sentBlocks[0]?.channel).toBe('D1');
    expect(button.url).toBe('http://localhost:3000/projects/proj-1/customize/members');
  });
});
