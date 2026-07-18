import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { GatewayResolutionError } from '@kortix/llm-gateway';
import * as resolveCandidatesModule from './resolve-candidates';
import * as modelPreferencesModule from '../../repositories/model-preferences';
import * as secretsModule from '../../projects/secrets';
import {
  invalidateAccountModelDefaults,
  isModelServableForAccount,
  resolveDefaultModelForPrincipal,
  resolveEffectiveModel,
} from './default-model';

// The regression this whole file guards against: tonight's error-taxonomy
// change made resolveCandidates THROW a typed GatewayResolutionError
// (provider_not_connected, etc.) instead of returning `[]` when a model isn't
// servable. That's correct for an actual generation request, but every
// caller in default-model.ts (isModelServableForAccount, and everything that
// probes through it — resolveDefaultModelForPrincipal used at auth time for
// EVERY gateway request, and resolveEffectiveModel used by the
// /model-defaults GET route + the model picker) was built against the old
// return-`[]` contract.
//
// This spies on the individual named exports (spyOn + mock.restore()) rather
// than replacing the whole modules with mock.module() — `./resolve-candidates`
// is itself the system-under-test of resolve-candidates.test.ts, and
// `../../repositories/model-preferences` / `../../projects/secrets` are each
// mocked wholesale by OTHER sibling test files (seed-default.test.ts,
// resolve-candidates.test.ts) with different shapes; mock.module() replaces a
// module for the whole bun test PROCESS (every *.test.ts file runs together —
// see scripts/test.sh), so it would corrupt those files' runs. spyOn+restore
// is scoped to this file's own test lifecycle instead.

let resolveCandidatesImpl: (model: string) => Promise<Array<{ provider: string }>> = async () => [];
let accountDefaults: { account: string | null; agents: Record<string, string>; projects: Record<string, string> } = {
  account: null,
  agents: {},
  projects: {},
};
let connectedSecretNames: string[] = [];

beforeEach(() => {
  resolveCandidatesImpl = async () => [];
  accountDefaults = { account: null, agents: {}, projects: {} };
  connectedSecretNames = [];
  // resolveDefaultModelForPrincipal reads through a module-level 30s-TTL cache
  // (cachedAccountDefaults) keyed by accountId — every test below reuses the
  // same PRINCIPAL_BASE.accountId, so without this the FIRST test's defaults
  // would silently serve every later test regardless of the fresh
  // `accountDefaults` set above (a test-isolation footgun, not a prod bug: a
  // real accountId is never reused cross-request within 30s in production).
  invalidateAccountModelDefaults(PRINCIPAL_BASE.accountId);

  spyOn(resolveCandidatesModule, 'resolveCandidates').mockImplementation(
    // The real return is Promise<UpstreamDescriptor[]>; these tests only care
    // about the LENGTH of the candidate list (servable = length > 0) and the
    // typed-error throw path, so a minimal { provider } stub is enough — cast
    // through the resolver's signature so tsc accepts the narrowed test double.
    ((_principal: unknown, model: string) => resolveCandidatesImpl(model)) as typeof resolveCandidatesModule.resolveCandidates,
  );
  spyOn(modelPreferencesModule, 'getAccountModelDefaults').mockImplementation(async () => accountDefaults);
  spyOn(modelPreferencesModule, 'getSessionAgentContext').mockImplementation(async () => null);
  spyOn(secretsModule, 'listProjectSecretsSnapshot').mockImplementation(async () => ({
    env: {},
    names: connectedSecretNames,
    revision: 'test',
  }));
});

afterEach(() => {
  mock.restore();
});

const PRINCIPAL_BASE = { userId: 'u1', accountId: 'a1', projectId: 'p1' };

describe('isModelServableForAccount — never 500s a passive servability check', () => {
  test('resolveCandidates throwing a typed GatewayResolutionError → false, not a throw', async () => {
    resolveCandidatesImpl = async () => {
      throw new GatewayResolutionError(
        'provider_not_connected',
        'No openrouter API key is connected for this project.',
        'Add an openrouter API key in project settings, then retry.',
      );
    };
    await expect(
      isModelServableForAccount({ ...PRINCIPAL_BASE, freeModelsOnly: false, model: 'openrouter/some-model' }),
    ).resolves.toBe(false);
  });

  test('every GatewayResolutionError reason collapses to false (model_not_found, plan_upgrade_required, ...)', async () => {
    for (const reason of ['model_not_found', 'plan_upgrade_required', 'model_disabled_on_deployment'] as const) {
      resolveCandidatesImpl = async () => {
        throw new GatewayResolutionError(reason, 'nope', 'do something');
      };
      await expect(
        isModelServableForAccount({ ...PRINCIPAL_BASE, freeModelsOnly: false, model: 'x/y' }),
      ).resolves.toBe(false);
    }
  });

  test('a non-GatewayResolutionError bug still propagates (never silently swallowed)', async () => {
    resolveCandidatesImpl = async () => {
      throw new Error('unexpected DB failure');
    };
    await expect(
      isModelServableForAccount({ ...PRINCIPAL_BASE, freeModelsOnly: false, model: 'x/y' }),
    ).rejects.toThrow('unexpected DB failure');
  });

  test('a real candidate list → true', async () => {
    resolveCandidatesImpl = async () => [{ provider: 'openai' }];
    await expect(
      isModelServableForAccount({ ...PRINCIPAL_BASE, freeModelsOnly: false, model: 'openai/gpt-5.5' }),
    ).resolves.toBe(true);
  });
});

describe('resolveEffectiveModel — the /model-defaults GET + picker resolution path', () => {
  test('nothing configured → platform default, no resolution/secrets calls at all', async () => {
    const result = await resolveEffectiveModel({
      ...PRINCIPAL_BASE,
      freeModelsOnly: false,
    });
    expect(result).toEqual({ model: null, source: 'platform' });
    expect(resolveCandidatesModule.resolveCandidates).not.toHaveBeenCalled();
    expect(secretsModule.listProjectSecretsSnapshot).not.toHaveBeenCalled();
  });

  test('a servable configured project default is returned as-is (real source, no degrade)', async () => {
    accountDefaults = { account: null, agents: {}, projects: { p1: 'openai/gpt-5.5' } };
    resolveCandidatesImpl = async () => [{ provider: 'openai' }];
    const result = await resolveEffectiveModel({ ...PRINCIPAL_BASE, freeModelsOnly: false });
    expect(result).toEqual({ model: 'openai/gpt-5.5', source: 'project' });
  });

  test('THE ESSENTIA BUG: a stale/unservable configured default (e.g. disconnected openrouter) never 500s, and degrades to a provider the project HAS connected', async () => {
    accountDefaults = { account: null, agents: {}, projects: { p1: 'openrouter/some-model' } };
    // The configured openrouter default is no longer servable — no key connected.
    resolveCandidatesImpl = async (model) => {
      if (model === 'openrouter/some-model') {
        throw new GatewayResolutionError(
          'provider_not_connected',
          'No openrouter API key is connected for this project.',
          'Add an openrouter API key in project settings, then retry.',
        );
      }
      return [{ provider: 'x' }];
    };
    // But the project HAS OpenAI (and Bedrock) BYOK connected.
    connectedSecretNames = ['OPENAI_API_KEY', 'AWS_BEARER_TOKEN_BEDROCK'];

    const result = await resolveEffectiveModel({ ...PRINCIPAL_BASE, freeModelsOnly: false });

    // Never throws/500s, AND never surfaces the dead openrouter ref.
    expect(result.model).not.toBeNull();
    expect(result.model).not.toBe('openrouter/some-model');
    expect(result.model?.startsWith('openrouter/')).toBe(false);
    // Resolves to a model on a provider the project actually has a key for.
    expect(result.model?.startsWith('openai/') || result.model?.startsWith('amazon-bedrock/')).toBe(true);
    expect(result.source).toBe('platform');
  });

  test('stale configured default AND nothing connected → degrades to plain platform default (unchanged pre-existing behavior), still no throw', async () => {
    accountDefaults = { account: null, agents: {}, projects: { p1: 'openrouter/some-model' } };
    resolveCandidatesImpl = async () => {
      throw new GatewayResolutionError('provider_not_connected', 'nope', 'connect it');
    };
    connectedSecretNames = [];

    const result = await resolveEffectiveModel({ ...PRINCIPAL_BASE, freeModelsOnly: false });
    expect(result).toEqual({ model: null, source: 'platform' });
  });

  test('an explicit pin that is unservable degrades through the same chain (never throws)', async () => {
    accountDefaults = { account: null, agents: {}, projects: {} };
    resolveCandidatesImpl = async () => {
      throw new GatewayResolutionError('provider_not_connected', 'nope', 'connect it');
    };
    const result = await resolveEffectiveModel({
      ...PRINCIPAL_BASE,
      explicit: 'openrouter/some-model',
      freeModelsOnly: false,
    });
    expect(result).toEqual({ model: null, source: 'platform' });
  });
});

// Regression coverage for the agent-model-pin project-scoping fix: agent
// defaults are now project-scoped (repositories/model-preferences.ts), so
// the 30s prefs cache here (keyed by accountId alone, pre-fix) must be keyed
// by (accountId, projectId) too — otherwise the FIRST project to resolve
// `auto` on an account would poison the cache for every OTHER project on
// that same account for up to 30s.
describe('resolveDefaultModelForPrincipal — prefs cache is scoped per (account, project)', () => {
  test('the principal\'s projectId is threaded through to getAccountModelDefaults', async () => {
    await resolveDefaultModelForPrincipal({ ...PRINCIPAL_BASE, projectId: 'proj-a', freeModelsOnly: false });
    expect(modelPreferencesModule.getAccountModelDefaults).toHaveBeenCalledWith(
      PRINCIPAL_BASE.accountId,
      'proj-a',
    );
  });

  test('two projects on the SAME account never share a cached agent default', async () => {
    const byProject: Record<string, string> = { 'proj-a': 'anthropic/claude-opus-4.8', 'proj-b': 'openai/gpt-5.5' };
    spyOn(modelPreferencesModule, 'getAccountModelDefaults').mockImplementation(async (_accountId, projectId) => {
      const agents: Record<string, string> = projectId && byProject[projectId] ? { kortix: byProject[projectId] } : {};
      return { account: null, agents, projects: {} };
    });
    spyOn(modelPreferencesModule, 'getSessionAgentContext').mockImplementation(async () => ({
      agentName: 'kortix',
      opencodeModel: null,
      projectDefaultAgent: null,
    }));
    resolveCandidatesImpl = async () => [{ provider: 'x' }];

    const resultA = await resolveDefaultModelForPrincipal({
      ...PRINCIPAL_BASE,
      projectId: 'proj-a',
      sessionId: 'sess-a',
      freeModelsOnly: false,
    });
    const resultB = await resolveDefaultModelForPrincipal({
      ...PRINCIPAL_BASE,
      projectId: 'proj-b',
      sessionId: 'sess-b',
      freeModelsOnly: false,
    });

    expect(resultA).toBe('anthropic/claude-opus-4.8');
    expect(resultB).toBe('openai/gpt-5.5');
  });

  test('invalidateAccountModelDefaults(accountId) clears every project-keyed cache entry for that account', async () => {
    let call = 0;
    spyOn(modelPreferencesModule, 'getAccountModelDefaults').mockImplementation(async () => {
      call += 1;
      return { account: call === 1 ? 'before/model' : 'after/model', agents: {}, projects: {} };
    });
    resolveCandidatesImpl = async () => [{ provider: 'x' }];

    const first = await resolveDefaultModelForPrincipal({ ...PRINCIPAL_BASE, projectId: 'proj-a', freeModelsOnly: false });
    expect(first).toBe('before/model');
    // Still cached — a second call within the TTL must NOT hit getAccountModelDefaults again.
    const cached = await resolveDefaultModelForPrincipal({ ...PRINCIPAL_BASE, projectId: 'proj-a', freeModelsOnly: false });
    expect(cached).toBe('before/model');
    expect(call).toBe(1);

    invalidateAccountModelDefaults(PRINCIPAL_BASE.accountId);
    const afterInvalidate = await resolveDefaultModelForPrincipal({ ...PRINCIPAL_BASE, projectId: 'proj-a', freeModelsOnly: false });
    expect(afterInvalidate).toBe('after/model');
    expect(call).toBe(2);
  });
});

describe('resolveDefaultModelForPrincipal — the real "auto" resolution used at generation time', () => {
  test('nothing configured → undefined (fast path, unchanged — never touches resolveCandidates)', async () => {
    const result = await resolveDefaultModelForPrincipal({ ...PRINCIPAL_BASE, freeModelsOnly: false });
    expect(result).toBeUndefined();
    expect(resolveCandidatesModule.resolveCandidates).not.toHaveBeenCalled();
  });

  test('a stale/unservable configured default degrades to a CONNECTED provider, not an unconnected platform default, for a real chat/generation request', async () => {
    accountDefaults = { account: 'openrouter/some-model', agents: {}, projects: {} };
    resolveCandidatesImpl = async (model) => {
      if (model === 'openrouter/some-model') {
        throw new GatewayResolutionError('provider_not_connected', 'nope', 'connect it');
      }
      return [{ provider: 'x' }];
    };
    connectedSecretNames = ['OPENAI_API_KEY'];

    const result = await resolveDefaultModelForPrincipal({ ...PRINCIPAL_BASE, freeModelsOnly: false });
    expect(result).toBeDefined();
    expect(result).not.toBe('openrouter/some-model');
    expect(result?.startsWith('openai/')).toBe(true);
  });

  test('a stale configured default with nothing connected degrades to undefined (platform default applies), never throws', async () => {
    accountDefaults = { account: 'openrouter/some-model', agents: {}, projects: {} };
    resolveCandidatesImpl = async () => {
      throw new GatewayResolutionError('provider_not_connected', 'nope', 'connect it');
    };
    connectedSecretNames = [];

    const result = await resolveDefaultModelForPrincipal({ ...PRINCIPAL_BASE, freeModelsOnly: false });
    expect(result).toBeUndefined();
  });
});

// Regression coverage for the "agent-scope model pins silently never apply"
// bug: session creation stores the non-binding 'default' sentinel in
// project_sessions.agent_name whenever project.metadata.default_agent wasn't
// populated at the time (common — e.g. a brand-new project whose kortix.yaml
// declares `default_agent: kortix` but whose DB metadata mirror never learned
// it). Before this fix, resolveDefaultModelForPrincipal looked up
// `agentDefaults['default']` — which never matches a pin set on the real
// agent name ('kortix') — and silently fell through to the project/account/
// platform default instead of the pinned (possibly pricier / provider-
// mismatched) model, with no error anywhere. cachedSessionAgent now resolves
// the sentinel to the project's declared default agent (getSessionAgentContext's
// projectDefaultAgent, mirroring kortix.yaml/PUT-default-agent) before doing
// the agentDefaults lookup.
describe('resolveDefaultModelForPrincipal — agent-scope pin applies to a session stuck on the "default" sentinel', () => {
  test('THE BUG: session.agent_name is the sentinel, but the project declares "kortix" as its default agent and "kortix" has a pin → the pin applies', async () => {
    accountDefaults = {
      account: null,
      agents: { kortix: 'anthropic/claude-opus-4.8' },
      projects: {},
    };
    spyOn(modelPreferencesModule, 'getSessionAgentContext').mockImplementation(async () => ({
      agentName: 'default',
      opencodeModel: null,
      projectDefaultAgent: 'kortix',
    }));
    resolveCandidatesImpl = async () => [{ provider: 'anthropic' }];

    const result = await resolveDefaultModelForPrincipal({
      ...PRINCIPAL_BASE,
      sessionId: 'sess-pin-applies',
      freeModelsOnly: false,
    });

    expect(result).toBe('anthropic/claude-opus-4.8');
  });

  test('an explicit (non-sentinel) session agent still wins over the project default, even when both have pins', async () => {
    accountDefaults = {
      account: null,
      agents: { kortix: 'anthropic/claude-opus-4.8', 'release-bot': 'openai/gpt-5.5' },
      projects: {},
    };
    spyOn(modelPreferencesModule, 'getSessionAgentContext').mockImplementation(async () => ({
      agentName: 'release-bot',
      opencodeModel: null,
      projectDefaultAgent: 'kortix',
    }));
    resolveCandidatesImpl = async () => [{ provider: 'openai' }];

    const result = await resolveDefaultModelForPrincipal({
      ...PRINCIPAL_BASE,
      sessionId: 'sess-explicit-wins',
      freeModelsOnly: false,
    });

    expect(result).toBe('openai/gpt-5.5');
  });

  test('sentinel with no project default configured falls through to project/account/platform (unchanged pre-existing behavior)', async () => {
    accountDefaults = {
      account: 'openai/gpt-5.5',
      agents: { kortix: 'anthropic/claude-opus-4.8' },
      projects: {},
    };
    spyOn(modelPreferencesModule, 'getSessionAgentContext').mockImplementation(async () => ({
      agentName: 'default',
      opencodeModel: null,
      projectDefaultAgent: null,
    }));
    resolveCandidatesImpl = async () => [{ provider: 'openai' }];

    const result = await resolveDefaultModelForPrincipal({
      ...PRINCIPAL_BASE,
      sessionId: 'sess-no-project-default',
      freeModelsOnly: false,
    });

    // No agent pin matched (neither 'default' nor any resolved name) → falls
    // through to the account default.
    expect(result).toBe('openai/gpt-5.5');
  });

  test('sentinel resolves to a project default that has NO pin of its own → still falls through to account default', async () => {
    accountDefaults = {
      account: 'openai/gpt-5.5',
      agents: { 'some-other-agent': 'anthropic/claude-opus-4.8' },
      projects: {},
    };
    spyOn(modelPreferencesModule, 'getSessionAgentContext').mockImplementation(async () => ({
      agentName: 'default',
      opencodeModel: null,
      projectDefaultAgent: 'kortix',
    }));
    resolveCandidatesImpl = async () => [{ provider: 'openai' }];

    const result = await resolveDefaultModelForPrincipal({
      ...PRINCIPAL_BASE,
      sessionId: 'sess-project-default-no-pin',
      freeModelsOnly: false,
    });

    expect(result).toBe('openai/gpt-5.5');
  });
});
