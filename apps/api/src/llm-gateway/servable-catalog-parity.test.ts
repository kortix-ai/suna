/**
 * The model picker and the gateway resolver must agree: every model
 * `servableProjectCatalog` lists for a principal is runnable by that principal
 * — directly (`resolveCandidates` on an unconfigured session, the ChatGPT
 * shared-account fallback) or through the session's key selection
 * (`usableProviderKeys`, which session create / model change / sharing change
 * store). Enforcement for the 2026-09-26 incident (KRTX-431): with
 * `pooled_provider_secrets` ON, a ChatGPT account shared with the whole
 * project was listed by the picker while unconfigured sessions — Slack runs,
 * cron triggers, agent-started workers, a member who did not create the
 * account — failed their first turn with `provider_not_connected`, which read
 * as "flaky connections".
 */
import { describe, expect, mock, test } from 'bun:test';
import { GatewayResolutionError } from '@kortix/llm-gateway';

// ── One store every stub reads, so the two sides can only disagree through the
// code under test, never through divergent fixtures. ─────────────────────────

type AccountKey = {
  secretId: string;
  providerId: string;
  name: string;
  label: string;
  accessMode: 'project' | 'members';
  createdBy: string;
  active: boolean;
  value: string | null;
  cooldownUntil: Date | null;
};

let accountKeys: AccountKey[] = [];
let grants: Record<string, string[]> = {};
let members: string[] = [];
let projectSecrets: Record<string, string | null> = {};

const PROJECT = 'p1';
const ACCOUNT = 'a1';

const codexValue = (access: string) => JSON.stringify({ openai: { access } });

// ── The seams `servableProjectCatalog`, `resolveCandidates` and
// `usableProviderKeys` read. Same member gate, same rows, per the documented
// semantics of the real reads (`grantUserId: undefined` = the user's own
// grants; `null` = project-wide keys only). ──────────────────────────────────

function usableKeys(
  userId: string,
  grantUserId: string | null | undefined,
  filter?: { providerId?: string; name?: string; ids?: string[] },
) {
  const grant = grantUserId === undefined ? userId : grantUserId;
  return accountKeys.filter(
    (key) =>
      key.active &&
      (filter?.providerId === undefined || key.providerId === filter.providerId) &&
      (filter?.name === undefined || key.name === filter.name) &&
      (filter?.ids === undefined || filter.ids.includes(key.secretId)) &&
      (key.accessMode === 'project' ||
        (grant !== null && (grants[key.secretId] ?? []).includes(grant))),
  );
}

const memberGate = (userId: string) => members.includes(userId);

mock.module('../repositories/project-model-access', () => ({
  getProjectModelAccess: async () => ({ disabledProviders: [], disabledModels: [] }),
  getProjectGatewayResolution: async () => ({ access: { disabledProviders: [], disabledModels: [] }, pooledEnabled: true }),
}));

mock.module('../billing/services/entitlements', () => ({
  accountMayUseManagedModels: async () => true,
  getCachedAccountTier: async () => 'pro',
  getAccountTier: async () => 'pro',
}));

const listProjectSecretNamesForConsumer = mock(async () =>
  Object.entries(projectSecrets)
    .filter(([, value]) => value !== null)
    .map(([name]) => name),
);
const getProjectSecretValueForConsumer = mock(
  async (input: { name: string }) => projectSecrets[input.name] ?? null,
);
const resolveProjectSecretsForConsumer = mock(async (input: { name: string }) => {
  const value = await getProjectSecretValueForConsumer(input);
  return value ? [{ identifier: input.name, value }] : [];
});
mock.module('../projects/secrets', () => ({
  listProjectSecretNamesForConsumer,
  getProjectSecretValueForConsumer,
  resolveProjectSecretsForConsumer,
}));

mock.module('../feature-flags/for-project', () => ({
  projectFeatureFlagEnabled: async () => true,
}));

const resolveProjectSharedProviderSecrets = async (input: {
  accountId: string;
  projectId: string;
  userId: string;
  grantUserId?: string | null;
  providerId: string;
  name: string;
}) => {
  // Cooldowns skip a key for now; no case here seeds one, so `retryAfterSeconds`
  // (the real read computes the earliest release) is never exercised — the
  // PostgreSQL suite pins that behavior.
  const ready = usableKeys(input.userId, input.grantUserId, {
    providerId: input.providerId,
    name: input.name,
  }).filter((key) => !key.cooldownUntil || key.cooldownUntil.getTime() <= Date.now());
  return {
    coolingDown: false,
    secrets: ready.map((key) => ({
      secretId: key.secretId,
      label: key.label,
      value: key.value,
      updatedAt: new Date(0),
    })),
  };
};

const accountResource = {
  listUsableGatewaySecrets: async (input: {
    accountId: string;
    projectId: string;
    userId: string;
    grantUserId?: string | null;
    providerId?: string;
    name?: string;
  }) => {
    if (!memberGate(input.userId)) return [];
    return usableKeys(input.userId, input.grantUserId, {
      providerId: input.providerId,
      name: input.name,
    }).map((key) => ({
      secretId: key.secretId,
      providerId: key.providerId,
      name: key.name,
      label: key.label,
      accessMode: key.accessMode,
    }));
  },
  queryUsableGatewaySecrets: async (input: {
    accountId: string;
    projectId: string;
    userId: string;
    grantUserId?: string | null;
    providerId?: string;
    name?: string;
    ids?: string[];
  }) =>
    usableKeys(input.userId, input.grantUserId, {
      providerId: input.providerId,
      name: input.name,
      ids: input.ids,
    }).map((key) => ({
      secretId: key.secretId,
      providerId: key.providerId,
      name: key.name,
      label: key.label,
      accessMode: key.accessMode,
    })),
  listGrantedGatewaySecretNames: async (
    accountId: string,
    projectId: string,
    userId: string,
    personalUserId?: string | null,
  ): Promise<string[]> => [
    ...new Set(
      (
        await accountResource.listUsableGatewaySecrets({
          accountId,
          projectId,
          userId,
          grantUserId: personalUserId === undefined ? userId : personalUserId,
        })
      ).map((row) => row.name),
    ),
  ],
  resolveProjectSharedProviderSecrets,
  resolveDefaultCodexAccountSecret: async (
    accountId: string,
    projectId: string,
    userId: string,
  ) => {
    if (!memberGate(userId)) return null;
    const own = accountKeys
      .filter(
        (key) =>
          key.active &&
          key.providerId === 'codex' &&
          key.name === 'CODEX_AUTH_JSON' &&
          key.createdBy === userId,
      )
      .sort((a, b) => (a.secretId < b.secretId ? 1 : -1))[0];
    return own
      ? { secretId: own.secretId, label: own.label, value: own.value, updatedAt: new Date(0) }
      : null;
  },
  resolveSessionProviderSecrets: async (input: {
    accountId: string;
    projectId: string;
    userId: string;
    grantUserId?: string | null;
    providerId: string;
    name: string;
    secretIds?: string[];
  }) => {
    if (input.secretIds === undefined)
      return { configured: false, coolingDown: false, secrets: [] };
    const usable = usableKeys(input.userId, input.grantUserId, {
      providerId: input.providerId,
      name: input.name,
      ids: input.secretIds,
    });
    return {
      configured: true,
      coolingDown: false,
      secrets: usable.map((key) => ({
        secretId: key.secretId,
        label: key.label,
        value: key.value,
        updatedAt: new Date(0),
      })),
    };
  },
};

mock.module('../secrets/account-resource', () => accountResource);

mock.module('../config', () => ({
  config: { LLM_GATEWAY_ENABLED: true, KORTIX_MANAGED_PROVIDER_ENABLED: false },
}));

class CodexRefreshError extends Error {}
const resolveCodexCredential = mock(
  async (_projectId: string, _userId: string, _a: unknown, _b: unknown) => {
    const value = projectSecrets.CODEX_AUTH_JSON;
    return value ? { access: value } : null;
  },
);
const resolveCodexAccountCredential = mock(async (input: { value: string | null }) => {
  if (!input.value) return null;
  const parsed = JSON.parse(input.value) as { openai?: { access?: string } };
  return parsed.openai?.access ? { access: parsed.openai.access } : null;
});
mock.module('./credentials/codex', () => ({
  CHATGPT_CODEX_BASE_URL: 'https://chatgpt.com/backend-api/codex',
  CODEX_USER_AGENT: 'opencode-test',
  resolveCodexCredential,
  resolveCodexAccountCredential,
  CodexRefreshError,
}));

const realDescriptors = await import('./resolution/descriptors');
mock.module('./resolution/descriptors', () => ({
  ...realDescriptors,
  codexDescriptor: (credential: { access: string }, model: string) => ({
    provider: 'openai-codex',
    kind: 'openai-responses',
    baseUrl: 'https://codex.test',
    apiKey: credential.access,
    billingMode: 'none',
    markup: 0,
    resolvedModel: model,
  }),
  livePricing: () => undefined,
}));

mock.module('../repositories/model-preferences', () => ({
  getAccountModelDefaults: async () => ({ account: null, agents: {}, projects: {} }),
}));

mock.module('../repositories/project-routing-policies', () => ({
  getProjectRoutingPolicy: async () => null,
}));

const { servableProjectCatalog } = await import('./models/servable-catalog');
const { resolveCandidates } = await import('./resolution/resolve-candidates');
const { listGrantedGatewaySecretNames } = await import('../secrets/account-resource');
const { usableProviderKeys } = await import('../secrets/provider-key-selection');

/** A model the picker lists is one the sandbox registers and the composer offers. */
async function listedByokAndCodexModels(
  principalUserId: string | null,
  personalUserId: string | null,
): Promise<Map<string, string[]>> {
  const catalog = await servableProjectCatalog({
    projectId: PROJECT,
    accountId: ACCOUNT,
    principalUserId,
    personalUserId,
  });
  const byProvider = new Map<string, string[]>();
  for (const id of Object.keys(catalog.models)) {
    const slash = id.indexOf('/');
    if (slash < 1) continue;
    const provider = id.slice(0, slash);
    if (provider === 'kortix') continue;
    byProvider.set(provider, [...(byProvider.get(provider) ?? []), id]);
  }
  return byProvider;
}

function unconfiguredPrincipal(userId: string, personalUserId: string | null) {
  return {
    userId,
    accountId: ACCOUNT,
    projectId: PROJECT,
    freeModelsOnly: false,
    sessionId: 'session-unconfigured',
    personalUserId,
  };
}

async function resolvesUnconfigured(
  userId: string,
  personalUserId: string | null,
  model: string,
): Promise<boolean> {
  try {
    const candidates = await resolveCandidates(
      unconfiguredPrincipal(userId, personalUserId),
      model,
    );
    return candidates.length > 0;
  } catch (err) {
    if (err instanceof GatewayResolutionError) return false;
    throw err;
  }
}

/** The selection a model change or a session create would store for this session. */
async function runsAfterKeySelection(
  userId: string,
  personalUserId: string | null,
  model: string,
): Promise<boolean> {
  const selection = await usableProviderKeys({
    accountId: ACCOUNT,
    projectId: PROJECT,
    userId,
    grantUserId: personalUserId,
    model,
  });
  if (!selection) return false;
  const candidates = await resolveCandidates(unconfiguredPrincipal(userId, personalUserId), model, {
    providerSecretPools: { [selection.providerId]: selection.secretIds },
  });
  return candidates.length > 0;
}

/** Listed ⇒ runnable: directly, or through the selection the session stores. */
async function everyListedModelRuns(userId: string, personalUserId: string | null): Promise<void> {
  const listed = await listedByokAndCodexModels(userId, personalUserId);
  expect(listed.get('codex')?.length).toBeGreaterThan(0);
  for (const [provider, models] of listed) {
    for (const model of models) {
      const direct = await resolvesUnconfigured(userId, personalUserId, model);
      const ok = direct || (await runsAfterKeySelection(userId, personalUserId, model));
      expect(
        ok,
        `${provider} model ${model} is listed but this session can neither resolve nor select it`,
      ).toBe(true);
      if (provider === 'codex') {
        expect(
          direct,
          `codex model ${model} is listed but an unconfigured session cannot run it — the shared-account fallback is gone`,
        ).toBe(true);
      }
    }
  }
}

/**
 * One project: a legacy OpenAI key, a ChatGPT account shared with the whole
 * project (connected by u-creator), an Anthropic account shared with the whole
 * project (connected by u-member), and an Anthropic account restricted to
 * u-member. Members: u-creator, u-member.
 */
function seedProject() {
  members = ['u-creator', 'u-member'];
  grants = { 'anthropic-personal': ['u-member'] };
  projectSecrets = { OPENAI_API_KEY: 'sk-openai-legacy' };
  accountKeys = [
    {
      secretId: 'codex-team',
      providerId: 'codex',
      name: 'CODEX_AUTH_JSON',
      label: 'ChatGPT · Team',
      accessMode: 'project',
      createdBy: 'u-creator',
      active: true,
      value: codexValue('team-token'),
      cooldownUntil: null,
    },
    {
      secretId: 'anthropic-team',
      providerId: 'anthropic',
      name: 'ANTHROPIC_API_KEY',
      label: 'Anthropic · Team',
      accessMode: 'project',
      createdBy: 'u-member',
      active: true,
      value: 'sk-ant-team',
      cooldownUntil: null,
    },
    {
      secretId: 'anthropic-personal',
      providerId: 'anthropic',
      name: 'ANTHROPIC_API_KEY',
      label: 'Anthropic · Me',
      accessMode: 'members',
      createdBy: 'u-member',
      active: true,
      value: 'sk-ant-me',
      cooldownUntil: null,
    },
  ];
}

describe('servableProjectCatalog ↔ resolveCandidates parity (pooled provider secrets ON)', () => {
  test('a private session of the member who connected the accounts runs every listed model', async () => {
    seedProject();
    await everyListedModelRuns('u-creator', 'u-creator');
  });

  test('a member who connected nothing still runs every model their shared session lists', async () => {
    seedProject();
    await everyListedModelRuns('u-member', null);
  });

  test('the unconfigured-session fallback and the picker read the same ChatGPT accounts', async () => {
    seedProject();
    const names = await listGrantedGatewaySecretNames(ACCOUNT, PROJECT, 'u-member', null);
    expect(names).toContain('CODEX_AUTH_JSON');
    const shared = await resolveProjectSharedProviderSecrets({
      accountId: ACCOUNT,
      projectId: PROJECT,
      userId: 'u-member',
      grantUserId: null,
      providerId: 'codex',
      name: 'CODEX_AUTH_JSON',
    });
    expect(shared.secrets.map((secret) => secret.secretId)).toEqual(['codex-team']);
  });

  test('a member-restricted Anthropic account is selectable for, and only for, its grantee', async () => {
    seedProject();
    const listed = (await listedByokAndCodexModels('u-member', 'u-member')).get('anthropic') ?? [];
    const anthropicModel = listed[0];
    expect(anthropicModel, 'the picker lists the Anthropic accounts u-member holds').toBeTruthy();
    const granted = await usableProviderKeys({
      accountId: ACCOUNT,
      projectId: PROJECT,
      userId: 'u-member',
      grantUserId: 'u-member',
      model: anthropicModel,
    });
    expect(granted?.secretIds).toContain('anthropic-personal');
    const other = await usableProviderKeys({
      accountId: ACCOUNT,
      projectId: PROJECT,
      userId: 'u-creator',
      grantUserId: 'u-creator',
      model: anthropicModel,
    });
    expect(other?.secretIds).not.toContain('anthropic-personal');
  });

  test('repeated resolution attempts agree — the reported flakiness does not alternate', async () => {
    seedProject();
    for (let attempt = 0; attempt < 5; attempt++) {
      expect(await resolvesUnconfigured('u-member', null, 'codex/gpt-6')).toBe(true);
      expect(await resolvesUnconfigured('u-creator', 'u-creator', 'codex/gpt-6')).toBe(true);
    }
  });
});
