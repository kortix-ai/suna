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
  db: { select: () => makeChain(), update: () => makeChain() }, auditDb: { select: () => makeChain(), update: () => makeChain() },
  hasDatabase: () => true,
}));

// Controllable selection layer.
let selection: unknown = { projectId: 'p1', agentName: null, opencodeModel: null };
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

// Model decisions no longer read a hardcoded RECOMMENDED_MODELS list off the
// selection module. They resolve the channel's project/account through
// `model-gate`, then list the REAL served catalog (managed + connected BYOK)
// through the picker, so a pick can never 404. Mock that graph — mocking only
// `selection` leaves `channelModelContext` unmocked, it returns null against no
// DB, and every model command answers "connect a project first" instead of
// exercising what these tests are about.
let modelGate: unknown = {
  projectId: 'p1',
  accountId: 'a1',
  ownerUserId: 'u1',
  freeManagedOnly: false,
};
mock.module('../channels/slack/model-gate', () => ({
  // The gate follows the binding: an unbound channel has no project.
  channelModelContext: async () => (selection ? modelGate : null),
}));
let servable = true;
mock.module('../llm-gateway/resolution/default-model', () => ({
  isModelServableForAccount: async () => servable,
  resolveEffectiveModel: async () => ({ model: 'anthropic/claude-opus-4-8', source: 'project' }),
}));
mock.module('../llm-gateway/models/picker', () => ({
  listPickerModels: async () => ({
    models: [
      {
        id: 'anthropic/claude-opus-4-8',
        label: 'Claude Opus 4.8',
        provider: 'anthropic',
        managed: false,
        hint: 'Most capable',
      },
      { id: 'kortix/glm-5.2', label: 'GLM 5.2', provider: 'kortix', managed: true, hint: null },
    ],
    projectDefault: { model: 'kortix/glm-5.2', source: 'project', label: 'GLM 5.2' },
  }),
  labelForModelRef: (id: string) =>
    id === 'anthropic/claude-opus-4-8' ? 'Claude Opus 4.8' : id,
}));

// Identity layer — kept out of the db chain so it doesn't disturb dbResults
// ordering. Controllable per-test via `identityRow`.
let identityRow: { userId: string } | null = null;
mock.module('../channels/slack/identity', () => ({
  lookupSlackIdentity: async () => identityRow,
  linkSlackIdentity: async () => {},
  resolveSlackActor: async () => ({ userId: 'user-1' }),
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
  selection = { projectId: 'p1', agentName: null, opencodeModel: null };
  setAgentResult = { ok: true };
  setModelResult = true;
  setAgentCalls.length = 0;
  setModelCalls.length = 0;
  servable = true;
});

describe('help', () => {
  // Discovery moved into the one `/kortix` panel; help now documents the
  // typed shortcuts that survived it. Asserting the retired `agents`/`models`
  // list here just pinned the old design.
  test('points at the panel and lists the typed shortcuts', async () => {
    const resp = await handleSlashCommand('help', '', ctx);
    const txt = allText(resp);
    expect(txt).toContain('control panel');
    for (const shortcut of ['model <id>', 'agent <name>', 'switch', 'policy', 'sessions']) {
      expect(txt).toContain(shortcut);
    }
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
    selection = { projectId: 'p1', agentName: null, opencodeModel: 'anthropic/claude-opus-4-8' };
    const resp = await handleSlashCommand('models', '', ctx);
    const ids = actionIds(resp);
    expect(ids).toContain('set_model_default');
    expect(ids).toContain('set_model_anthropic/claude-opus-4-8');
    // current model is marked
    expect(allText(resp)).toContain('✓ ');
  });
  test('unbound channel → prompts to connect one', async () => {
    selection = null;
    const resp = await handleSlashCommand('models', '', ctx);
    expect(allText(resp)).toContain('No project is connected to this channel yet');
  });
});

describe('/kortix model <id>', () => {
  // Shape is no longer the gate — servability is, so an id that cannot be
  // served is refused whatever it looks like. The property under test is
  // unchanged and is the one that matters: nothing unusable is ever stored.
  test('refuses an unservable id without writing', async () => {
    servable = false;
    const resp = await handleSlashCommand('model', 'not-a-model', ctx);
    expect(resp.text).toContain("isn't available for this workspace");
    expect(setModelCalls.length).toBe(0);
  });
  test('still refuses an id with whitespace on shape alone', async () => {
    const resp = await handleSlashCommand('model', 'not a model', ctx);
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
  test('unbound channel → prompts to connect one, no write', async () => {
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
    selection = { projectId: 'p1', agentName: 'reviewer', opencodeModel: 'anthropic/claude-opus-4-8' };
    // whoami also fetches the project row.
    dbResults = [[{ projectId: 'p1', name: 'Proj', repoUrl: 'https://github.com/o/r' }]];
    const resp = await handleSlashCommand('whoami', '', ctx);
    const txt = allText(resp);
    expect(txt).toContain('reviewer');
    expect(txt).toContain('Claude Opus 4.8');
  });
});
