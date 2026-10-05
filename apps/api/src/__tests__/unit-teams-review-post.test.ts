import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

const SESSION_ID = 'sess-review';

let turn: Record<string, unknown> | null = null;
const finalized: Array<Record<string, unknown>> = [];
let ownedRef: Record<string, unknown> | null = null;
mock.module('../channels/teams/turn', () => ({
  loadTurn: async () => turn,
  conversationRefForSession: async () => ownedRef,
  finalizeTurn: async (_h: unknown, opts: Record<string, unknown>) => {
    finalized.push(opts);
  },
  deleteTurn: async () => {},
  markTurnReplied: async () => {},
}));

let cardOk = true;
let textOk = true;
const texts: string[] = [];
mock.module('../channels/teams-api', () => ({
  sendCard: async () => (cardOk ? 'activity-1' : null),
  sendText: async (_ref: unknown, text: string) => {
    texts.push(text);
    return textOk ? 'activity-2' : null;
  },
}));

const ITEM = {
  review_item_id: 'ri_1',
  title: 'Delete the staging bucket',
  summary: 'Removes 400 objects',
  risk: 'high',
};

const load = async () => await import('../channels/teams/review');

beforeEach(() => {
  turn = {
    sessionId: SESSION_ID,
    serviceUrl: 'https://smba.trafficmanager.net/emea/',
    conversationId: '19:abc@thread.tacv2',
    tenantId: 'tenant-1',
    projectId: 'proj-1',
    steps: [],
    finalized: false,
  };
  finalized.length = 0;
  texts.length = 0;
  cardOk = true;
  textOk = true;
});

afterEach(() => {
  mock.restore();
});

describe('postTeamsReviewCard', () => {
  test('the live card does NOT close as "Task complete" — a decision is pending', async () => {
    const { postTeamsReviewCard } = await load();

    await postTeamsReviewCard(SESSION_ID, ITEM as never);

    expect(finalized).toEqual([{ title: 'Waiting for your decision', unfinished: true }]);
  });

  test('a rejected card falls back to text instead of losing the review', async () => {
    // The turn is already closed and deleted by this point, so without the
    // fallback the user is left looking at "Waiting for your decision" with
    // nothing to decide on.
    cardOk = false;
    const { postTeamsReviewCard } = await load();

    const res = await postTeamsReviewCard(SESSION_ID, ITEM as never);

    expect(res.ok).toBe(true);
    expect(texts[0]).toContain('Delete the staging bucket');
    expect(texts[0]).toContain('Removes 400 objects');
    expect(texts[0]).toContain('Risk · high');
    expect(texts[0]).toContain('/projects/proj-1/review');
  });

  test('only a card AND text both failing is reported as a failure', async () => {
    cardOk = false;
    textOk = false;
    const { postTeamsReviewCard } = await load();

    const res = await postTeamsReviewCard(SESSION_ID, ITEM as never);

    expect(res.ok).toBe(false);
    expect(res.error).toContain('Failed to post the review card');
  });

  test('a risk of none is left out of the fallback rather than printed as "none"', async () => {
    cardOk = false;
    const { postTeamsReviewCard } = await load();

    await postTeamsReviewCard(SESSION_ID, { ...ITEM, risk: 'none' } as never);

    expect(texts[0]).not.toContain('Risk ·');
  });

  test('no live turn and no conversation is an error, and nothing is finalized', async () => {
    turn = null;
    ownedRef = null;
    const { postTeamsReviewCard } = await load();

    const res = await postTeamsReviewCard(SESSION_ID, ITEM as never);

    expect(res.ok).toBe(false);
    expect(finalized).toEqual([]);
  });

  test('a review filed by a prompt with no card still reaches its conversation', async () => {
    turn = null;
    ownedRef = { serviceUrl: 'https://smba.trafficmanager.net/emea/', conversationId: 'a:synthetic-chat', tenantId: 'tenant-1', projectId: 'proj-1' };
    const { postTeamsReviewCard } = await load();

    const res = await postTeamsReviewCard(SESSION_ID, ITEM as never);

    expect(res.ok).toBe(true);
    expect(finalized).toEqual([]);
    ownedRef = null;
  });
});
