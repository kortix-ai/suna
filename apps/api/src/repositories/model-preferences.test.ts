import { beforeEach, describe, expect, mock, test } from 'bun:test';

// Account/agent/PROJECT-scoped default model preferences. A FIFO-ish chain mock
// captures select rows + insert values without a real DB.

let selectRows: any[] = [];
let insertedValues: any = null;
let deleteWhereArgs: any[] = [];
let conflictMode: 'update' | 'nothing' | null = null;
let conflictConfig: any = null;

function chain(): any {
  const c: any = {};
  for (const m of ['select', 'from', 'update', 'set', 'returning', 'limit', 'leftJoin']) {
    c[m] = () => c;
  }
  c.where = (...args: any[]) => {
    deleteWhereArgs = args;
    return c;
  };
  c.values = (v: any) => {
    insertedValues = v;
    return c;
  };
  c.onConflictDoUpdate = (config: any) => {
    conflictMode = 'update';
    conflictConfig = config;
    return Promise.resolve();
  };
  c.onConflictDoNothing = (config: any) => {
    conflictMode = 'nothing';
    conflictConfig = config;
    return Promise.resolve();
  };
  c.then = (resolve: (rows: any[]) => unknown) => Promise.resolve(resolve(selectRows));
  return c;
}
mock.module('../shared/db', () => ({
  db: { select: () => chain(), insert: () => chain(), delete: () => chain() },
  hasDatabase: () => true,
}));

const {
  getAccountModelDefaults,
  getSessionAgentContext,
  upsertAccountModelPreference,
  deleteAccountModelPreference,
} = await import('./model-preferences');

beforeEach(() => {
  selectRows = [];
  insertedValues = null;
  deleteWhereArgs = [];
  conflictMode = null;
  conflictConfig = null;
});

describe('getAccountModelDefaults', () => {
  test('buckets account / agent / project rows (legacy project-less agent row, no projectId arg)', async () => {
    selectRows = [
      { scope: 'account', scopeKey: '', projectId: null, model: 'glm-5.2' },
      { scope: 'agent', scopeKey: 'reviewer', projectId: null, model: 'claude-opus-4.8' },
      { scope: 'project', scopeKey: 'p1', projectId: null, model: 'anthropic/claude-sonnet-4.6' },
      { scope: 'project', scopeKey: 'p2', projectId: null, model: 'qwen3.7-max' },
    ];
    const defaults = await getAccountModelDefaults('a1');
    expect(defaults.account).toBe('glm-5.2');
    expect(defaults.agents).toEqual({ reviewer: 'claude-opus-4.8' });
    expect(defaults.projects).toEqual({ p1: 'anthropic/claude-sonnet-4.6', p2: 'qwen3.7-max' });
  });

  test('empty → all buckets empty', async () => {
    expect(await getAccountModelDefaults('a1')).toEqual({ account: null, agents: {}, projects: {} });
  });

  // The core bug fix: agent-scope pins keyed only by agent name used to be
  // account-wide, so project A and project B (same account, both declaring an
  // agent named 'kortix' in their own kortix.yaml) silently shared ONE pin.
  describe('per-project agent pin isolation', () => {
    test('project A and project B hold INDEPENDENT pins for the same agent name', async () => {
      selectRows = [
        { scope: 'agent', scopeKey: 'kortix', projectId: 'proj-a', model: 'anthropic/claude-opus-4.8' },
        { scope: 'agent', scopeKey: 'kortix', projectId: 'proj-b', model: 'anthropic/claude-sonnet-4.6' },
      ];
      const defaultsA = await getAccountModelDefaults('a1', 'proj-a');
      const defaultsB = await getAccountModelDefaults('a1', 'proj-b');
      expect(defaultsA.agents).toEqual({ kortix: 'anthropic/claude-opus-4.8' });
      expect(defaultsB.agents).toEqual({ kortix: 'anthropic/claude-sonnet-4.6' });
    });

    test('a pin for project A never leaks into project C (unrelated project, no pin of its own)', async () => {
      selectRows = [
        { scope: 'agent', scopeKey: 'kortix', projectId: 'proj-a', model: 'anthropic/claude-opus-4.8' },
      ];
      const defaultsC = await getAccountModelDefaults('a1', 'proj-c');
      expect(defaultsC.agents).toEqual({});
    });

    test('legacy project-less pin (project_id NULL) applies as a fallback to every project that has not re-pinned', async () => {
      selectRows = [
        { scope: 'agent', scopeKey: 'kortix', projectId: null, model: 'legacy-shared-model' },
      ];
      const defaultsA = await getAccountModelDefaults('a1', 'proj-a');
      const defaultsB = await getAccountModelDefaults('a1', 'proj-b');
      expect(defaultsA.agents).toEqual({ kortix: 'legacy-shared-model' });
      expect(defaultsB.agents).toEqual({ kortix: 'legacy-shared-model' });
    });

    test('a project-scoped pin overrides the legacy fallback for THAT project only', async () => {
      selectRows = [
        { scope: 'agent', scopeKey: 'kortix', projectId: null, model: 'legacy-shared-model' },
        { scope: 'agent', scopeKey: 'kortix', projectId: 'proj-a', model: 'proj-a-override' },
      ];
      const defaultsA = await getAccountModelDefaults('a1', 'proj-a');
      const defaultsB = await getAccountModelDefaults('a1', 'proj-b');
      expect(defaultsA.agents).toEqual({ kortix: 'proj-a-override' });
      expect(defaultsB.agents).toEqual({ kortix: 'legacy-shared-model' });
    });

    test('omitting projectId returns ONLY the legacy fallback, never another project\'s pin', async () => {
      selectRows = [
        { scope: 'agent', scopeKey: 'kortix', projectId: null, model: 'legacy-shared-model' },
        { scope: 'agent', scopeKey: 'kortix', projectId: 'proj-a', model: 'proj-a-override' },
      ];
      const noProjectContext = await getAccountModelDefaults('a1');
      expect(noProjectContext.agents).toEqual({ kortix: 'legacy-shared-model' });
    });

    test('different agent names on different projects coexist independently', async () => {
      selectRows = [
        { scope: 'agent', scopeKey: 'kortix', projectId: 'proj-a', model: 'opus' },
        { scope: 'agent', scopeKey: 'reviewer', projectId: 'proj-a', model: 'sonnet' },
        { scope: 'agent', scopeKey: 'kortix', projectId: 'proj-b', model: 'haiku' },
      ];
      const defaultsA = await getAccountModelDefaults('a1', 'proj-a');
      expect(defaultsA.agents).toEqual({ kortix: 'opus', reviewer: 'sonnet' });
    });
  });
});

describe('upsertAccountModelPreference', () => {
  test('project scope writes scope_key = projectId, project_id column stays null', async () => {
    await upsertAccountModelPreference({ accountId: 'a1', scope: 'project', scopeKey: 'p1', model: 'glm-5.2' });
    expect(insertedValues).toMatchObject({ accountId: 'a1', scope: 'project', scopeKey: 'p1', projectId: null, model: 'glm-5.2' });
    expect(conflictMode).toBe('update');
    // Targets the GLOBAL partial index (account_id, scope, scope_key) WHERE project_id IS NULL.
    expect(conflictConfig.target).toHaveLength(3);
    expect(conflictConfig.targetWhere).toBeDefined();
  });

  test('account scope pins scope_key to empty string, project_id stays null', async () => {
    await upsertAccountModelPreference({ accountId: 'a1', scope: 'account', model: 'glm-5.2' });
    expect(insertedValues.scopeKey).toBe('');
    expect(insertedValues.projectId).toBeNull();
  });

  test('agent scope WITH a projectId writes project_id and targets the 4-column project partial index', async () => {
    await upsertAccountModelPreference({
      accountId: 'a1',
      scope: 'agent',
      scopeKey: 'kortix',
      projectId: 'proj-a',
      model: 'anthropic/claude-opus-4.8',
    });
    expect(insertedValues).toMatchObject({
      accountId: 'a1',
      scope: 'agent',
      scopeKey: 'kortix',
      projectId: 'proj-a',
      model: 'anthropic/claude-opus-4.8',
    });
    expect(conflictConfig.target).toHaveLength(4);
  });

  test('agent scope WITHOUT a projectId falls back to the legacy global partial index (project_id null)', async () => {
    await upsertAccountModelPreference({
      accountId: 'a1',
      scope: 'agent',
      scopeKey: 'kortix',
      model: 'anthropic/claude-opus-4.8',
    });
    expect(insertedValues.projectId).toBeNull();
    expect(conflictConfig.target).toHaveLength(3);
  });

  test('projectId is ignored for non-agent scopes (never written)', async () => {
    await upsertAccountModelPreference({
      accountId: 'a1',
      scope: 'project',
      scopeKey: 'p1',
      projectId: 'proj-a',
      model: 'glm-5.2',
    });
    expect(insertedValues.projectId).toBeNull();
  });

  test('onlyIfAbsent uses INSERT … ON CONFLICT DO NOTHING (idempotent seed)', async () => {
    await upsertAccountModelPreference({
      accountId: 'a1',
      scope: 'project',
      scopeKey: 'p1',
      model: 'glm-5.2',
      onlyIfAbsent: true,
    });
    expect(conflictMode).toBe('nothing');
  });
});

describe('deleteAccountModelPreference', () => {
  test('agent scope with a projectId only targets that project\'s row', async () => {
    await deleteAccountModelPreference({ accountId: 'a1', scope: 'agent', scopeKey: 'kortix', projectId: 'proj-a' });
    expect(deleteWhereArgs.length).toBeGreaterThan(0);
  });

  test('agent scope without a projectId targets the legacy (project_id IS NULL) row only', async () => {
    await deleteAccountModelPreference({ accountId: 'a1', scope: 'agent', scopeKey: 'kortix' });
    expect(deleteWhereArgs.length).toBeGreaterThan(0);
  });
});

// The join that lets a caller resolve the 'default' agent-name sentinel to
// the owning project's declared default agent (see default-model.ts's
// cachedSessionAgent) — the fix for agent-scope model pins silently never
// applying to sessions whose agent_name never resolved past 'default'.
describe('getSessionAgentContext', () => {
  test('no row for sessionId → null', async () => {
    selectRows = [];
    expect(await getSessionAgentContext('s-missing')).toBeNull();
  });

  test('carries the joined project.metadata.default_agent as projectDefaultAgent', async () => {
    selectRows = [
      { agentName: 'default', metadata: {}, projectMetadata: { default_agent: 'kortix' } },
    ];
    const ctx = await getSessionAgentContext('s1');
    expect(ctx).toEqual({ agentName: 'default', opencodeModel: null, projectDefaultAgent: 'kortix' });
  });

  test('project metadata with no default_agent → projectDefaultAgent null', async () => {
    selectRows = [{ agentName: 'default', metadata: {}, projectMetadata: { git: {} } }];
    const ctx = await getSessionAgentContext('s1');
    expect(ctx?.projectDefaultAgent).toBeNull();
  });

  test('null project metadata (left join miss / never happens in practice, but must not throw) → projectDefaultAgent null', async () => {
    selectRows = [{ agentName: 'default', metadata: {}, projectMetadata: null }];
    const ctx = await getSessionAgentContext('s1');
    expect(ctx?.projectDefaultAgent).toBeNull();
  });

  test('blank-string default_agent is treated as unset', async () => {
    selectRows = [{ agentName: 'default', metadata: {}, projectMetadata: { default_agent: '   ' } }];
    const ctx = await getSessionAgentContext('s1');
    expect(ctx?.projectDefaultAgent).toBeNull();
  });

  test('still surfaces the session-level opencode_model override unchanged', async () => {
    selectRows = [
      {
        agentName: 'release-bot',
        metadata: { opencode_model: 'anthropic/claude-opus-4.8' },
        projectMetadata: { default_agent: 'kortix' },
      },
    ];
    const ctx = await getSessionAgentContext('s1');
    expect(ctx).toEqual({
      agentName: 'release-bot',
      opencodeModel: 'anthropic/claude-opus-4.8',
      projectDefaultAgent: 'kortix',
    });
  });
});
