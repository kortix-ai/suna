import { describe, expect, test } from 'bun:test';
import { CATALOG } from '@kortix/llm-catalog';

import type { ConfiguredModelProvider, HarnessConnection } from '../core/rest/projects-client';
import type { Agent } from '../core/runtime/wire-types';
import { connectionDisplayName, harnessLabel, projectModelsPageState } from './use-models-page';

function agent(name: string, harness: string, hidden = false): Agent {
  return { name, harness, hidden } as Agent;
}

function connection(overrides: Partial<HarnessConnection> & Pick<HarnessConnection, 'id' | 'kind'>): HarnessConnection {
  return {
    label: overrides.kind,
    compatible_harnesses: ['claude', 'codex', 'opencode', 'pi'],
    configured: true,
    ready: true,
    active_for: [],
    reason: null,
    source: 'project_secret',
    ...overrides,
  };
}

const NO_PROVIDERS: ConfiguredModelProvider[] = [];

describe('projectModelsPageState', () => {
  test('no connections: every referenced runtime is missing, connections list is empty', () => {
    const state = projectModelsPageState({
      agents: [agent('main', 'claude'), agent('helper', 'opencode')],
      agentsLoading: false,
      connectionsData: { connections: [], providers: NO_PROVIDERS },
      connectionsLoading: false,
      connectionsError: false,
      managedModels: undefined,
      managedModelsLoading: false,
      canWrite: true,
    });

    expect(state.runtimes.map((r) => r.harness)).toEqual(['claude', 'opencode']);
    expect(state.runtimes.every((r) => r.status === 'missing')).toBe(true);
    expect(state.runtimes[0]!.modelSummary).toBe('Choose how Claude Code accesses models');
    expect(state.runtimes[0]!.blocker).toEqual({
      code: 'no_connection',
      message: 'Choose how Claude Code accesses models',
      action: 'connect',
    });
    expect(state.connections).toEqual([]);
    expect(state.canWrite).toBe(true);
    expect(state.isLoading).toBe(false);
  });

  test('runtimes render in canonical claude/codex/opencode/pi order regardless of agent order', () => {
    const state = projectModelsPageState({
      agents: [agent('a', 'pi'), agent('b', 'codex'), agent('c', 'claude')],
      agentsLoading: false,
      connectionsData: { connections: [], providers: NO_PROVIDERS },
      connectionsLoading: false,
      connectionsError: false,
      managedModels: undefined,
      managedModelsLoading: false,
      canWrite: false,
    });
    expect(state.runtimes.map((r) => r.harness)).toEqual(['claude', 'codex', 'pi']);
  });

  test('hidden agents never contribute a harness row', () => {
    const state = projectModelsPageState({
      agents: [agent('main', 'claude'), agent('disabled', 'codex', true)],
      agentsLoading: false,
      connectionsData: { connections: [], providers: NO_PROVIDERS },
      connectionsLoading: false,
      connectionsError: false,
      managedModels: undefined,
      managedModelsLoading: false,
      canWrite: false,
    });
    expect(state.runtimes.map((r) => r.harness)).toEqual(['claude']);
  });

  test('subscription-only: Claude subscription is ready for Claude Code and never shows a model count', () => {
    const claudeSub = connection({
      id: 'claude_subscription',
      kind: 'claude_subscription',
      compatible_harnesses: ['claude'],
      active_for: ['claude'],
    });
    const state = projectModelsPageState({
      agents: [agent('main', 'claude')],
      agentsLoading: false,
      connectionsData: { connections: [claudeSub], providers: NO_PROVIDERS },
      connectionsLoading: false,
      connectionsError: false,
      managedModels: undefined,
      managedModelsLoading: false,
      canWrite: true,
    });

    expect(state.runtimes).toHaveLength(1);
    expect(state.runtimes[0]).toMatchObject({
      harness: 'claude',
      status: 'ready',
      selectedConnectionId: 'claude_subscription',
      modelSummary: 'Claude subscription · Harness default',
      blocker: null,
    });
    expect(state.connections).toHaveLength(1);
    expect(state.connections[0]).toMatchObject({
      id: 'claude_subscription',
      name: 'Claude subscription',
      usedBy: ['claude'],
      catalogState: 'not-exposed',
      modelCount: null,
      status: 'ready',
    });
  });

  test('managed-only: Kortix managed auto-resolves without an explicit route and counts only managed models', () => {
    const managed = connection({
      id: 'managed_gateway',
      kind: 'managed_gateway',
      compatible_harnesses: ['claude', 'codex', 'opencode', 'pi'],
    });
    const state = projectModelsPageState({
      agents: [agent('main', 'opencode')],
      agentsLoading: false,
      connectionsData: { connections: [managed], providers: NO_PROVIDERS },
      connectionsLoading: false,
      connectionsError: false,
      managedModels: {
        'claude-opus-4.8': { name: 'Opus' },
        'glm-5.2': { name: 'GLM' },
        'not-a-managed-id': { name: 'Excluded' },
      },
      managedModelsLoading: false,
      canWrite: true,
    });

    expect(state.runtimes[0]).toMatchObject({
      harness: 'opencode',
      status: 'ready',
      selectedConnectionId: 'managed_gateway',
      modelSummary: 'Kortix managed · Automatic',
    });
    expect(state.connections[0]).toMatchObject({
      id: 'managed_gateway',
      name: 'Kortix managed',
      catalogState: 'available',
      modelCount: 2,
      usedBy: ['opencode'],
    });
  });

  test('mixed: explicit + auto-resolved + missing + ambiguous coexist correctly', () => {
    const managed = connection({
      id: 'managed_gateway',
      kind: 'managed_gateway',
      compatible_harnesses: ['claude', 'codex', 'opencode', 'pi'],
      ready: false,
      configured: false,
    });
    const claudeSub = connection({
      id: 'claude_subscription',
      kind: 'claude_subscription',
      compatible_harnesses: ['claude'],
      active_for: ['claude'],
    });
    const anthropicKey = connection({
      id: 'anthropic_api_key',
      kind: 'anthropic_api_key',
      compatible_harnesses: ['claude', 'opencode', 'pi'],
    });
    const openaiCompatible = connection({
      id: 'openai_compatible',
      kind: 'openai_compatible',
      compatible_harnesses: ['codex', 'opencode', 'pi'],
    });
    const connections = [managed, claudeSub, anthropicKey, openaiCompatible];

    const state = projectModelsPageState({
      agents: [agent('a', 'claude'), agent('b', 'codex'), agent('c', 'opencode'), agent('d', 'pi')],
      agentsLoading: false,
      connectionsData: { connections, providers: NO_PROVIDERS },
      connectionsLoading: false,
      connectionsError: false,
      managedModels: undefined,
      managedModelsLoading: false,
      canWrite: true,
    });

    const byHarness = Object.fromEntries(state.runtimes.map((r) => [r.harness, r]));

    // claude: explicit route to the subscription wins outright.
    expect(byHarness.claude).toMatchObject({ status: 'ready', selectedConnectionId: 'claude_subscription' });
    // codex: only one ready compatible connection (the custom endpoint) — auto-adopted.
    expect(byHarness.codex).toMatchObject({ status: 'ready', selectedConnectionId: 'openai_compatible' });
    // opencode: two ready compatible connections and no explicit pick — ambiguous.
    expect(byHarness.opencode).toMatchObject({ status: 'ambiguous', selectedConnectionId: null });
    expect(byHarness.opencode.blocker).toEqual({
      code: 'ambiguous',
      message: 'Select one of 2 connected options',
      action: 'choose',
    });
    // pi: same ambiguity as opencode (anthropic key + custom endpoint both ready).
    expect(byHarness.pi).toMatchObject({ status: 'ambiguous' });

    const anthropicRow = state.connections.find((c) => c.id === 'anthropic_api_key')!;
    const expectedAnthropicCount = CATALOG.providers.find((p) => p.id === 'anthropic')?.models.length ?? 0;
    expect(anthropicRow.catalogState).toBe('available');
    expect(anthropicRow.modelCount).toBe(expectedAnthropicCount);

    const customRow = state.connections.find((c) => c.id === 'openai_compatible')!;
    expect(customRow.modelCount).toBe(1);
    expect(customRow.usedBy).toEqual(['codex']);

    // The unready managed gateway is neither configured nor ready — excluded
    // from the connections list entirely.
    expect(state.connections.find((c) => c.id === 'managed_gateway')).toBeUndefined();
  });

  test('an explicit route to a connection that is no longer ready surfaces needs-attention', () => {
    const claudeSub = connection({
      id: 'claude_subscription',
      kind: 'claude_subscription',
      compatible_harnesses: ['claude'],
      active_for: ['claude'],
      ready: false,
      configured: false,
      reason: 'Token expired',
    });
    const state = projectModelsPageState({
      agents: [agent('main', 'claude')],
      agentsLoading: false,
      connectionsData: { connections: [claudeSub], providers: NO_PROVIDERS },
      connectionsLoading: false,
      connectionsError: false,
      managedModels: undefined,
      managedModelsLoading: false,
      canWrite: true,
    });

    expect(state.runtimes[0]).toMatchObject({
      status: 'needs-attention',
      selectedConnectionId: 'claude_subscription',
      modelSummary: 'Claude subscription needs to be reconnected',
    });
    // active_for on the connection itself is unaffected by readiness, so the
    // row still shows the runtime it's wired to for the disconnect preview.
    expect(state.connections[0]!.usedBy).toEqual(['claude']);
  });

  test('loading: every referenced runtime is checking, independent of connection state', () => {
    const state = projectModelsPageState({
      agents: [agent('main', 'claude')],
      agentsLoading: true,
      connectionsData: undefined,
      connectionsLoading: true,
      connectionsError: false,
      managedModels: undefined,
      managedModelsLoading: true,
      canWrite: true,
    });

    expect(state.isLoading).toBe(true);
    expect(state.runtimes[0]).toMatchObject({
      status: 'checking',
      selectedConnectionId: null,
      modelSummary: 'Checking Claude Code…',
    });
    expect(state.connections).toEqual([]);
  });

  test('connectionsError surfaces on the projected state', () => {
    const state = projectModelsPageState({
      agents: [],
      agentsLoading: false,
      connectionsData: undefined,
      connectionsLoading: false,
      connectionsError: true,
      managedModels: undefined,
      managedModelsLoading: false,
      canWrite: false,
    });
    expect(state.isError).toBe(true);
  });
});

describe('presentation helpers', () => {
  test('harnessLabel and connectionDisplayName follow the locked product language table', () => {
    expect(harnessLabel('claude')).toBe('Claude Code');
    expect(harnessLabel('codex')).toBe('Codex');
    expect(harnessLabel('opencode')).toBe('OpenCode');
    expect(harnessLabel('pi')).toBe('Pi');
    expect(connectionDisplayName('managed_gateway')).toBe('Kortix managed');
    expect(connectionDisplayName('claude_subscription')).toBe('Claude subscription');
    expect(connectionDisplayName('codex_subscription')).toBe('ChatGPT subscription');
    expect(connectionDisplayName('anthropic_api_key')).toBe('Anthropic');
    expect(connectionDisplayName('openai_api_key')).toBe('OpenAI');
  });
});
