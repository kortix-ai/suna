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
mock.module('../projects/lib/git', () => ({ withProjectGitAuth: async (p: unknown) => p }));
mock.module('../projects/git', () => ({
  listRepoFiles: async () => [],
  loadProjectConfig: async () => ({ agents: [] }),
}));

const {
  RECOMMENDED_MODELS,
  currentChannelSelection,
  isValidModelId,
  modelLabel,
  setChannelAgent,
  setChannelModel,
} = await import('../channels/slack/selection');

beforeEach(() => {
  dbResults = [];
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

describe('modelLabel', () => {
  test('uses the friendly label for a recommended model', () => {
    expect(modelLabel('anthropic/claude-opus-4-8')).toBe('Claude Opus 4.8');
  });
  test('falls back to the raw id for an unknown model', () => {
    expect(modelLabel('exotic/model-x')).toBe('exotic/model-x');
  });
});

describe('RECOMMENDED_MODELS', () => {
  test('every entry is a valid id with a label + hint', () => {
    expect(RECOMMENDED_MODELS.length).toBeGreaterThan(0);
    for (const m of RECOMMENDED_MODELS) {
      expect(isValidModelId(m.id)).toBe(true);
      expect(m.label.length).toBeGreaterThan(0);
      expect(m.hint.length).toBeGreaterThan(0);
    }
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
  test('returns true when a binding row was updated', async () => {
    dbResults = [[{ id: 'b1' }]];
    expect(await setChannelAgent({ teamId: 'T1', channelId: 'C1' }, 'reviewer')).toBe(true);
  });
  test('returns false when no binding exists to update', async () => {
    dbResults = [[]];
    expect(await setChannelModel({ teamId: 'T1', channelId: 'C1' }, 'anthropic/claude-opus-4-8')).toBe(false);
  });
  test('no channel id → false (no write)', async () => {
    expect(await setChannelAgent({ teamId: 'T1', channelId: '' }, null)).toBe(false);
  });
  test('missing optional override columns returns false instead of crashing', async () => {
    dbResults = [new Error('PostgresError: column "opencode_model" does not exist')];
    expect(await setChannelModel({ teamId: 'T1', channelId: 'C1' }, 'anthropic/claude-opus-4-8')).toBe(false);
  });
});
