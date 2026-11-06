import { CATALOG } from '@kortix/llm-catalog';
import { describe, expect, test } from 'bun:test';

import {
  FIRST_CLASS_PROVIDER_IDS,
  type LlmProviderCatalogSource,
  PROVIDER_SUBSCRIPTIONS,
  buildLlmProviderCatalog,
  connectionAccessSummary,
  connectionLabelOwnerName,
  connectionNeedsReconnection,
  connectionSharing,
  orderProviderRows,
  providerConnectMethod,
  providerConnectedVia,
  providerDisconnectPlan,
  providerIdsWithCredentials,
  providerKeyAccessFields,
  supportsPooledProviderKey,
} from './provider-connections';

// Moved from packages/ui (internal/lib/account-secret-access, llm-providers,
// customize/sections/llm-provider/utils) so every host reads one set of rules.

const BAKED = buildLlmProviderCatalog(CATALOG as LlmProviderCatalogSource);
const BY_ID = new Map(BAKED.map((entry) => [entry.id, entry]));
const connectedIds = (secretNames: Set<string>) => providerIdsWithCredentials(BAKED, secretNames);

const ME = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const THIRD = '33333333-3333-4333-8333-333333333333';

describe('providerKeyAccessFields — who can use a new API key', () => {
  test('only you grants nobody else; the API adds the creator itself', () => {
    expect(providerKeyAccessFields('private', [OTHER])).toEqual({ access_mode: 'members', user_ids: [] });
  });

  test('everyone in the project', () => {
    expect(providerKeyAccessFields('project', [OTHER])).toEqual({ access_mode: 'project', user_ids: [] });
  });

  test('specific members names them', () => {
    expect(providerKeyAccessFields('members', [OTHER, THIRD])).toEqual({ access_mode: 'members', user_ids: [OTHER, THIRD] });
  });
});

describe('connectionSharing — who can use a new ChatGPT account', () => {
  test('only you is private to the connecting member', () => {
    expect(connectionSharing('private', [OTHER], ME)).toEqual({ mode: 'private', ownerId: ME });
  });

  test('only you before the viewer is known stays owner-only', () => {
    expect(connectionSharing('private', [], undefined)).toEqual({ mode: 'members', memberIds: [] });
  });

  test('everyone in the project', () => {
    expect(connectionSharing('project', [OTHER], ME)).toEqual({ mode: 'project' });
  });

  test('specific members names them', () => {
    expect(connectionSharing('members', [OTHER], ME)).toEqual({ mode: 'members', memberIds: [OTHER] });
  });

  test('specific members with nobody selected is only you', () => {
    expect(connectionSharing('members', [], ME)).toEqual({ mode: 'private', ownerId: ME });
  });
});

describe('connectionAccessSummary — the access line on a connection row', () => {
  const row = (access_mode: 'project' | 'members', granted_user_ids: string[], created_by = ME) =>
    ({ access_mode, granted_user_ids, created_by });

  test('project access', () => {
    expect(connectionAccessSummary(row('project', []), ME)).toEqual({ kind: 'project' });
  });

  test('your own private connection', () => {
    expect(connectionAccessSummary(row('members', [ME]), ME)).toEqual({ kind: 'you' });
  });

  test("another member's private connection names its owner", () => {
    expect(connectionAccessSummary(row('members', [OTHER], OTHER), ME)).toEqual({ kind: 'owner', ownerId: OTHER });
  });

  test('shared with selected members counts every grantee', () => {
    expect(connectionAccessSummary(row('members', [ME, OTHER, THIRD]), ME)).toEqual({ kind: 'members', count: 3 });
  });

  test('a legacy restricted connection without its creator counts grantees', () => {
    expect(connectionAccessSummary(row('members', [], OTHER), ME)).toEqual({ kind: 'members', count: 0 });
  });
});

describe('connectionLabelOwnerName — the name in a new account default label', () => {
  test('first name from the full name', () => {
    expect(connectionLabelOwnerName({ email: 'ada@example.test', user_metadata: { full_name: '  Ada Lovelace ' } })).toBe('Ada');
  });

  test('falls back to the name, then the email local part', () => {
    expect(connectionLabelOwnerName({ email: 'ada@example.test', user_metadata: { name: 'Countess' } })).toBe('Countess');
    expect(connectionLabelOwnerName({ email: 'ada.l@example.test', user_metadata: {} })).toBe('ada.l');
  });

  test('no user yields no name', () => {
    expect(connectionLabelOwnerName(null)).toBe('');
  });
});

// The gateway marks an account whose login stopped working (needs_reauth_at);
// an inactive account needed reconnection before that mark existed.
describe('connectionNeedsReconnection — a ChatGPT account the viewer must sign in to again', () => {
  test('a marked account needs reconnection', () => {
    expect(connectionNeedsReconnection({ active: true, needs_reauth_at: '2026-09-25T10:00:00.000Z' })).toBe(true);
  });

  test('an inactive account needs reconnection', () => {
    expect(connectionNeedsReconnection({ active: false, needs_reauth_at: null })).toBe(true);
  });

  test('a working account does not, including from an API without the field', () => {
    expect(connectionNeedsReconnection({ active: true, needs_reauth_at: null })).toBe(false);
    expect(connectionNeedsReconnection({ active: true })).toBe(false);
  });
});

describe('orderProviderRows — a saved key never moves a row', () => {
  const p = (id: string, envVars = [`${id.toUpperCase()}_API_KEY`]) => ({
    id,
    label: id[0].toUpperCase() + id.slice(1),
    envVars,
  });
  const CATALOG = [p('anthropic'), p('openai'), p('google'), p('groq'), p('mistral')];
  const FIRST_CLASS = ['anthropic', 'openai', 'google'] as const;
  const order = (connected: string[], search = '') =>
    orderProviderRows({
      providers: CATALOG,
      firstClassIds: FIRST_CLASS,
      connectedIds: new Set(connected),
      search,
    }).map((provider) => provider.id);

  test('the whole catalog renders, first-class three first, then catalog order', () => {
    expect(order([])).toEqual(['anthropic', 'openai', 'google', 'groq', 'mistral']);
  });

  // THE regression. Anthropic is first before it has a key and first after.
  test('connecting a first-class provider does not change its position', () => {
    expect(order([])).toEqual(order(['anthropic']));
    expect(order(['anthropic'])[0]).toBe('anthropic');
  });

  test('connecting every one of them still does not reorder anything', () => {
    expect(order(['google', 'openai', 'anthropic'])).toEqual(order([]));
  });

  // THE second regression, and the reason the long tail is not sorted by
  // connectedness: a connected provider keeps its catalog position instead of
  // being promoted above the ones next to it.
  test('connecting a long-tail provider does not move it either', () => {
    expect(order(['groq'])).toEqual(['anthropic', 'openai', 'google', 'groq', 'mistral']);
  });

  test('an unconnected long-tail provider is listed anyway — every provider shows', () => {
    expect(order([])).toContain('groq');
    expect(order([])).toContain('mistral');
  });

  test('a connected provider is never listed twice', () => {
    const ids = order(['anthropic', 'groq']);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('search replaces the list with catalog matches, connected or not', () => {
    expect(order([], 'gro')).toEqual(['groq']);
    expect(order(['groq'], 'gro')).toEqual(['groq']);
  });

  test('search matches label, id, and env-var name', () => {
    const bedrock = { id: 'amazon-bedrock', label: 'AWS Bedrock', envVars: ['AWS_ACCESS_KEY_ID'] };
    const find = (search: string) =>
      orderProviderRows({
        providers: [...CATALOG, bedrock],
        firstClassIds: FIRST_CLASS,
        connectedIds: new Set<string>(),
        search,
      }).map((provider) => provider.id);

    expect(find('bedrock')).toEqual(['amazon-bedrock']);
    expect(find('AWS Bed')).toEqual(['amazon-bedrock']);
    expect(find('aws_access')).toEqual(['amazon-bedrock']);
  });

  test('whitespace is not a search — it shows the ordered full list, unfiltered', () => {
    expect(order([], '   ')).toEqual(['anthropic', 'openai', 'google', 'groq', 'mistral']);
  });

  test('a first-class id missing from the catalog is skipped, not rendered empty', () => {
    const ids = orderProviderRows({
      providers: [p('openai')],
      firstClassIds: FIRST_CLASS,
      connectedIds: new Set<string>(),
      search: '',
    }).map((provider) => provider.id);
    expect(ids).toEqual(['openai']);
  });
});

describe('providerDisconnectPlan', () => {
  test('uses the OAuth removal route for ChatGPT and deletes only its legacy row directly', () => {
    expect(
      providerDisconnectPlan({
        id: 'codex',
        envVars: ['CODEX_AUTH_JSON', 'OPENCODE_AUTH_JSON'],
      }),
    ).toEqual({ oauthProvider: 'openai', secretNames: ['OPENCODE_AUTH_JSON'] });
  });

  test('removes an OpenAI API key and the subscription credentials', () => {
    expect(providerDisconnectPlan({ id: 'openai', envVars: ['OPENAI_API_KEY'] })).toEqual({
      oauthProvider: 'openai',
      secretNames: ['OPENAI_API_KEY', 'OPENCODE_AUTH_JSON'],
    });
  });

  test('uses secret removal only for a regular provider', () => {
    expect(providerDisconnectPlan({ id: 'anthropic', envVars: ['ANTHROPIC_API_KEY'] })).toEqual({
      oauthProvider: null,
      secretNames: ['ANTHROPIC_API_KEY'],
    });
  });
});

describe('buildLlmProviderCatalog — amazon-bedrock connect requirements', () => {
  test('the connect form only asks for the bearer token + region, not the SigV4 pair', () => {
    expect(BY_ID.get('amazon-bedrock')?.envVars).toEqual(['AWS_BEARER_TOKEN_BEDROCK', 'AWS_REGION']);
  });

  test('Anthropic and OpenAI lead the catalogue, in that order', () => {
    expect(BAKED.slice(0, 2).map((entry) => entry.id)).toEqual(['anthropic', 'openai']);
  });
});

describe('providerIdsWithCredentials — Bedrock (bearer token + region)', () => {
  test('a project with ONLY AWS_BEARER_TOKEN_BEDROCK + AWS_REGION secrets shows amazon-bedrock as connected', () => {
    const connected = connectedIds(new Set(['AWS_BEARER_TOKEN_BEDROCK', 'AWS_REGION']));
    expect(connected.has('amazon-bedrock')).toBe(true);
  });

  test('a partially-configured Bedrock (bearer token only) does NOT show as connected', () => {
    const connected = connectedIds(new Set(['AWS_BEARER_TOKEN_BEDROCK']));
    expect(connected.has('amazon-bedrock')).toBe(false);
  });

  test('a partially-configured Bedrock (region only) does NOT show as connected', () => {
    const connected = connectedIds(new Set(['AWS_REGION']));
    expect(connected.has('amazon-bedrock')).toBe(false);
  });

  test('the SigV4 access-key pair alone does not connect it (unimplemented auth path)', () => {
    const connected = connectedIds(
      new Set(['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION']),
    );
    expect(connected.has('amazon-bedrock')).toBe(false);
  });

  test('no secrets at all connects nothing', () => {
    expect(connectedIds(new Set()).size).toBe(0);
  });
});

describe('providerIdsWithCredentials — Google alias fix', () => {
  test('any single Google key alias connects it', () => {
    expect(connectedIds(new Set(['GOOGLE_GENERATIVE_AI_API_KEY'])).has('google')).toBe(
      true,
    );
    expect(connectedIds(new Set(['GOOGLE_API_KEY'])).has('google')).toBe(true);
    expect(connectedIds(new Set(['GEMINI_API_KEY'])).has('google')).toBe(true);
  });
});

describe('providerIdsWithCredentials — unaffected single-var providers', () => {
  test('anthropic still connects the same way as before', () => {
    expect(connectedIds(new Set(['ANTHROPIC_API_KEY'])).has('anthropic')).toBe(true);
  });
});

describe('provider display names — verbatim from models.dev, never hand-renamed', () => {
  // Reproduces Marko's exact bug report: models.dev names the three
  // Moonshot-family providers DISTINCTLY (moonshotai → "Moonshot AI",
  // moonshotai-cn → "Moonshot AI (China)", kimi-for-coding → "Kimi For
  // Coding"), but the UI used to collapse two of them to a hand-maintained
  // "Moonshot" label, making them look identical ("why do we have two
  // providers called Moonshot?"). toEntry()/`label: raw.name` must carry the
  // real, distinct name straight through with no override.
  const raw: LlmProviderCatalogSource = {
    source: 'https://models.dev/api.json',
    fetched_at: '2026-07-17T00:00:00.000Z',
    provider_count: 3,
    model_count: 3,
    providers: [
      {
        id: 'moonshotai',
        name: 'Moonshot AI',
        env: ['MOONSHOT_API_KEY'],
        doc: 'https://platform.moonshot.ai/docs',
        models: [{ id: 'kimi-k3', name: 'Kimi K3', released: '2026-07-01' }],
      },
      {
        id: 'moonshotai-cn',
        name: 'Moonshot AI (China)',
        env: ['MOONSHOT_API_KEY'],
        doc: 'https://platform.moonshot.cn/docs',
        models: [{ id: 'kimi-k3', name: 'Kimi K3', released: '2026-07-01' }],
      },
      {
        id: 'kimi-for-coding',
        name: 'Kimi For Coding',
        env: ['KIMI_API_KEY'],
        doc: 'https://api.kimi.com/coding/v1',
        models: [
          { id: 'k2p7', name: 'Kimi K2p7', released: '2026-05-01' },
          {
            id: 'kimi-for-coding-highspeed',
            name: 'Kimi For Coding Highspeed',
            released: '2026-07-10',
          },
          { id: 'k3', name: 'Kimi K3', released: '2026-07-15' },
        ],
      },
    ],
  };

  test('all three Moonshot-family providers keep their own, distinct models.dev name', () => {
    const entries = buildLlmProviderCatalog(raw);
    const byId = new Map(entries.map((e) => [e.id, e]));
    expect(byId.get('moonshotai')?.label).toBe('Moonshot AI');
    expect(byId.get('moonshotai-cn')?.label).toBe('Moonshot AI (China)');
    expect(byId.get('kimi-for-coding')?.label).toBe('Kimi For Coding');
    // The actual bug: two of these must NEVER render identically.
    const labels = new Set(entries.map((e) => e.label));
    expect(labels.size).toBe(entries.length);
  });

  test("the connect modal help URL is models.dev's own doc field, not a rewritten one", () => {
    const entries = buildLlmProviderCatalog(raw);
    expect(entries.find((e) => e.id === 'kimi-for-coding')?.helpUrl).toBe(
      'https://api.kimi.com/coding/v1',
    );
  });

  test('the hint is derived from the live model list (proves Kimi K3 + highspeed variants surface), never a hardcoded description', () => {
    const entries = buildLlmProviderCatalog(raw);
    const kimiForCoding = entries.find((e) => e.id === 'kimi-for-coding');
    expect(kimiForCoding?.models.map((m) => m.id)).toEqual([
      'k2p7',
      'kimi-for-coding-highspeed',
      'k3',
    ]);
    // Derived hint names real models from the given catalog — not a fixed
    // marketing string that would silently miss a new release like K3.
    expect(kimiForCoding?.hint).toContain('Kimi K2p7');
    expect(kimiForCoding?.hint).not.toBe('AWS Bedrock — Claude, Llama, Titan');
  });
});

describe('providerIdsWithCredentials — a ChatGPT sign-in connects provider codex', () => {
  test('CODEX_AUTH_JSON connects codex, not openai', () => {
    const ids = connectedIds(new Set(['CODEX_AUTH_JSON']));
    expect(ids.has('codex')).toBe(true);
    expect(ids.has('openai')).toBe(false);
  });

  test('the legacy OPENCODE_AUTH_JSON row connects codex too', () => {
    expect(connectedIds(new Set(['OPENCODE_AUTH_JSON'])).has('codex')).toBe(true);
  });

  test('kortix is never a credential provider', () => {
    expect(connectedIds(new Set(['KORTIX_API_KEY'])).has('kortix')).toBe(false);
  });
});

describe('providerConnectMethod — how a provider is connected', () => {
  test('kortix and a managed entry are included', () => {
    expect(providerConnectMethod({ id: 'kortix', envVars: [] })).toBe('included');
    expect(providerConnectMethod({ id: 'x', envVars: ['X_KEY'], managed: true })).toBe('included');
  });

  test('OpenAI, Claude and OpenCode Go offer a sign-in or a key', () => {
    for (const id of ['openai', 'anthropic', 'opencode-go']) {
      expect(providerConnectMethod({ id, envVars: ['K'] })).toBe('signInOrKey');
    }
  });

  test('a provider with fields takes a key; one without is sign-in only', () => {
    expect(providerConnectMethod({ id: 'groq', envVars: ['GROQ_API_KEY'] })).toBe('key');
    expect(providerConnectMethod({ id: 'github-copilot', envVars: [] })).toBe('signIn');
  });

  test('every subscription names its plan, its sign-in and the provider its models appear under', () => {
    expect(PROVIDER_SUBSCRIPTIONS.openai).toEqual({
      kind: 'chatgpt', name: 'ChatGPT', plan: 'ChatGPT Plus or Pro', oauthProvider: 'openai', modelProviderId: 'codex',
    });
    expect(PROVIDER_SUBSCRIPTIONS.anthropic).toEqual({
      kind: 'claude', name: 'Claude', plan: 'Claude Pro or Max', oauthProvider: null, modelProviderId: 'claude-agent',
    });
    expect(PROVIDER_SUBSCRIPTIONS['opencode-go']).toEqual({
      kind: 'opencode-go', name: 'OpenCode', plan: 'OpenCode Go', oauthProvider: 'opencode-go', modelProviderId: 'opencode-go',
    });
  });
});

describe('providerConnectedVia — OpenAI by sign-in, by key, or both', () => {
  test('codex is the sign-in, openai the key', () => {
    expect(providerConnectedVia('openai', new Set(['codex']))).toBe('signIn');
    expect(providerConnectedVia('openai', new Set(['openai']))).toBe('key');
    expect(providerConnectedVia('openai', new Set(['codex', 'openai']))).toBe('both');
    expect(providerConnectedVia('openai', new Set())).toBeUndefined();
  });

  test('other providers report nothing', () => {
    expect(providerConnectedVia('groq', new Set(['groq']))).toBeUndefined();
  });
});

describe('supportsPooledProviderKey — a key the gateway can pool', () => {
  test('one field and a known API host', () => {
    expect(supportsPooledProviderKey({ id: 'groq', envVars: ['GROQ_API_KEY'], apiHost: null })).toBe(true);
    expect(supportsPooledProviderKey({ id: 'zz', envVars: ['ZZ_KEY'], apiHost: 'api.zz.test' })).toBe(true);
  });

  test('several fields, or no host, cannot be pooled', () => {
    expect(supportsPooledProviderKey({ id: 'amazon-bedrock', envVars: ['A', 'B'], apiHost: 'x' })).toBe(false);
    expect(supportsPooledProviderKey({ id: 'zz', envVars: ['ZZ_KEY'], apiHost: null })).toBe(false);
    expect(supportsPooledProviderKey(undefined)).toBe(false);
  });

  test('the first-class providers are anthropic, openai, google', () => {
    expect([...FIRST_CLASS_PROVIDER_IDS]).toEqual(['anthropic', 'openai', 'google']);
  });
});
