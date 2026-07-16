import { describe, expect, test } from 'bun:test';

import {
  connectedGatewayProviderIdsFromSecretNames,
  filterToGatewayProviders,
  filterToNativeProviders,
  mergeProjectSecretConnectedProviders,
  mergeProviderLists,
  normalizeProviderList,
  privateOnlyProviderIdsFromSecretNames,
  privateOnlySecretNamesForViewer,
  projectLlmCatalogToProviderList,
  providerListHasGateway,
  providerListHasModels,
  usableSecretNamesForViewer,
  type ProviderListResponse,
  type SecretUsabilityItem,
} from './provider-selection';

function providers(ids: string[]): ProviderListResponse {
  return {
    default: {},
    connected: ids,
    all: ids.map((id) => ({
      id,
      name: id,
      models: {
        [`${id}-model`]: { name: `${id} model` },
      },
    })),
  } as ProviderListResponse;
}

describe('provider-selection', () => {
  test('detects usable connected provider models', () => {
    expect(providerListHasModels(providers(['anthropic']))).toBe(true);
    expect(providerListHasModels({ default: {}, connected: [], all: [] } as ProviderListResponse)).toBe(false);
  });

  test('normalizes v0.9.68 native provider responses for the model picker', () => {
    const legacy = {
      default: { opencode: 'deepseek-v4-flash-free' },
      providers: [{
        id: 'opencode',
        name: 'OpenCode Zen',
        models: {
          'deepseek-v4-flash-free': { name: 'DeepSeek V4 Flash Free' },
        },
      }],
    } as unknown as ProviderListResponse;

    const normalized = normalizeProviderList(legacy);
    expect(normalized.connected).toEqual(['opencode']);
    expect(normalized.all?.map((p) => p.id)).toEqual(['opencode']);
    expect(providerListHasModels(legacy)).toBe(true);
    expect(filterToNativeProviders(legacy).connected).toEqual(['opencode']);
  });

  test('keeps gateway providers only when the running runtime exposes kortix', () => {
    const mixed = providers(['kortix', 'opencode', 'anthropic']);
    expect(providerListHasGateway(mixed)).toBe(true);
    expect(filterToGatewayProviders(mixed).connected).toEqual(['kortix']);
    expect(filterToGatewayProviders(mixed).all?.map((p) => p.id)).toEqual(['kortix']);

    const native = providers(['anthropic', 'openai']);
    expect(providerListHasGateway(native)).toBe(false);
    expect(native.connected).toEqual(['anthropic', 'openai']);
  });

  test('removes stale gateway provider when project is in native mode', () => {
    const mixed = providers(['kortix', 'opencode', 'anthropic']);
    const native = filterToNativeProviders(mixed);
    expect(native.connected).toEqual(['opencode', 'anthropic']);
    expect(native.all?.map((p) => p.id)).toEqual(['opencode', 'anthropic']);
  });

  test('marks native project-secret providers connected even when OpenCode connected is stale', () => {
    const merged = mergeProjectSecretConnectedProviders(
      {
        default: {},
        connected: ['opencode'],
        all: [
          { id: 'opencode', name: 'OpenCode Zen', models: { zen: { name: 'Zen' } } },
          { id: 'anthropic', name: 'Anthropic', models: { claude: { name: 'Claude' } } },
        ],
      } as unknown as ProviderListResponse,
      new Set(['ANTHROPIC_API_KEY']),
      [{ id: 'anthropic', envVars: ['ANTHROPIC_API_KEY'] }],
    );

    expect(merged.connected).toEqual(['opencode', 'anthropic']);
    expect(providerListHasModels(merged)).toBe(true);
  });

  test('maps ChatGPT subscription secrets to the codex gateway provider', () => {
    expect(
      [...connectedGatewayProviderIdsFromSecretNames(new Set(['CODEX_AUTH_JSON']))],
    ).toEqual(['codex']);
    expect(
      [...connectedGatewayProviderIdsFromSecretNames(new Set(['OPENCODE_AUTH_JSON']))],
    ).toEqual(['codex']);
  });

  test('converts the project catalog into the managed kortix provider', () => {
    const list = projectLlmCatalogToProviderList({
      models: {
        auto: { name: 'Auto' },
        'claude-opus-4.8': { name: 'Claude Opus 4.8' },
      },
    });

    expect(list.connected).toEqual(['kortix']);
    expect(list.default).toEqual({ kortix: 'auto' });
    expect(list.all?.[0]?.id).toBe('kortix');
    expect(Object.keys(list.all?.[0]?.models ?? {})).toEqual(['auto', 'claude-opus-4.8']);
    expect((list.all?.[0]?.models as any)?.['deepseek-v4-flash-free']).toBeUndefined();
  });

  test('does not invent a kortix/auto default for an empty project catalog', () => {
    const list = projectLlmCatalogToProviderList({ models: {} });

    expect(list.connected).toEqual(['kortix']);
    expect(list.default).toEqual({});
    expect(list.all?.[0]?.models).toEqual({});
  });

  test('does not merge session-native providers into gateway catalog', () => {
    const project = projectLlmCatalogToProviderList({
      models: {
        auto: { name: 'Auto' },
      },
    });
    const session = filterToGatewayProviders(providers(['opencode', 'anthropic']));
    const merged = mergeProviderLists(project, session);

    expect(merged.connected).toEqual(['kortix']);
    expect(merged.all?.map((p) => p.id)).toEqual(['kortix']);
    expect(merged.all?.find((p) => p.id === 'opencode')).toBeUndefined();
  });
});

// BYOK gateway blindness fix: the LLM-provider "Connected" UI used to treat
// any project_secrets row (shared OR someone else's private override) as
// "connected", so a lingering private-only row made every viewer see
// "Connected" even though the gateway couldn't route anyone else's sessions
// with it. These helpers replace that blind name check with the same
// per-viewer rule gateway resolution applies (getResolvedProjectSecretValue).
describe('usableSecretNamesForViewer / privateOnlySecretNamesForViewer / privateOnlyProviderIdsFromSecretNames', () => {
  const item = (overrides: Partial<SecretUsabilityItem>): SecretUsabilityItem => ({
    name: 'ANTHROPIC_API_KEY',
    configured: false,
    effective_source: 'none',
    ...overrides,
  });

  test('a configured (shared) secret is usable and not private-only', () => {
    const items = [item({ configured: true, effective_source: 'shared' })];
    expect(usableSecretNamesForViewer(items)).toEqual(new Set(['ANTHROPIC_API_KEY']));
    expect(privateOnlySecretNamesForViewer(items)).toEqual(new Set());
  });

  test("the viewer's own active private override is usable AND private-only when no shared row exists", () => {
    const items = [item({ configured: false, effective_source: 'mine' })];
    expect(usableSecretNamesForViewer(items)).toEqual(new Set(['ANTHROPIC_API_KEY']));
    expect(privateOnlySecretNamesForViewer(items)).toEqual(new Set(['ANTHROPIC_API_KEY']));
  });

  test('a shared row plus the viewer\'s own override is usable but NOT private-only (shared covers everyone)', () => {
    const items = [item({ configured: true, effective_source: 'mine' })];
    expect(usableSecretNamesForViewer(items)).toEqual(new Set(['ANTHROPIC_API_KEY']));
    expect(privateOnlySecretNamesForViewer(items)).toEqual(new Set());
  });

  test('a row that resolves to neither shared nor mine (e.g. someone else\'s private-only row) is NOT usable by this viewer', () => {
    const items = [item({ configured: false, effective_source: 'none' })];
    expect(usableSecretNamesForViewer(items)).toEqual(new Set());
    expect(privateOnlySecretNamesForViewer(items)).toEqual(new Set());
  });

  test('a connected provider whose only key is private-only is flagged for the "make shared" warning', () => {
    const usable = usableSecretNamesForViewer([item({ configured: false, effective_source: 'mine' })]);
    const privateOnly = privateOnlySecretNamesForViewer([
      item({ configured: false, effective_source: 'mine' }),
    ]);
    expect(privateOnlyProviderIdsFromSecretNames(usable, privateOnly)).toEqual(new Set(['anthropic']));
  });

  test('a connected provider backed by a shared key is NOT flagged', () => {
    const usable = usableSecretNamesForViewer([item({ configured: true, effective_source: 'shared' })]);
    const privateOnly = privateOnlySecretNamesForViewer([
      item({ configured: true, effective_source: 'shared' }),
    ]);
    expect(privateOnlyProviderIdsFromSecretNames(usable, privateOnly)).toEqual(new Set());
  });

  test('an unconnected provider (no usable key at all) is never flagged', () => {
    expect(privateOnlyProviderIdsFromSecretNames(new Set(), new Set())).toEqual(new Set());
  });
});
