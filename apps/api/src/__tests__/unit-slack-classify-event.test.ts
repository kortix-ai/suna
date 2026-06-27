import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

// Regression guard for "@Kortix goes silent when re-tagged in an existing thread."
//
// Slack does NOT reliably deliver an `app_mention` for a mention made INSIDE an
// existing thread — notably a thread that predates the bot joining the channel.
// There the mention arrives ONLY as a plain `message` event (with `thread_ts`)
// via our `message.channels` / `message.groups` subscription. classifyEvent must
// treat a `message` that @-mentions the bot AS a mention; it previously discarded
// it (assuming an `app_mention` sibling that, in threads, never comes), so the bot
// answered only in fresh top-level threads. The exactly-once inboundMessageKey
// gate (keyed on the shared team/channel/ts) collapses the app_mention+message
// pair on the common top-level path, so honoring the message here never
// double-answers.

// ─── DB mock: FIFO of query results (only threadIsOwned touches the DB) ───────
let dbResults: unknown[][] = [];
function makeChain(): any {
  const chain: any = {};
  for (const m of ['from', 'where', 'limit']) chain[m] = () => chain;
  chain.then = (resolve: (rows: unknown[]) => unknown) => Promise.resolve(resolve(dbResults.shift() ?? []));
  return chain;
}
mock.module('../shared/db', () => ({
  db: { select: () => makeChain() },
  hasDatabase: () => true,
}));

// ─── Mocks so importing dispatch.ts (and its module graph) loads cleanly ──────
mock.module('../channels/slack/turn', () => ({
  claimFinalize: async () => true,
  openPlanMessage: async () => true,
  repaintLivePlan: async () => {},
  loadTurn: async () => null,
  startTurn: async () => ({ sessionId: '', channel: 'C1', token: 'xoxb', ts: '', steps: [] }),
  saveTurn: async () => {},
  deleteTurn: async () => {},
  finalizeTurn: async () => {},
  buildSlackTurnEnv: () => ({}),
  relayTurnAnswer: async () => {},
  relayTurnEnd: async () => {},
  relayTurnStep: async () => {},
  rowToHandle: () => ({ sessionId: '', channel: 'C1', token: 'xoxb', ts: '', steps: [] }),
}));
mock.module('../channels/install-store', () => ({
  loadSlackBotUserIdForProject: async () => 'B1',
  loadSlackTokenForProject: async () => 'xoxb-test',
  loadSlackSigningSecretForProject: async () => null,
  loadSlackTeamNameForProject: async () => null,
  listProjectsForWorkspace: async () => ['proj-1'],
  loadSlackInstall: async () => null,
}));
mock.module('../channels/slack-api', () => ({
  addReaction: async () => {},
  appendStream: async () => {},
  deleteMessage: async () => {},
  getChannelName: async () => 'general',
  joinChannel: async () => true,
  openDmChannel: async () => 'D1',
  postEphemeral: async () => true,
  postBlocks: async () => 'ts',
  postMessage: async () => 'ts',
  publishHomeView: async () => {},
  removeReaction: async () => {},
  startStream: async () => 'ts',
  stopStream: async () => {},
  updateBlocks: async () => {},
  updateMessage: async () => {},
}));

const { classifyEvent } = await import('../channels/slack/dispatch');

const BOT = 'B1';
const ev = (e: Record<string, unknown>) => ({ type: 'message', ...e }) as any;

afterAll(() => mock.restore());
beforeEach(() => {
  dbResults = [];
});

describe('classifyEvent — a message that @-mentions the bot is a mention', () => {
  test('THE FIX: message with the bot mention inside a thread → mention (was wrongly ignored)', async () => {
    const cls = await classifyEvent('T1', ev({ thread_ts: '90.0', channel_type: 'channel', text: '<@B1> do a thing' }), BOT);
    expect(cls).toBe('mention');
  });

  test('message with the bot mention at channel root → mention', async () => {
    const cls = await classifyEvent('T1', ev({ channel_type: 'channel', text: '<@B1> do a thing' }), BOT);
    expect(cls).toBe('mention');
  });

  test('a real app_mention event is still a mention', async () => {
    const cls = await classifyEvent('T1', { type: 'app_mention', thread_ts: '90.0', text: '<@B1> hi' } as any, BOT);
    expect(cls).toBe('mention');
  });

  test('an edited/system message (has a subtype) is ignored even if it contains the mention', async () => {
    const cls = await classifyEvent('T1', ev({ subtype: 'message_changed', thread_ts: '90.0', text: '<@B1> edited' }), BOT);
    expect(cls).toBe('ignore');
  });
});

describe('classifyEvent — non-mention routing is unchanged', () => {
  test('DM (im) message without a mention → dm', async () => {
    const cls = await classifyEvent('T1', ev({ channel_type: 'im', text: 'hello' }), BOT);
    expect(cls).toBe('dm');
  });

  test('thread reply without a mention, in an OWNED thread → follow_up', async () => {
    dbResults = [[{ id: 'thread-row' }]]; // threadIsOwned → found
    const cls = await classifyEvent('T1', ev({ thread_ts: '90.0', channel_type: 'channel', text: 'make it concise' }), BOT);
    expect(cls).toBe('follow_up');
  });

  test('thread reply without a mention, in an UNKNOWN thread → ignore (no chatter pickup)', async () => {
    dbResults = [[]]; // threadIsOwned → not found
    const cls = await classifyEvent('T1', ev({ thread_ts: '90.0', channel_type: 'channel', text: 'just chatting' }), BOT);
    expect(cls).toBe('ignore');
  });

  test('channel-root message without a mention → ignore', async () => {
    const cls = await classifyEvent('T1', ev({ channel_type: 'channel', text: 'random channel chatter' }), BOT);
    expect(cls).toBe('ignore');
  });

  test('a non-message, non-app_mention event → ignore', async () => {
    const cls = await classifyEvent('T1', { type: 'reaction_added', text: '<@B1>' } as any, BOT);
    expect(cls).toBe('ignore');
  });
});
