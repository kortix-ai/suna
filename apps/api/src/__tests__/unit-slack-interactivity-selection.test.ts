import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

// Interactivity: agent/model picker clicks persist the channel selection, and
// the "Open in Kortix" message shortcut resolves a thread to its session URL.

let dbResults: unknown[][] = [];
function makeChain(): any {
  const chain: any = {};
  for (const m of ['from', 'where', 'limit']) chain[m] = () => chain;
  chain.then = (resolve: (rows: unknown[]) => unknown) => Promise.resolve(resolve(dbResults.shift() ?? []));
  return chain;
}
mock.module('../shared/db', () => ({ db: { select: () => makeChain() }, hasDatabase: () => true }));

// Stub the dispatch graph so importing interactivity stays light.
mock.module('../channels/slack/dispatch', () => ({
  dispatchSlackEvent: async () => {},
  pendingPickers: new Map(),
  spawnAgentTurn: async () => {},
}));
mock.module('../channels/install-store', () => ({
  loadSlackTokenForProject: async () => 'xoxb',
  saveSlackOauthInstall: async () => {},
}));
mock.module('../channels/slack-api', () => ({
  openDmChannel: async () => 'D1',
  postBlocks: async () => 'ts',
  postEphemeral: async () => true,
  updateMessage: async () => {},
}));

const setAgentCalls: Array<string | null> = [];
const setModelCalls: Array<string | null> = [];
let setResult = true;
mock.module('../channels/slack/selection', () => ({
  setChannelAgent: async (_c: unknown, a: string | null) => { setAgentCalls.push(a); return setResult; },
  setChannelModel: async (_c: unknown, m: string | null) => { setModelCalls.push(m); return setResult; },
  modelLabel: (id: string) => id,
}));

// Capture response_url POSTs.
const posts: Array<{ url: string; body: any }> = [];
const realFetch = globalThis.fetch;
beforeEach(() => {
  dbResults = [];
  setAgentCalls.length = 0;
  setModelCalls.length = 0;
  setResult = true;
  posts.length = 0;
  globalThis.fetch = (async (url: string, init?: any) => {
    posts.push({ url, body: JSON.parse(init?.body ?? '{}') });
    return { ok: true } as any;
  }) as any;
});
afterEach(() => { globalThis.fetch = realFetch; });

const { handleBlockAction, handleMessageShortcut } = await import('../channels/slack/interactivity');

const basePayload = {
  type: 'block_actions',
  team: { id: 'T1' },
  user: { id: 'U1' },
  channel: { id: 'C1' },
  response_url: 'https://hooks.slack/response',
} as any;

describe('agent/model picker clicks', () => {
  test('set_model_ → persists the model and confirms', async () => {
    await handleBlockAction({
      ...basePayload,
      actions: [{ action_id: 'set_model_anthropic/claude-opus-4-8', value: JSON.stringify({ c: 'C1', m: 'anthropic/claude-opus-4-8' }) }],
    });
    expect(setModelCalls).toEqual(['anthropic/claude-opus-4-8']);
    expect(posts[0]?.body.text).toContain('Model for this channel set to');
    expect(posts[0]?.body.replace_original).toBe(true);
  });

  test('set_model_default (empty value) → clears the override', async () => {
    await handleBlockAction({
      ...basePayload,
      actions: [{ action_id: 'set_model_default', value: JSON.stringify({ c: 'C1', m: '' }) }],
    });
    expect(setModelCalls).toEqual([null]);
    expect(posts[0]?.body.text).toContain('reset');
  });

  test('set_agent_ → persists the agent', async () => {
    await handleBlockAction({
      ...basePayload,
      actions: [{ action_id: 'set_agent_reviewer', value: JSON.stringify({ c: 'C1', a: 'reviewer' }) }],
    });
    expect(setAgentCalls).toEqual(['reviewer']);
    expect(posts[0]?.body.text).toContain('reviewer');
  });

  test('binding gone → tells the user to switch', async () => {
    setResult = false;
    await handleBlockAction({
      ...basePayload,
      actions: [{ action_id: 'set_agent_reviewer', value: JSON.stringify({ c: 'C1', a: 'reviewer' }) }],
    });
    expect(posts[0]?.body.text).toContain('no longer bound');
  });

  test('a plain "Open session" link button is ignored (no work, no post)', async () => {
    await handleBlockAction({ ...basePayload, actions: [{ action_id: 'session_open' }] });
    expect(setAgentCalls.length).toBe(0);
    expect(setModelCalls.length).toBe(0);
    expect(posts.length).toBe(0);
  });
});

describe('Open in Kortix message shortcut', () => {
  test('resolves the thread to its session URL', async () => {
    dbResults = [[{ sessionId: 'sess-9', projectId: 'proj-1' }]];
    await handleMessageShortcut({
      type: 'message_action',
      callback_id: 'open_session',
      team: { id: 'T1' },
      channel: { id: 'C1' },
      message: { ts: '5.5', thread_ts: '1.1' },
      response_url: 'https://hooks.slack/response',
    } as any);
    const txt = JSON.stringify(posts[0]?.body);
    expect(txt).toContain('/projects/proj-1/sessions/sess-9');
    expect(txt).toContain('Open session');
  });

  test('no session on the thread → friendly message', async () => {
    dbResults = [[]];
    await handleMessageShortcut({
      type: 'message_action',
      callback_id: 'open_session',
      team: { id: 'T1' },
      channel: { id: 'C1' },
      message: { ts: '5.5' },
      response_url: 'https://hooks.slack/response',
    } as any);
    expect(posts[0]?.body.text).toContain('No Kortix session is attached');
  });

  test('ignores unrelated callback_ids', async () => {
    await handleMessageShortcut({
      type: 'message_action',
      callback_id: 'something_else',
      team: { id: 'T1' },
      response_url: 'https://hooks.slack/response',
    } as any);
    expect(posts.length).toBe(0);
  });
});
