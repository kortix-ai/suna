import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { AcpSessionConfigOption } from '@kortix/sdk';

// DOM-free harness (no jsdom in this workspace — same pattern as
// `use-model-connection-gate.test.tsx`). `safeSetItem` is stubbed so the store
// never touches a real storage backend; the in-memory `_store` is what these
// assertions exercise.
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

mock.module('@/lib/storage/managed-storage', () => ({
  safeSetItem: () => {},
}));

const { useAcpDefaultMode, setExplicitAgentMode, getExplicitAgentMode } = await import(
  './use-acp-default-mode'
);

const claudeMode = (currentValue: string): AcpSessionConfigOption => ({
  id: 'mode',
  name: 'Mode',
  type: 'select',
  category: 'mode',
  currentValue,
  options: [
    { name: 'Manual', value: 'default' },
    { name: 'Accept Edits', value: 'acceptEdits' },
    { name: 'Plan Mode', value: 'plan' },
    { name: "Don't Ask", value: 'dontAsk' },
    { name: 'Bypass Permissions', value: 'bypassPermissions' },
  ],
});

const codexMode = (currentValue: string): AcpSessionConfigOption => ({
  id: 'mode',
  name: 'Mode',
  type: 'select',
  category: 'mode',
  currentValue,
  options: [
    { name: 'Read-only', value: 'read-only' },
    { name: 'Agent', value: 'agent' },
    { name: 'Agent (full access)', value: 'agent-full-access' },
  ],
});

type Captured = { result: ReturnType<typeof useAcpDefaultMode> | null };

function Harness({
  input,
  captured,
}: {
  input: Parameters<typeof useAcpDefaultMode>[0];
  captured: Captured;
}) {
  captured.result = useAcpDefaultMode(input);
  return null;
}

function render(input: Parameters<typeof useAcpDefaultMode>[0]) {
  const captured: Captured = { result: null };
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<Harness input={input} captured={captured} />);
  });
  return { captured, renderer };
}

afterEach(() => {
  // Reset any persisted opt-ins between tests.
  setExplicitAgentMode('agent-x', undefined);
  setExplicitAgentMode('agent-codex', undefined);
});

describe('useAcpDefaultMode — bypass-all default', () => {
  test('fresh claude session defaults to bypassPermissions exactly once', () => {
    const calls: Array<[string, unknown]> = [];
    const setConfigOption = (id: string, value: unknown) => {
      calls.push([id, value]);
      return Promise.resolve();
    };
    render({
      agentKey: 'agent-x',
      sessionId: 'sess-1',
      ready: true,
      configOptions: [claudeMode('default')],
      setConfigOption,
    });
    expect(calls).toEqual([['mode', 'bypassPermissions']]);
  });

  test('fresh codex session defaults to agent-full-access', () => {
    const calls: Array<[string, unknown]> = [];
    render({
      agentKey: 'agent-codex',
      sessionId: 'sess-codex',
      ready: true,
      configOptions: [codexMode('agent')],
      setConfigOption: (id, value) => {
        calls.push([id, value]);
        return Promise.resolve();
      },
    });
    expect(calls).toEqual([['mode', 'agent-full-access']]);
  });

  test('does nothing until ready', () => {
    const calls: Array<[string, unknown]> = [];
    render({
      agentKey: 'agent-x',
      sessionId: 'sess-2',
      ready: false,
      configOptions: [claudeMode('default')],
      setConfigOption: (id, value) => {
        calls.push([id, value]);
        return Promise.resolve();
      },
    });
    expect(calls).toEqual([]);
  });

  test('explicit persisted choice wins over the bypass default', () => {
    setExplicitAgentMode('agent-x', 'plan');
    expect(getExplicitAgentMode('agent-x')).toBe('plan');
    const calls: Array<[string, unknown]> = [];
    render({
      agentKey: 'agent-x',
      sessionId: 'sess-3',
      ready: true,
      configOptions: [claudeMode('default')],
      setConfigOption: (id, value) => {
        calls.push([id, value]);
        return Promise.resolve();
      },
    });
    expect(calls).toEqual([['mode', 'plan']]);
  });

  test('persistExplicitMode records the user opt-in', () => {
    const { captured } = render({
      agentKey: 'agent-x',
      sessionId: 'sess-4',
      ready: true,
      configOptions: [claudeMode('bypassPermissions')],
      setConfigOption: () => Promise.resolve(),
    });
    act(() => {
      captured.result?.persistExplicitMode('acceptEdits');
    });
    expect(getExplicitAgentMode('agent-x')).toBe('acceptEdits');
  });

  test('applyMostPermissiveMode switches to bypass (backs "Allow everything")', async () => {
    const calls: Array<[string, unknown]> = [];
    const { captured } = render({
      agentKey: 'agent-x',
      sessionId: 'sess-5',
      ready: true,
      // current is a stricter mode, so the default applier does NOT fire...
      configOptions: [claudeMode('plan')],
      setConfigOption: (id, value) => {
        calls.push([id, value]);
        return Promise.resolve();
      },
    });
    expect(calls).toEqual([]); // deliberate non-default mode is left alone
    let ok = false;
    await act(async () => {
      ok = (await captured.result?.applyMostPermissiveMode()) ?? false;
    });
    expect(ok).toBe(true);
    expect(calls).toEqual([['mode', 'bypassPermissions']]);
  });
});
