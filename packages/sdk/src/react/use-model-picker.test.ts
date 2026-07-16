import { describe, expect, it, mock } from 'bun:test';
import { createElement, type ComponentType, type ReactNode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

// react-test-renderer's `act` only suppresses its "not configured" warning
// when this flag is set — same convention as `use-acp-session.test.tsx`.
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

import type {
  ComposerCapabilities,
  ComposerModelCatalog,
  HarnessConnection,
} from '../core/rest/projects-client';

// mock.module MUST spread the real module (apps-wide footgun rule applies in
// sdk tests too) — everything except the three query hooks stays the real
// implementation (e.g. `invalidateComposerCapabilityQueries`).
import * as caps from './use-composer-capabilities';

let capabilitiesResult: { data: ComposerCapabilities | undefined; isLoading: boolean; isError: boolean };
let catalogResult: { data: ComposerModelCatalog | undefined; isLoading: boolean; isError: boolean };
let connectionsResult: {
  data: { connections: HarnessConnection[]; providers: unknown[] } | undefined;
  isLoading: boolean;
  isError: boolean;
};

mock.module('./use-composer-capabilities', () => ({
  ...caps,
  useComposerCapabilities: mock(() => capabilitiesResult),
  useComposerModelCatalog: mock(() => catalogResult),
  useHarnessConnections: mock(() => connectionsResult),
}));

const { useModelPicker } = await import('./use-model-picker');

// ── minimal renderHook harness over react-test-renderer — this package has
// no DOM/jsdom/@testing-library dependency (see `use-acp-session.test.tsx`,
// same pattern). Synchronous: every query hook above resolves immediately
// from the mocked fixtures, so no waitFor is needed.
function renderHook<TResult>(
  callback: () => TResult,
  options?: { wrapper?: ComponentType<{ children?: ReactNode }> },
) {
  const result: { current: TResult } = { current: undefined as unknown as TResult };
  function Harness() {
    result.current = callback();
    return null;
  }
  const Wrapper = options?.wrapper;
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      Wrapper ? createElement(Wrapper, null, createElement(Harness)) : createElement(Harness),
    );
  });
  return {
    result,
    unmount() {
      act(() => {
        renderer.unmount();
      });
    },
  };
}

function ready<T>(data: T): { data: T; isLoading: boolean; isError: boolean } {
  return { data, isLoading: false, isError: false };
}

describe('useModelPicker', () => {
  it('folds catalog policy into grouped selectable models with sublabels', () => {
    capabilitiesResult = ready<ComposerCapabilities>({
      agent: { name: 'opencode-agent', runtime: 'opencode', harness: 'opencode', native_agent: null, enabled: true },
      auth: { compatible: ['managed_gateway'], active: 'managed_gateway', ready: true, reason: null },
      model: { policy: 'gateway-catalog', default_allowed: false, custom_allowed: true, live_change: true, presets: [] },
      can_start: true,
      blocking_reason: null,
    });
    catalogResult = ready<ComposerModelCatalog>({
      agent: capabilitiesResult.data!.agent,
      connection_id: 'managed_gateway',
      policy: 'gateway-catalog',
      default_allowed: false,
      custom_allowed: true,
      models: [
        { id: 'anthropic/claude-sonnet-5', name: 'Claude Sonnet 5', source: 'kortix-gateway' },
        { id: 'anthropic/claude-haiku-5', name: 'Claude Haiku 5', source: 'kortix-gateway' },
        { id: 'openai/gpt-5.4', name: 'GPT-5.4', source: 'kortix-gateway' },
      ],
    });
    connectionsResult = ready({
      connections: [
        {
          id: 'managed_gateway',
          kind: 'managed_gateway',
          label: 'Kortix managed gateway',
          compatible_harnesses: ['opencode', 'pi'],
          configured: true,
          ready: true,
          active_for: ['opencode'],
          reason: null,
          source: 'kortix',
        },
      ] as HarnessConnection[],
      providers: [],
    });

    const { result, unmount } = renderHook(() =>
      useModelPicker({ projectId: 'p1', agentName: 'opencode-agent' }),
    );
    try {
      expect(result.current.status).toBe('ready');
      expect(result.current.groups.map((group) => [group.id, group.items.length])).toEqual([
        ['anthropic', 2],
        ['openai', 1],
      ]);
      expect(
        result.current.groups.every((group) =>
          group.items.every((item) => item.selectable && item.kind === 'model'),
        ),
      ).toBe(true);
      expect(result.current.trigger.label).toBe('Claude Sonnet 5');
      expect(result.current.searchable).toBe(false);
    } finally {
      unmount();
    }
  });

  it('folds harness policy into default + presets + custom entry (no catalog fork)', () => {
    capabilitiesResult = ready<ComposerCapabilities>({
      agent: { name: 'claude-agent', runtime: 'claude', harness: 'claude', native_agent: null, enabled: true },
      auth: { compatible: ['claude_subscription'], active: 'claude_subscription', ready: true, reason: null },
      model: {
        policy: 'harness-catalog',
        default_allowed: true,
        custom_allowed: true,
        live_change: false,
        presets: [
          { id: 'claude-opus-4.8', name: 'Claude Opus 4.8', source: 'models.dev' },
          { id: 'claude-sonnet-4.6', name: 'Claude Sonnet 4.6', source: 'models.dev' },
        ],
      },
      can_start: true,
      blocking_reason: null,
    });
    catalogResult = ready<ComposerModelCatalog>({
      agent: capabilitiesResult.data!.agent,
      connection_id: 'claude_subscription',
      policy: 'harness-catalog',
      default_allowed: true,
      custom_allowed: true,
      models: capabilitiesResult.data!.model.presets,
    });
    connectionsResult = ready({
      connections: [
        {
          id: 'claude_subscription',
          kind: 'claude_subscription',
          label: 'Claude subscription',
          compatible_harnesses: ['claude'],
          configured: true,
          ready: true,
          active_for: ['claude'],
          reason: null,
          source: 'project_secret',
        },
      ] as HarnessConnection[],
      providers: [],
    });

    const { result, unmount } = renderHook(() =>
      useModelPicker({ projectId: 'p1', agentName: 'claude-agent' }),
    );
    try {
      // No catalog fork: exactly one group (the harness itself), never split by provider.
      expect(result.current.groups).toHaveLength(1);
      const [group] = result.current.groups;
      expect(group.items[0]).toMatchObject({
        key: 'auto',
        kind: 'auto',
        label: 'Default',
        sublabel: 'Claude Code chooses',
        experimental: true,
      });
      expect(group.items).toHaveLength(3); // auto + 2 presets
      expect(result.current.customEntry?.allowed).toBe(true);
      expect(result.current.customEntry?.placeholder).toBe('e.g. claude-sonnet-4-6');
    } finally {
      unmount();
    }
  });

  it('lists disconnected providers as a trailing not-connected group with connectAction', () => {
    capabilitiesResult = ready<ComposerCapabilities>({
      agent: { name: 'codex-agent', runtime: 'codex', harness: 'codex', native_agent: null, enabled: true },
      auth: {
        compatible: ['codex_subscription'],
        active: null,
        ready: false,
        reason: 'Connect ChatGPT/Codex subscription before selecting it.',
      },
      model: { policy: 'harness-catalog', default_allowed: false, custom_allowed: true, live_change: false, presets: [] },
      can_start: false,
      blocking_reason: 'Connect ChatGPT/Codex subscription before selecting it.',
    });
    catalogResult = ready<ComposerModelCatalog>({
      agent: capabilitiesResult.data!.agent,
      connection_id: null,
      policy: 'harness-catalog',
      default_allowed: false,
      custom_allowed: true,
      models: [],
    });
    connectionsResult = ready({
      connections: [
        {
          id: 'codex_subscription',
          kind: 'codex_subscription',
          label: 'ChatGPT/Codex subscription',
          compatible_harnesses: ['codex'],
          configured: false,
          ready: false,
          active_for: [],
          reason: 'Connect ChatGPT/Codex subscription before selecting it.',
          source: 'project_secret',
        },
      ] as HarnessConnection[],
      providers: [],
    });

    const { result, unmount } = renderHook(() =>
      useModelPicker({ projectId: 'p1', agentName: 'codex-agent' }),
    );
    try {
      const lastGroup = result.current.groups.at(-1);
      expect(lastGroup?.id).toBe('not-connected');
      expect(lastGroup?.items.every((item) => item.selectable === false)).toBe(true);
      expect(lastGroup?.connectAction?.connectionId).toBe('codex_subscription');
    } finally {
      unmount();
    }
  });

  it('routes select() through live config option when session advertises writable model', () => {
    const setConfigOption = mock(() => Promise.resolve());

    capabilitiesResult = ready<ComposerCapabilities>({
      agent: { name: 'claude-agent', runtime: 'claude', harness: 'claude', native_agent: null, enabled: true },
      auth: { compatible: ['claude_subscription'], active: 'claude_subscription', ready: true, reason: null },
      model: {
        policy: 'harness-catalog',
        default_allowed: true,
        custom_allowed: true,
        live_change: false,
        presets: [{ id: 'anthropic/claude-sonnet-5', name: 'Claude Sonnet 5', source: 'models.dev' }],
      },
      can_start: true,
      blocking_reason: null,
    });
    catalogResult = ready<ComposerModelCatalog>({
      agent: capabilitiesResult.data!.agent,
      connection_id: 'claude_subscription',
      policy: 'harness-catalog',
      default_allowed: true,
      custom_allowed: true,
      models: capabilitiesResult.data!.model.presets,
    });
    connectionsResult = ready({ connections: [] as HarnessConnection[], providers: [] });

    const { result, unmount } = renderHook(() =>
      useModelPicker({
        projectId: 'p1',
        agentName: 'claude-agent',
        liveSession: {
          configOptions: [
            {
              id: 'model',
              name: 'Model',
              category: 'model',
              currentValue: 'claude-opus-4.8',
              options: [
                { value: 'claude-opus-4.8', label: 'Claude Opus 4.8' },
                { value: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
              ],
            },
          ],
          setConfigOption,
        },
      }),
    );
    try {
      act(() => {
        result.current.select('anthropic:claude-sonnet-5');
      });

      expect(setConfigOption).toHaveBeenCalledTimes(1);
      expect(setConfigOption).toHaveBeenCalledWith('model', 'claude-sonnet-5');
    } finally {
      unmount();
    }
  });

  it('validate() rejects garbage with a reason and accepts provider/model ids', () => {
    capabilitiesResult = ready<ComposerCapabilities>({
      agent: { name: 'claude-agent', runtime: 'claude', harness: 'claude', native_agent: null, enabled: true },
      auth: { compatible: ['claude_subscription'], active: 'claude_subscription', ready: true, reason: null },
      model: { policy: 'harness-catalog', default_allowed: true, custom_allowed: true, live_change: false, presets: [] },
      can_start: true,
      blocking_reason: null,
    });
    catalogResult = ready<ComposerModelCatalog>({
      agent: capabilitiesResult.data!.agent,
      connection_id: 'claude_subscription',
      policy: 'harness-catalog',
      default_allowed: true,
      custom_allowed: true,
      models: [],
    });
    connectionsResult = ready({ connections: [] as HarnessConnection[], providers: [] });

    const { result, unmount } = renderHook(() =>
      useModelPicker({ projectId: 'p1', agentName: 'claude-agent' }),
    );
    try {
      const vm = result.current;
      expect(vm.customEntry!.validate('').ok).toBe(false);
      expect(vm.customEntry!.validate('claude-sonnet-4-6').ok).toBe(true);
      expect(vm.customEntry!.validate('kortix/x').reason).toMatch(/gateway prefix/i);
    } finally {
      unmount();
    }
  });
});
