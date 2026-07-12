import { beforeEach, describe, expect, mock, test } from 'bun:test';

// Per-channel agent + model selection helpers. Pure-function bits plus the
// binding read/write helpers (against a FIFO db mock).

// ─── FIFO db mock (same shape as unit-slack-dispatch-session) ─────────────────
let dbResults: Array<unknown[] | Error> = [];
function makeChain(): any {
  const chain: any = {};
  for (const m of ['select', 'from', 'where', 'limit', 'set', 'values', 'returning', 'update']) {
    chain[m] = () => chain;
  }
  chain.then = (resolve: (rows: unknown[]) => unknown, reject?: (err: unknown) => unknown) => {
    const next = dbResults.shift() ?? [];
    if (next instanceof Error) {
      if (reject) return Promise.resolve(reject(next));
      return Promise.reject(next);
    }
    return Promise.resolve(resolve(next));
  };
  return chain;
}
mock.module('../shared/db', () => ({
  db: { select: () => makeChain(), update: () => makeChain() },
  hasDatabase: () => true,
}));
// selection.ts pulls these in at import; stub so the import is cheap + side-effect-free.
// `projectConfig` is mutable so governance tests can flip a project between
// legacy (no fixed catalog) and declarative (`[[agents]]` adopted).
let projectConfig: { agents: Array<{ name: string; description?: string | null; mode?: string | null }>; agent_discovery?: string } = { agents: [] };
mock.module('../projects/lib/git', () => ({ withProjectGitAuth: async (p: unknown) => p }));
mock.module('../projects/git', () => ({
  listRepoFiles: async () => [],
  loadProjectConfig: async () => projectConfig,
  readManifestFromRepo: async () => null,
}));

const {
  currentChannelSelection,
  isValidModelId,
  setChannelAgent,
  setChannelModel,
} = await import('../channels/slack/selection');

beforeEach(() => {
  dbResults = [];
  projectConfig = { agents: [] };
});

describe('isValidModelId — provider/model shape only (no stale-catalog gate)', () => {
  test('accepts well-formed provider/model ids', () => {
    expect(isValidModelId('anthropic/claude-opus-4-8')).toBe(true);
    expect(isValidModelId('openai/gpt-5.5')).toBe(true);
    expect(isValidModelId('a/b')).toBe(true);
  });
  test('rejects malformed ids', () => {
    expect(isValidModelId('claude-opus-4-8')).toBe(false); // no provider
    expect(isValidModelId('/leading')).toBe(false);
    expect(isValidModelId('trailing/')).toBe(false);
    expect(isValidModelId('has space/model')).toBe(false);
    expect(isValidModelId('')).toBe(false);
  });
});

describe('currentChannelSelection', () => {
  test('returns the binding + its agent/model overrides', async () => {
    dbResults = [[{ projectId: 'p1', agentName: 'reviewer', opencodeModel: 'anthropic/claude-opus-4-8', conversationPolicy: 'owner_approval' }]];
    const sel = await currentChannelSelection({ teamId: 'T1', channelId: 'C1' });
    expect(sel).toEqual({ projectId: 'p1', agentName: 'reviewer', opencodeModel: 'anthropic/claude-opus-4-8', conversationPolicy: 'owner_approval' });
  });
  test('null agent/model overrides surface as null', async () => {
    dbResults = [[{ projectId: 'p1', agentName: null, opencodeModel: null, conversationPolicy: null }]];
    const sel = await currentChannelSelection({ teamId: 'T1', channelId: 'C1' });
    expect(sel).toEqual({ projectId: 'p1', agentName: null, opencodeModel: null, conversationPolicy: null });
  });
  test('unbound channel → null', async () => {
    dbResults = [[]];
    expect(await currentChannelSelection({ teamId: 'T1', channelId: 'C1' })).toBeNull();
  });
  test('missing optional override columns falls back to project-only routing', async () => {
    dbResults = [
      new Error('PostgresError: column "agent_name" does not exist'),
      [{ projectId: 'p1' }],
    ];
    const sel = await currentChannelSelection({ teamId: 'T1', channelId: 'C1' });
    expect(sel).toEqual({ projectId: 'p1', agentName: null, opencodeModel: null, conversationPolicy: null });
  });
  test('no channel id → null (no query)', async () => {
    expect(await currentChannelSelection({ teamId: 'T1', channelId: '' })).toBeNull();
  });
});

describe('setChannelAgent / setChannelModel', () => {
  test('returns { ok: true } when a binding row was updated (ungoverned project)', async () => {
    // 1st shift: setChannelAgent's own projectId lookup (no bound project found
    // — treated as ungoverned, same as a legacy project). 2nd shift: the write.
    dbResults = [[], [{ id: 'b1' }]];
    expect(await setChannelAgent({ teamId: 'T1', channelId: 'C1' }, 'reviewer')).toEqual({ ok: true });
  });
  test('returns false when no binding exists to update', async () => {
    dbResults = [[]];
    expect(await setChannelModel({ teamId: 'T1', channelId: 'C1' }, 'anthropic/claude-opus-4-8')).toBe(false);
  });
  test('no channel id → no_binding (no write, no project lookup)', async () => {
    expect(await setChannelAgent({ teamId: 'T1', channelId: '' }, null)).toEqual({ ok: false, reason: 'no_binding' });
  });
  test('resetting to null skips the governance lookup entirely', async () => {
    // Only one dbResults entry queued — if setChannelAgent looked up the
    // project id for a null (reset) agentName, this would starve the FIFO
    // and the update would see [] instead of the row.
    dbResults = [[{ id: 'b1' }]];
    expect(await setChannelAgent({ teamId: 'T1', channelId: 'C1' }, null)).toEqual({ ok: true });
  });
  test('missing optional override columns returns false instead of crashing', async () => {
    dbResults = [new Error('PostgresError: column "opencode_model" does not exist')];
    expect(await setChannelModel({ teamId: 'T1', channelId: 'C1' }, 'anthropic/claude-opus-4-8')).toBe(false);
  });
});

describe('setChannelAgent — governance validation (declared [[agents]] projects)', () => {
  test('governed project rejects a name that is not a declared agent', async () => {
    projectConfig = { agents: [{ name: 'reviewer' }], agent_discovery: 'declarative' };
    // 1st shift: projectId lookup. 2nd shift: loadProjectAgentGovernance's own
    // project row lookup. No 3rd shift — the write must never happen.
    dbResults = [[{ projectId: 'p1' }], [{ projectId: 'p1', defaultBranch: 'main' }]];
    expect(await setChannelAgent({ teamId: 'T1', channelId: 'C1' }, 'ghost')).toEqual({
      ok: false,
      reason: 'unknown_agent',
    });
    expect(dbResults.length).toBe(0);
  });
  test('governed project accepts a declared agent name', async () => {
    projectConfig = { agents: [{ name: 'reviewer' }], agent_discovery: 'declarative' };
    dbResults = [[{ projectId: 'p1' }], [{ projectId: 'p1', defaultBranch: 'main' }], [{ id: 'b1' }]];
    expect(await setChannelAgent({ teamId: 'T1', channelId: 'C1' }, 'reviewer')).toEqual({ ok: true });
  });
  test('legacy (undeclared) project accepts any name — no fixed catalog to check', async () => {
    projectConfig = { agents: [] };
    dbResults = [[{ projectId: 'p1' }], [{ projectId: 'p1', defaultBranch: 'main' }], [{ id: 'b1' }]];
    expect(await setChannelAgent({ teamId: 'T1', channelId: 'C1' }, 'anything-goes')).toEqual({ ok: true });
  });
});
