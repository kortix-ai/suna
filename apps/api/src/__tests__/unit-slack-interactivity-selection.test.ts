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
const actualDispatch = await import('../channels/slack/dispatch');
mock.module('../channels/slack/dispatch', () => ({
  ...actualDispatch,
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
let setAgentReason: 'no_binding' | 'unknown_agent' = 'no_binding';
mock.module('../channels/slack/selection', () => ({
  // `./commands` (transitively imported by interactivity.ts for handleSlashCommand)
  // also pulls this in — the mock module shape must cover its full surface or
  // the import fails, not just the bits this file's own code paths exercise.
  currentChannelSelection: async () => null,
  setChannelAgent: async (_c: unknown, a: string | null) => {
    setAgentCalls.push(a);
    return setResult ? { ok: true } : { ok: false, reason: setAgentReason };
  },
  setChannelModel: async (_c: unknown, m: string | null) => { setModelCalls.push(m); return setResult; },
  setChannelConversationPolicy: async () => undefined,
  listProjectAgents: async () => [],
  RECOMMENDED_MODELS: [],
  isValidModelId: (s: string) => { const i = s.indexOf('/'); return i > 0 && i < s.length - 1 && !/\s/.test(s); },
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
  setAgentReason = 'no_binding';
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
  response_url: 'https://hooks.slack.com/response',
} as any;

describe('agent/model picker clicks', () => {
  test('set_model_ → persists the model and confirms', async () => {
    await handleBlockAction({
      ...basePayload,
      actions: [{ action_id: 'set_model_anthropic/claude-opus-4-8', value: JSON.stringify({ c: 'C1', m: 'anthropic/claude-opus-4-8' }) }],
    });
    expect(setModelCalls).toEqual(['kortix/anthropic/claude-opus-4-8']);
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
    setAgentReason = 'no_binding';
    await handleBlockAction({
      ...basePayload,
      actions: [{ action_id: 'set_agent_reviewer', value: JSON.stringify({ c: 'C1', a: 'reviewer' }) }],
    });
    expect(posts[0]?.body.text).toContain('no longer bound');
  });

  test('unknown agent in a governed project → declared-agent error, not "no longer bound"', async () => {
    setResult = false;
    setAgentReason = 'unknown_agent';
    await handleBlockAction({
      ...basePayload,
      actions: [{ action_id: 'set_agent_ghost', value: JSON.stringify({ c: 'C1', a: 'ghost' }) }],
    });
    expect(posts[0]?.body.text).toContain('is not a declared agent');
    expect(posts[0]?.body.text).not.toContain('no longer bound');
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
      response_url: 'https://hooks.slack.com/response',
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
      response_url: 'https://hooks.slack.com/response',
    } as any);
    expect(posts[0]?.body.text).toContain('No Kortix session is attached');
  });

  test('ignores unrelated callback_ids', async () => {
    await handleMessageShortcut({
      type: 'message_action',
      callback_id: 'something_else',
      team: { id: 'T1' },
      response_url: 'https://hooks.slack.com/response',
    } as any);
    expect(posts.length).toBe(0);
  });
});

/**
 * A per-project (bring-your-own) app signs its requests with a secret its
 * project admin chose, so every project or thread named in the payload must be
 * that project's own. Handlers receive the verified scope and stay inside it.
 */
describe('per-project interactivity stays inside its own project', () => {
  const byo = { kind: 'project' as const, projectId: 'proj-1', teamId: 'T1' };

  test('a picker click for a channel bound to another project is refused, nothing persisted', async () => {
    dbResults = [[{ projectId: 'proj-other' }]]; // the channel's binding
    await handleBlockAction(
      { ...basePayload, actions: [{ action_id: 'set_agent_reviewer', value: JSON.stringify({ c: 'C1', a: 'reviewer' }) }] },
      byo,
    );
    expect(setAgentCalls).toEqual([]);
    expect(posts[0]?.body.text).toContain('different Kortix project');
  });

  test('a picker click for a channel bound to this project is applied', async () => {
    dbResults = [[{ projectId: 'proj-1' }]];
    await handleBlockAction(
      { ...basePayload, actions: [{ action_id: 'set_agent_reviewer', value: JSON.stringify({ c: 'C1', a: 'reviewer' }) }] },
      byo,
    );
    expect(setAgentCalls).toEqual(['reviewer']);
  });

  test('"Request access" naming another project files nothing', async () => {
    await handleBlockAction(
      { ...basePayload, actions: [{ action_id: 'slack_request_access', value: JSON.stringify({ projectId: 'proj-other' }) }] },
      byo,
    );
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body.text).toContain('different Kortix project');
  });
});

describe('response_url', () => {
  test('a response_url outside the Slack webhook host is never POSTed to', async () => {
    await handleBlockAction({
      ...basePayload,
      response_url: 'https://collector.example.test/in',
      actions: [{ action_id: 'set_agent_reviewer', value: JSON.stringify({ c: 'C1', a: 'reviewer' }) }],
    });
    expect(posts).toHaveLength(0);
  });
});
