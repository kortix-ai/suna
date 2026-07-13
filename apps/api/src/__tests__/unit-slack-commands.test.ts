import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

// Slash command handlers for agent/model selection + session visibility.

let dbResults: unknown[][] = [];
function makeChain(): any {
  const chain: any = {};
  for (const m of ['from', 'where', 'limit', 'orderBy', 'set', 'values', 'returning']) {
    chain[m] = () => chain;
  }
  chain.then = (resolve: (rows: unknown[]) => unknown) => Promise.resolve(resolve(dbResults.shift() ?? []));
  return chain;
}
mock.module('../shared/db', () => ({
  db: { select: () => makeChain(), update: () => makeChain() },
  hasDatabase: () => true,
}));

// Controllable selection layer.
let selection: unknown = { projectId: 'p1', agentName: null, model: null };
let setAgentResult: { ok: true } | { ok: false; reason: 'no_binding' | 'unknown_agent' } = { ok: true };
let setModelResult = true;
const setAgentCalls: Array<string | null> = [];
const setModelCalls: Array<string | null> = [];
mock.module('../channels/slack/selection', () => ({
  currentChannelSelection: async () => selection,
  setChannelAgent: async (_ctx: unknown, a: string | null) => { setAgentCalls.push(a); return setAgentResult; },
  setChannelModel: async (_ctx: unknown, m: string | null) => { setModelCalls.push(m); return setModelResult; },
  listProjectAgents: async () => [{ name: 'reviewer', description: 'Reviews code', mode: null }],
  RECOMMENDED_MODELS: [
    { id: 'anthropic/claude-opus-4-8', label: 'Claude Opus 4.8', hint: 'Most capable' },
    { id: 'openai/gpt-5.5', label: 'GPT-5.5', hint: 'OpenAI flagship' },
  ],
  isValidModelId: (s: string) => { const i = s.indexOf('/'); return i > 0 && i < s.length - 1 && !/\s/.test(s); },
  modelLabel: (id: string) => (id === 'anthropic/claude-opus-4-8' ? 'Claude Opus 4.8' : id),
  setChannelConversationPolicy: async () => undefined,
}));
mock.module('../channels/slack/model-gate', () => ({
  channelModelContext: async () => selection
    ? { projectId: 'p1', accountId: 'a1', ownerUserId: 'u1', freeManagedOnly: false }
    : null,
}));
mock.module('../llm-gateway/models/picker', () => ({
  listPickerModels: async () => ({
    models: [
      { id: 'anthropic/claude-opus-4-8', label: 'Claude Opus 4.8', hint: 'Most capable' },
      { id: 'openai/gpt-5.5', label: 'GPT-5.5', hint: 'OpenAI flagship' },
    ],
    projectDefault: { model: null, source: 'platform', label: null },
  }),
  labelForModelRef: (id: string) => id === 'anthropic/claude-opus-4-8' ? 'Claude Opus 4.8' : id,
}));
mock.module('../llm-gateway/resolution/default-model', () => ({
  isModelServableForAccount: async () => true,
  resolveEffectiveModel: async ({ explicit }: { explicit?: string | null }) => ({
    model: explicit ?? null,
    source: explicit ? 'session' : 'platform',
  }),
}));

// Identity layer — kept out of the db chain so it doesn't disturb dbResults
// ordering. Controllable per-test via `identityRow`.
let identityRow: { userId: string } | null = null;
mock.module('../channels/slack/identity', () => ({
  lookupSlackIdentity: async () => identityRow,
  revokeSlackIdentity: async () => true,
  lookupSlackUserIdForKortixUser: async () => null,
}));
mock.module('../accounts/core/app', () => ({
  lookupEmailsByUserIds: async (ids: string[]) =>
    new Map(ids.map((id) => [id, `${id}@example.com`])),
  defaultAccountName: (email: string | null | undefined) => email ?? 'Account',
}));

const { config } = await import('../config');
const { handleSlashCommand } = await import('../channels/slack/commands');

const ctx = { teamId: 'T1', channelId: 'C1', slackUserId: 'U1', command: '/kortix' };

// Flatten all stringy text out of a blocks array for easy assertions.
function allText(resp: any): string {
  return JSON.stringify(resp.blocks ?? resp.text ?? '');
}
function actionIds(resp: any): string[] {
  const ids: string[] = [];
  for (const b of resp.blocks ?? []) {
    if (b.accessory?.action_id) ids.push(b.accessory.action_id);
    for (const el of b.elements ?? []) if (el.action_id) ids.push(el.action_id);
  }
  return ids;
}

beforeEach(() => {
  dbResults = [];
  identityRow = null;
  selection = { projectId: 'p1', agentName: null, model: null };
  setAgentResult = { ok: true };
  setModelResult = true;
  setAgentCalls.length = 0;
  setModelCalls.length = 0;
});

describe('help', () => {
  test('lists the new agents / models / session commands', async () => {
    const resp = await handleSlashCommand('help', '', ctx);
    const txt = allText(resp);
    expect(txt).toContain('agent');
    expect(txt).toContain('model');
    expect(txt).toContain('session');
  });
});

describe('unknown subcommand', () => {
  test('points at help', async () => {
    const resp = await handleSlashCommand('frobnicate', '', ctx);
    expect(resp.text).toContain('Unknown subcommand');
  });
});

describe('identity feature gated OFF', () => {
  const originalRequireIdentity = config.SLACK_REQUIRE_USER_IDENTITY;

  beforeEach(() => {
    config.SLACK_REQUIRE_USER_IDENTITY = false;
  });

  afterEach(() => {
    config.SLACK_REQUIRE_USER_IDENTITY = originalRequireIdentity;
  });

  test('/login is an unknown subcommand', async () => {
    const resp = await handleSlashCommand('login', '', ctx);
    expect(resp.text).toContain('Unknown subcommand');
  });
  test('/logout is an unknown subcommand', async () => {
    const resp = await handleSlashCommand('logout', '', ctx);
    expect(resp.text).toContain('Unknown subcommand');
  });
  test('help does not list login/logout', async () => {
    const resp = await handleSlashCommand('help', '', ctx);
    expect(allText(resp)).not.toContain('runs as you');
  });
});

describe('/kortix models', () => {
  test('renders a picker of recommended models + a project-default reset', async () => {
    selection = { projectId: 'p1', agentName: null, model: 'anthropic/claude-opus-4-8' };
    const resp = await handleSlashCommand('models', '', ctx);
    const ids = actionIds(resp);
    expect(ids).toContain('set_model_default');
    expect(ids).toContain('set_model_anthropic/claude-opus-4-8');
    // current model is marked
    expect(allText(resp)).toContain('✓ ');
  });
  test('unbound channel → prompts to switch', async () => {
    selection = null;
    const resp = await handleSlashCommand('models', '', ctx);
    expect(allText(resp)).toContain('No project is connected');
  });
});

describe('/kortix model <id>', () => {
  test('rejects a malformed id without writing', async () => {
    const resp = await handleSlashCommand('model', 'bad model', ctx);
    expect(resp.text).toContain("doesn't look like a model id");
    expect(setModelCalls.length).toBe(0);
  });
  test('sets a valid id', async () => {
    const resp = await handleSlashCommand('model', 'anthropic/claude-opus-4-8', ctx);
    expect(setModelCalls).toEqual(['anthropic/claude-opus-4-8']);
    expect(resp.text).toContain('set to');
  });
  test('"default" clears the override', async () => {
    const resp = await handleSlashCommand('model', 'default', ctx);
    expect(setModelCalls).toEqual([null]);
    expect(resp.text).toContain('reset');
  });
  test('unbound channel → prompts to switch, no write', async () => {
    selection = null;
    const resp = await handleSlashCommand('model', 'anthropic/claude-opus-4-8', ctx);
    expect(resp.text).toContain('Connect a project first');
    expect(setModelCalls.length).toBe(0);
  });
});

describe('/kortix agent <name>', () => {
  test('sets a named agent', async () => {
    const resp = await handleSlashCommand('agent', 'reviewer', ctx);
    expect(setAgentCalls).toEqual(['reviewer']);
    expect(resp.text).toContain('reviewer');
  });
  test('"default" clears the override (null)', async () => {
    const resp = await handleSlashCommand('agent', 'default', ctx);
    expect(setAgentCalls).toEqual([null]);
  });
  test('no arg → usage', async () => {
    const resp = await handleSlashCommand('agent', '', ctx);
    expect(resp.text).toContain('Usage');
    expect(setAgentCalls.length).toBe(0);
  });
  test('unknown agent in a governed project → clear error, not the generic "bind a project" message', async () => {
    setAgentResult = { ok: false, reason: 'unknown_agent' };
    const resp = await handleSlashCommand('agent', 'ghost', ctx);
    expect(resp.text).toContain('is not a declared agent');
    expect(resp.text).toContain('ghost');
  });
  test('no binding → prompts to switch', async () => {
    setAgentResult = { ok: false, reason: 'no_binding' };
    const resp = await handleSlashCommand('agent', 'reviewer', ctx);
    expect(resp.text).toContain('Bind a project first');
  });
});

describe('/kortix agents (list)', () => {
  test('acks immediately (the real list posts async via response_url)', async () => {
    const resp = await handleSlashCommand('agents', '', { ...ctx, responseUrl: undefined });
    expect(resp.text).toContain('Loading agents');
  });
  test('/kortix agents <name> is an alias for set', async () => {
    const resp = await handleSlashCommand('agents', 'reviewer', ctx);
    expect(setAgentCalls).toEqual(['reviewer']);
  });
});

describe('/kortix session (singular)', () => {
  test('renders the latest channel session + an Open button', async () => {
    dbResults = [[{ sessionId: 'sess-9', status: 'running', agentName: 'reviewer', createdAt: new Date() }]];
    const resp = await handleSlashCommand('session', '', ctx);
    const ids = actionIds(resp);
    expect(ids).toContain('session_open');
    const txt = allText(resp);
    expect(txt).toContain('/projects/p1/sessions/sess-9');
    expect(txt).toContain('running');
  });
  test('no sessions yet → empty state', async () => {
    dbResults = [[]];
    const resp = await handleSlashCommand('session', '', ctx);
    expect(allText(resp)).toContain('No sessions started in this channel');
  });
  test('unbound channel → prompts to switch', async () => {
    selection = null;
    const resp = await handleSlashCommand('session', '', ctx);
    expect(allText(resp)).toContain('No project bound');
  });
});

describe('/kortix whoami', () => {
  test('surfaces the current agent + model', async () => {
    selection = { projectId: 'p1', agentName: 'reviewer', model: 'anthropic/claude-opus-4-8' };
    // whoami also fetches the project row.
    dbResults = [[{ projectId: 'p1', name: 'Proj', repoUrl: 'https://github.com/o/r' }]];
    const resp = await handleSlashCommand('whoami', '', ctx);
    const txt = allText(resp);
    expect(txt).toContain('reviewer');
    expect(txt).toContain('Claude Opus 4.8');
  });
});
