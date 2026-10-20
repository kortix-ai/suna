import { beforeEach, expect, mock, test } from 'bun:test';

let rows: unknown[][] = [];
const calls: string[] = [];
mock.module('../shared/db', () => ({ db: {
  select: () => ({ from: () => ({ where: () => ({ limit: async () => rows.shift() ?? [] }) }) }),
} }));
mock.module('./slack/turn', () => ({ relayTurnEnd: async () => { calls.push('slack'); return true; } }));
mock.module('./teams/turn', () => ({ relayTurnEnd: async () => { calls.push('teams'); return true; } }));
mock.module('./slack/questions', () => ({}));
mock.module('./slack/review', () => ({}));
mock.module('./teams/questions', () => ({}));
mock.module('./teams/review', () => ({}));
const { relayTurnEnd } = await import('./turn-relay');
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
