import { describe, expect, mock, test } from 'bun:test';
import { act, create } from 'react-test-renderer';

import type { ModelPickerViewModel } from '@kortix/sdk/react';

// Same DOM-free harness `acp-session-chat.test.tsx` uses for composer wiring:
// no jsdom in this workspace, so `react-test-renderer` + manual `act()`. Unlike
// that file, this one does NOT need the Radix/motion/next-intl global stubs —
// every hook `ComposerChatInput` calls directly is mocked below (down to
// `useModelPicker`/`useUnifiedModelPickerEnabled`, the two this task adds), so
// `SessionChatInput` (and everything IT would otherwise pull in — next-intl,
// Radix popovers, react-query) never actually mounts. It is stubbed to a
// props-capturing `null`, exactly like `acp-session-chat.test.tsx` stubs
// `ComposerChatInput` for the same reason: this file tests composer WIRING —
// which prop `SessionChatInput` receives — not `SessionChatInput`'s own
// rendering (that's `session-chat-input`'s and `model-picker.test.tsx`'s job).

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let flagEnabled = false;
let currentAgent: { name: string; harness: string } = { name: 'kortix', harness: 'opencode' };

mock.module('@/hooks/projects/use-unified-model-picker-enabled', () => ({
  useUnifiedModelPickerEnabled: () => flagEnabled,
}));

mock.module('@/hooks/runtime/use-runtime-config', () => ({
  useRuntimeConfig: () => ({ data: undefined }),
}));

const setRuntimeModelMock = mock((_agentName: string, _model: string | undefined) => {});
mock.module('@/hooks/runtime/use-model-store', () => ({
  useModelStore: () => ({
    getRuntimeModel: () => undefined,
    setRuntimeModel: setRuntimeModelMock,
  }),
}));

mock.module('@/hooks/runtime/use-runtime-sessions', () => ({
  useRuntimeAgents: () => ({ data: [currentAgent] }),
  useRuntimeProviders: () => ({ data: undefined, isLoading: false }),
  useRuntimeSessions: () => ({ data: undefined }),
}));

const openConnectProviderMock = mock((_tab?: string, _opts?: unknown) => {});
mock.module('@/features/session/use-model-connection-gate', () => ({
  useModelConnectionGate: () => ({
    openConnectProvider: openConnectProviderMock,
    openUpgrade: mock(() => {}),
    modal: null,
    hasSelectableModels: true,
    entitlementsPending: false,
  }),
}));

const setLocalModelMock = mock((_model: unknown, _opts?: unknown) => {});
mock.module('@/hooks/runtime/use-runtime-local', () => ({
  useRuntimeLocal: () => ({
    agent: {
      current: currentAgent,
      list: [currentAgent],
      set: mock(() => {}),
      move: mock(() => {}),
    },
    model: {
      current: undefined,
      currentKey: undefined,
      sendKey: undefined,
      onDefault: true,
      recent: [],
      set: setLocalModelMock,
      visible: () => true,
      setVisibility: mock(() => {}),
      variant: { current: undefined, list: [], set: mock(() => {}), cycle: mock(() => {}) },
    },
  }),
}));

function buildModelPickerVm(over: Partial<ModelPickerViewModel> = {}): ModelPickerViewModel {
  return {
    status: 'ready',
    selectedKey: 'auto',
    searchable: false,
    trigger: { label: 'Default', sublabel: null, interactive: true },
    customEntry: { allowed: true, placeholder: 'provider/model', validate: () => ({ ok: true }) },
    groups: [
      {
        id: 'default',
        label: 'Default',
        connectAction: null,
        items: [
          {
            key: 'auto',
            kind: 'auto',
            label: 'Default',
            sublabel: null,
            providerId: null,
            experimental: false,
            liveSwap: false,
            selectable: true,
          },
        ],
      },
    ],
    select: mock(() => {}),
    ...over,
  };
}

let modelPickerVmFixture = buildModelPickerVm();
const useModelPickerMock = mock((_input: unknown) => modelPickerVmFixture);

const actualSdkReact = await import('@kortix/sdk/react');
mock.module('@kortix/sdk/react', () => ({
  ...actualSdkReact,
  useProjectConfig: () => undefined,
  useComposerCapabilities: () => ({ data: undefined, isLoading: false, error: null }),
  useModelPicker: useModelPickerMock,
}));

let capturedSessionChatInputProps: Record<string, unknown> | null = null;
mock.module('@/features/session/session-chat-input', () => ({
  SessionChatInput: (props: Record<string, unknown>) => {
    capturedSessionChatInputProps = props;
    return null;
  },
}));

const { ComposerChatInput } = await import('./composer-chat-input');

function renderComposer(projectId = 'proj_1') {
  let renderer: ReturnType<typeof create>;
  act(() => {
    renderer = create(<ComposerChatInput onSend={() => {}} projectId={projectId} />);
  });
  return renderer!;
}

const CLAUDE_AGENT = { name: 'claude', harness: 'claude' };
const OPENCODE_AGENT = { name: 'kortix', harness: 'opencode' };

describe('ComposerChatInput — unified_model_picker flag wiring', () => {
  test.each([
    ['claude', CLAUDE_AGENT],
    ['opencode', OPENCODE_AGENT],
  ] as const)(
    'flag OFF — %s agent gets the untouched legacy fork, no modelPicker prop',
    (_label, agent) => {
      flagEnabled = false;
      currentAgent = agent;
      capturedSessionChatInputProps = null;

      renderComposer();

      expect(capturedSessionChatInputProps).not.toBeNull();
      expect(capturedSessionChatInputProps!.modelPicker).toBeUndefined();
    },
  );

  test.each([
    ['claude', CLAUDE_AGENT],
    ['opencode', OPENCODE_AGENT],
  ] as const)(
    'flag ON — %s agent routes through exactly one modelPicker prop (same shape regardless of harness)',
    (_label, agent) => {
      flagEnabled = true;
      currentAgent = agent;
      capturedSessionChatInputProps = null;
      modelPickerVmFixture = buildModelPickerVm({
        trigger: { label: `${agent.harness} default`, sublabel: null, interactive: true },
      });
      useModelPickerMock.mockClear();

      renderComposer();

      const modelPicker = capturedSessionChatInputProps!.modelPicker as
        { vm: ModelPickerViewModel; onConnect: (id: string) => void } | undefined;
      expect(modelPicker).toBeDefined();
      expect(modelPicker!.vm.trigger.label).toBe(`${agent.harness} default`);
      expect(typeof modelPicker!.onConnect).toBe('function');

      // Routed through `useModelPicker` with the resolved agent name, and
      // disabled (nulled `projectId`/`agentName`) only while the flag is off —
      // never the reverse.
      expect(useModelPickerMock).toHaveBeenCalledTimes(1);
      const input = useModelPickerMock.mock.calls[0]![0] as {
        projectId: string | null;
        agentName: string | null;
      };
      expect(input.agentName).toBe(agent.name);
      expect(input.projectId).toBe('proj_1');
    },
  );

  test('flag ON — the wrapped vm.select() persists a catalog pick through the SAME seam the legacy ModelSelector uses', () => {
    flagEnabled = true;
    currentAgent = OPENCODE_AGENT;
    capturedSessionChatInputProps = null;
    const innerSelect = mock(() => {});
    modelPickerVmFixture = buildModelPickerVm({
      select: innerSelect,
      groups: [
        {
          id: 'anthropic',
          label: 'Anthropic',
          connectAction: null,
          items: [
            {
              key: 'anthropic:claude-sonnet-4-6',
              kind: 'model',
              label: 'Claude Sonnet 4.6',
              sublabel: null,
              providerId: 'anthropic',
              experimental: false,
              liveSwap: false,
              selectable: true,
            },
          ],
        },
      ],
    });
    setLocalModelMock.mockClear();
    setRuntimeModelMock.mockClear();

    renderComposer();
    const modelPicker = capturedSessionChatInputProps!.modelPicker as {
      vm: ModelPickerViewModel;
    };

    act(() => {
      modelPicker.vm.select('anthropic:claude-sonnet-4-6');
    });

    // The hook's own reactive select still runs (immediate trigger/checkmark
    // feedback)...
    expect(innerSelect).toHaveBeenCalledWith('anthropic:claude-sonnet-4-6');
    // ...AND the pre-session persistence seam `buildComposerOptions` actually
    // reads from at send-time gets the pick too.
    expect(setLocalModelMock).toHaveBeenCalledWith(
      { providerID: 'anthropic', modelID: 'claude-sonnet-4-6' },
      { recent: true },
    );
    expect(setRuntimeModelMock).not.toHaveBeenCalled();
  });

  test('flag ON — the wrapped vm.select() persists a harness pick through useModelStore, not local.model', () => {
    flagEnabled = true;
    currentAgent = CLAUDE_AGENT;
    capturedSessionChatInputProps = null;
    const innerSelect = mock(() => {});
    modelPickerVmFixture = buildModelPickerVm({
      select: innerSelect,
      groups: [
        {
          id: 'claude',
          label: 'Claude',
          connectAction: null,
          items: [
            {
              key: 'claude:claude-sonnet-4-6',
              kind: 'model',
              label: 'Sonnet 4.6',
              sublabel: null,
              providerId: 'claude',
              experimental: false,
              liveSwap: false,
              selectable: true,
            },
          ],
        },
      ],
    });
    setLocalModelMock.mockClear();
    setRuntimeModelMock.mockClear();

    renderComposer();
    const modelPicker = capturedSessionChatInputProps!.modelPicker as {
      vm: ModelPickerViewModel;
    };

    act(() => {
      modelPicker.vm.select('claude:claude-sonnet-4-6');
    });

    expect(innerSelect).toHaveBeenCalledWith('claude:claude-sonnet-4-6');
    expect(setRuntimeModelMock).toHaveBeenCalledWith('claude', 'claude-sonnet-4-6');
    expect(setLocalModelMock).not.toHaveBeenCalled();
  });

  test('flag ON — onConnect routes through the same connect-provider gate the legacy ModelSelector uses', () => {
    flagEnabled = true;
    currentAgent = OPENCODE_AGENT;
    capturedSessionChatInputProps = null;
    modelPickerVmFixture = buildModelPickerVm();
    openConnectProviderMock.mockClear();

    renderComposer();
    const modelPicker = capturedSessionChatInputProps!.modelPicker as {
      onConnect: (id: string) => void;
    };

    act(() => {
      modelPicker.onConnect('codex_subscription');
    });

    expect(openConnectProviderMock).toHaveBeenCalledWith(undefined, {
      connectKind: 'codex_subscription',
    });
  });
});
