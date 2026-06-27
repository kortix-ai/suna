import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

// Stage A of the Slack access-flow redesign: connecting your Kortix account is
// decoupled from having access, and a connected-but-no-access user requests
// access right in the thread (no DM wall). These tests pin (1) the action_id
// contract the interactivity router dispatches on, and (2) the branch logic of
// filing an access request.

// ─── DB mock: FIFO of query results ──────────────────────────────────────────
let dbResults: unknown[][] = [];
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
}));

const { connectAccountBlocks, requestAccessBlocks, createSlackAccessRequest } = await import(
  '../channels/slack/identity'
);

afterAll(() => mock.restore());
beforeEach(() => {
  dbResults = [];
});

// Pull the first button out of an actions block.
const firstButton = (blocks: any[]) =>
  blocks.find((b) => b.type === 'actions')?.elements?.find((e: any) => e.type === 'button');

describe('access nudge blocks — the action_id contract the router relies on', () => {
  test('connect block carries the login URL and the slack_login_connect action_id', () => {
    const btn = firstButton(connectAccountBlocks('https://kortix.com/login?x=1') as any[]);
    expect(btn.action_id).toBe('slack_login_connect');
    expect(btn.url).toBe('https://kortix.com/login?x=1');
  });

  test('request-access block carries slack_request_access and the projectId in its value', () => {
    const btn = firstButton(requestAccessBlocks('proj-1') as any[]);
    expect(btn.action_id).toBe('slack_request_access');
    expect(JSON.parse(btn.value)).toEqual({ projectId: 'proj-1' });
    expect(btn.url).toBeUndefined(); // it's an action button, not a link
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

  test('already a member → already-member (no request filed)', async () => {
    dbResults = [
      [{ userId: 'u1' }], // identity
      [{ accountId: 'a1' }], // project
      [{ userId: 'u1' }], // isAccountMember → member
    ];
    const r = await createSlackAccessRequest({ teamId: 'T1', slackUserId: 'U1', projectId: 'proj-1' });
    expect(r).toEqual({ status: 'already-member', requesterUserId: 'u1', accountId: 'a1' });
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
