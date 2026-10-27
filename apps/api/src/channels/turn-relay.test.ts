import { beforeEach, expect, mock, test } from 'bun:test';

let rows: unknown[][] = [];
const calls: string[] = [];
mock.module('../shared/db', () => ({ db: {
  select: () => ({ from: () => ({ where: () => ({ limit: async () => rows.shift() ?? [] }) }) }),
} }));
mock.module('./slack/turn', () => ({ relayTurnEnd: async () => { calls.push('slack'); return true; } }));
mock.module('./teams/turn', () => ({ relayTurnEnd: async () => { calls.push('teams'); return true; } }));
mock.module('./slack/questions', () => ({ postQuestion: async () => { calls.push('slack'); return { ok: true }; } }));
mock.module('./slack/review', () => ({ postReviewCard: async () => { calls.push('slack'); return { ok: true }; } }));
mock.module('./teams/questions', () => ({}));
mock.module('./teams/review', () => ({}));
const { relayReviewCard, relayTurnAnswerDetailed, relayTurnEnd, relayTurnQuestion, relayTurnStepDetailed } = await import('./turn-relay');
beforeEach(() => { rows = []; calls.length = 0; });

test('an error from a non-channel session is not a dropped Slack error', async () => {
  rows = [[], [{ metadata: { source: 'ui' } }]];
  expect(await relayTurnEnd('synthetic-session', 'error', { name: 'SyntheticError' })).toBe(false);
  expect(calls).toEqual([]);
});

test('a missing session has no channel to notify', async () => {
  rows = [[], []];
  expect(await relayTurnEnd('synthetic-session', 'error')).toBe(false);
  expect(calls).toEqual([]);
});

for (const platform of ['slack', 'teams']) {
  test(`${platform} live turns still receive errors`, async () => {
    rows = [[{ channelRef: { platform } }]];
    expect(await relayTurnEnd('synthetic-session', 'error')).toBe(true);
    expect(calls).toEqual([platform]);
  });
  test(`${platform} metadata preserves late error delivery`, async () => {
    rows = [[], [{ metadata: { source: platform } }]];
    expect(await relayTurnEnd('synthetic-session', 'error')).toBe(true);
    expect(calls).toEqual([platform]);
  });
}

test('legacy Slack live rows without channel_ref still receive errors', async () => {
  rows = [[{ channelRef: null }], []];
  expect(await relayTurnEnd('synthetic-session', 'error')).toBe(true);
  expect(calls).toEqual(['slack']);
});

for (const source of ['telegram', 'email']) {
  test(`a ${source} session is never handed to the Slack renderer`, async () => {
    const session = [{ metadata: { source } }];
    rows = [[], session];
    expect(await relayTurnEnd('synthetic-session', 'error')).toBe(false);
    rows = [[], session];
    expect(await relayTurnQuestion('synthetic-session', [])).toEqual({ ok: false, error: 'not_relayed' });
    rows = [[], session];
    expect(await relayTurnStepDetailed('synthetic-session', 'working')).toEqual({ ok: false, reason: 'not_relayed' });
    rows = [[], session];
    expect(await relayTurnAnswerDetailed('synthetic-session', 'done')).toEqual({ ok: false, reason: 'not_relayed' });
    rows = [[], session];
    expect(await relayReviewCard('synthetic-session', {} as never)).toEqual({ ok: false, error: 'not_relayed' });
    expect(calls).toEqual([]);
  });
}

test('an unknown session still falls back to the Slack renderer, as before', async () => {
  rows = [[], []];
  expect(await relayTurnQuestion('synthetic-session', [])).toEqual({ ok: true });
  expect(calls).toEqual(['slack']);
});

test('a Telegram session with a live Slack turn (it bound a Slack thread) still streams to Slack', async () => {
  rows = [[{ channelRef: null }], [{ metadata: { source: 'telegram', telegram: { chat_id: 1 } } }]];
  expect(await relayTurnEnd('synthetic-session', 'error')).toBe(true);
  rows = [[{ channelRef: null }], [{ metadata: { source: 'email', email: { thread_id: 't' } } }]];
  expect(await relayTurnQuestion('synthetic-session', [])).toEqual({ ok: true });
  expect(calls).toEqual(['slack', 'slack']);
});
