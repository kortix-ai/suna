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
const realInstallStore = await import('../channels/install-store');
mock.module('../channels/install-store', () => ({
  ...realInstallStore,
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
  isBotUser: async () => true,
  findBotUserIdByName: async () => null,
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

  test('file_share with no files is ignored', async () => {
    const cls = await classifyEvent('T1', ev({ subtype: 'file_share', channel_type: 'im', text: '' }), BOT);
    expect(cls).toBe('ignore');
  });

  test('file_share with files in a DM passes through', async () => {
    const cls = await classifyEvent('T1', ev({ subtype: 'file_share', channel_type: 'im', text: '', files: [{ id: 'F1', mimetype: 'audio/wav', name: 'voice-message.wav', size: 12345, url_private_download: 'https://...' }] }), BOT);
    expect(cls).toBe('dm');
  });

  test('file_share with files in a channel passes through', async () => {
    const cls = await classifyEvent('T1', ev({ subtype: 'file_share', channel_type: 'channel', text: 'listen to this', files: [{ id: 'F1', mimetype: 'audio/mp4', name: 'audio.m4a', size: 54321, url_private_download: 'https://...' }] }), BOT);
    expect(cls).toBe('ignore');
  });

  test('file_share with files and a bot mention is a mention', async () => {
    const cls = await classifyEvent('T1', ev({ subtype: 'file_share', channel_type: 'channel', text: '<@B1> transcribe this', files: [{ id: 'F1', mimetype: 'audio/wav', name: 'voice.wav', size: 9999, url_private_download: 'https://...' }] }), BOT);
    expect(cls).toBe('mention');
  });

  test('me_message in a DM is a dm', async () => {
    const cls = await classifyEvent('T1', ev({ subtype: 'me_message', channel_type: 'im', text: 'waves hello' }), BOT);
    expect(cls).toBe('dm');
  });

  test('me_message with a bot mention is a mention', async () => {
    const cls = await classifyEvent('T1', ev({ subtype: 'me_message', channel_type: 'channel', text: '<@B1> laughs at your joke' }), BOT);
    expect(cls).toBe('mention');
  });

  test('me_message in a channel without mention is ignored (no pickup)', async () => {
    const cls = await classifyEvent('T1', ev({ subtype: 'me_message', channel_type: 'channel', text: 'waves goodbye' }), BOT);
    expect(cls).toBe('ignore');
  });

test('bot_message in a DM is a dm', async () => {
    const cls = await classifyEvent('T1', ev({ subtype: 'bot_message', channel_type: 'im', text: 'hello from another bot', bot_id: 'B999' }), BOT);
    expect(cls).toBe('dm');
  });

  test('bot_message with a bot mention is a mention', async () => {
    const cls = await classifyEvent('T1', ev({ subtype: 'bot_message', channel_type: 'channel', text: '<@B1> analyze this report', bot_id: 'B999' }), BOT);
    expect(cls).toBe('mention');
  });

  test('bot_message without mention in a channel is ignored (no pickup)', async () => {
    const cls = await classifyEvent('T1', ev({ subtype: 'bot_message', channel_type: 'channel', text: 'other bot chatter', bot_id: 'B999' }), BOT);
    expect(cls).toBe('ignore');
  });

  test('other subtypes like thread_broadcast are still ignored', async () => {
    const cls = await classifyEvent('T1', ev({ subtype: 'thread_broadcast', channel_type: 'channel', text: 'broadcast' }), BOT);
    expect(cls).toBe('ignore');
  });

  test('other subtypes like message_changed are still ignored', async () => {
    const cls = await classifyEvent('T1', ev({ subtype: 'message_changed', channel_type: 'channel', text: 'edited' }), BOT);
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

// ─── THE 2026-08-20 WRONG-BOT REPLY ──────────────────────────────────────────
//
// A user typed `@Kortix hey man` in a channel that also contains the "Incident
// reporter" bot, and Incident reporter answered:
//
//   mentioned bot    U0B7QL26690  (Kortix)
//   bot that replied U0B5W5XN49Y  (Incident reporter)
//   session created  inside kortix-incident-reporter
//
// Two Kortix-platform apps in one workspace, each with its own BYO webhook at
// /slack/events/{projectId}. classifyEvent accepted EVERY app_mention on the
// strength of its type alone, so whichever project the callback landed on
// answered — while the plain-`message` branch had checked botUserId all along.
// The same event, arriving as the other Slack event type, routed correctly.
describe('classifyEvent — an app_mention addressed to a DIFFERENT bot', () => {
  const mention = (text: string) => ({ type: 'app_mention', text }) as any;

  test('THE FIX: app_mention naming another workspace bot → ignore', async () => {
    const cls = await classifyEvent('T1', mention('<@U0B7QL26690> hey man'), 'U0B5W5XN49Y');
    expect(cls).toBe('ignore');
  });

  test('the bot that WAS mentioned still answers', async () => {
    const cls = await classifyEvent('T1', mention('<@U0B7QL26690> hey man'), 'U0B7QL26690');
    expect(cls).toBe('mention');
  });

  test('mentioned alongside another bot → still ours to answer', async () => {
    const cls = await classifyEvent('T1', mention('<@U0B7QL26690> <@B1> both of you'), BOT);
    expect(cls).toBe('mention');
  });

  // Slack also renders mentions as <@U123|display-name>. A gate that only knows
  // the bare form fails CLOSED on this one — the bot goes silent on a real
  // mention, which is #6590's failure wearing a different hat.
  test('the <@ID|label> render is still a mention, not silence', async () => {
    const cls = await classifyEvent('T1', mention('<@B1|kortix> hey'), BOT);
    expect(cls).toBe('mention');
  });

  // A BYO app that has never run link-bot has no recorded bot id. Refusing those
  // would take every such workspace offline to fix a two-bot workspace's
  // routing, so the gate fails open and says so in the log.
  test('unknown bot id → still a mention (fail open, not a silent workspace)', async () => {
    const cls = await classifyEvent('T1', mention('<@U0B7QL26690> hey man'), null);
    expect(cls).toBe('mention');
  });

  test('an empty mention of OUR bot is still ours (the help-text path)', async () => {
    const cls = await classifyEvent('T1', mention('<@B1>'), BOT);
    expect(cls).toBe('mention');
  });
});
