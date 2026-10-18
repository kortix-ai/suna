/**
 * Characterization for `ModelPickerSheet` — the sheet behind the composer's
 * model pill: it OPENS on the Model tab with the thinking slider and the
 * AutoContinue row, the Agent tab lists the selectable agents and carries the
 * `+` that starts a new session, and `open()` resets to Model. The flatten to
 * one `PickerSheet` tree must keep all of it.
 */

import { beforeAll, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type HostProps = React.PropsWithChildren<Record<string, unknown>>;
const host =
  (name: string) =>
  ({ children, ...props }: HostProps) =>
    React.createElement(name, props, children);

const hapticCalls: string[] = [];

mock.module('react-native', () => ({
  View: host('view'),
  StyleSheet: { create: (s: unknown) => s },
  Pressable: host('pressable'),
}));
// The ThinkingControl slider's animation stack: no-op stubs.
const gestureStub = () => {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  for (const m of ['activeOffsetX', 'failOffsetY', 'onStart', 'onUpdate', 'onEnd']) chain[m] = self;
  return chain;
};
mock.module('react-native-gesture-handler', () => ({
  Gesture: {
    Pan: gestureStub,
    Tap: gestureStub,
    Exclusive: (a: unknown) => a,
  },
  GestureDetector: host('gesture-detector'),
}));
mock.module('react-native-reanimated', () => ({
  default: { View: host('animated-view') },
  useAnimatedStyle: () => ({}),
  useReducedMotion: () => false,
  useSharedValue: (v: unknown) => ({ value: v }),
  withSpring: (v: unknown) => v,
  withTiming: (v: unknown) => v,
  runOnJS: (f: unknown) => f,
  Easing: { bezier: () => [] },
}));
mock.module('nativewind', () => ({ useColorScheme: () => ({ colorScheme: 'light' }) }));
mock.module('@/lib/haptics', () => ({
  haptics: {
    tap: () => hapticCalls.push('tap'),
    selection: () => hapticCalls.push('selection'),
    success: () => hapticCalls.push('success'),
  },
}));
mock.module('@/components/ui/text', () => ({ Text: host('text') }));
mock.module('@/components/ui/button', () => ({ Button: host('button') }));
mock.module('@/components/ui/icon', () => ({ Icon: host('icon') }));
mock.module('@/lib/icons', () => ({
  CubeIcon: () => null,
  InfinityIcon: () => null,
  PlusIcon: () => null,
  RobotIcon: () => null,
}));
mock.module('@/components/kortix/settings-list', () => ({
  SettingsGroup: host('settings-group'),
  SettingsRow: host('settings-row'),
}));
// The picker itself is the seam under test: a host that exposes its props.
mock.module('@/components/session/PickerSheet', () => ({ PickerSheet: (p: HostProps) => {
  const ch = p.children;
  console.log('FAKE-SHEET children', Array.isArray(ch) ? ch.map((c: unknown) => typeof c === 'function' ? 'fn' : c === null ? 'null' : typeof c) : typeof ch, 'title', p.title);
  return host('picker-sheet')(p);
} }));

type ModelPicker = typeof import('./ModelPickerSheet');
let mod: ModelPicker;
beforeAll(async () => {
  mod = await import('./ModelPickerSheet');
});

const AGENTS = [
  { name: 'agent-a', label: 'Agent A' },
  { name: 'agent-b', label: 'Agent B' },
] as never;

const baseProps = {
  options: [{ key: 'gpt', label: 'GPT' }],
  activeKey: 'gpt',
  onSelect: () => {},
  thinking: { levels: ['low', 'high'], selected: null, onSelect: () => {} },
  agent: { agents: AGENTS, activeName: 'agent-a', onSelect: () => {}, onCreate: () => {} },
  autoContinue: { value: 'Off', onPress: () => {} },
};

const render = async (props: Record<string, unknown>): Promise<ReactTestRenderer & { ref: { current: { open: () => void } | null } }> => {
  const ref = React.createRef<{ open: () => void; close: () => void }>();
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the fakes are untyped hosts
    renderer = create(React.createElement(mod.ModelPickerSheet as any, { ...props, ref }));
  });
  return Object.assign(renderer as ReactTestRenderer, { ref });
};

const pickerProps = (r: ReactTestRenderer) => {
  const node = r.root.find((n: any) => n.type === 'picker-sheet');
  return node.props as Record<string, unknown> & { children?: unknown[] };
};

const texts = (nodes: unknown[]): string[] => {
  const out: string[] = [];
  const walk = (node: { props?: { children?: unknown } }) => {
    for (const child of Array.isArray(node.props?.children) ? node.props!.children : [node.props?.children]) {
      if (child == null || child === false) continue;
      if (typeof child === 'string') out.push(child);
      else if (typeof child === 'object') walk(child as { props?: { children?: unknown } });
    }
  };
  for (const node of nodes) {
    if (node && typeof node === 'object' && 'props' in (node as object)) walk(node as { props?: { children?: unknown } });
  }
  return out;
};

describe('ModelPickerSheet', () => {
  test('opens on the Model tab: thinking levels and the AutoContinue row render', async () => {
    const r = await render(baseProps);
    r.ref.current?.open();
    await act(async () => {});
    const props = pickerProps(r);
    expect(props.title).toBe('Model');
    expect(props.activeKey).toBe('gpt');
    expect((props.tabs as { activeIndex: number }).activeIndex).toBe(1);
    // "Thinking" is the slider's accessibilityLabel, not rendered text.
    const labels = r.root
      .findAll((node) => typeof node.props?.accessibilityLabel === 'string')
      .map((node) => node.props.accessibilityLabel as string);
    expect(labels).toContain('Thinking');
    const strings = r.root
      .findAll((node) => typeof node.props?.label === 'string' || typeof node.props?.children === 'string')
      .flatMap((node) => [node.props.label, node.props.children].filter((v): v is string => typeof v === 'string'));
    expect(strings).toContain('AutoContinue');
  });

  test('the Agent tab lists the selectable agents and its + starts a new session', async () => {
    const onCreate = mock(() => {});
    const r = await render({ ...baseProps, agent: { ...baseProps.agent, onCreate } });
    r.ref.current?.open();
    await act(async () => (pickerProps(r).tabs as { onSelect: (i: number) => void }).onSelect(0));
    const props = pickerProps(r);
    expect(props.title).toBe('Agent');
    expect(props.options).toEqual([
      { key: 'agent-a', label: 'Agent-a' },
      { key: 'agent-b', label: 'Agent-b' },
    ]);
    expect(props.activeKey).toBe('agent-a');
    const trailing = props.titleTrailing as { props?: { children?: unknown } };
    expect(trailing).toBeTruthy();
    const press = (function find(node: { props?: { onPress?: () => void; children?: unknown } }): (() => void) | null {
      if (typeof node.props?.onPress === 'function') return node.props.onPress;
      for (const child of Array.isArray(node.props?.children) ? node.props!.children : []) {
        if (child && typeof child === 'object') {
          const found = find(child as { props?: { onPress?: () => void; children?: unknown } });
          if (found) return found;
        }
      }
      return null;
    })(trailing);
    await act(async () => press?.());
    expect(onCreate).toHaveBeenCalled();
  });

  test('open() resets to the Model tab after the Agent tab was shown', async () => {
    const r = await render(baseProps);
    r.ref.current?.open();
    await act(async () => (pickerProps(r).tabs as { onSelect: (i: number) => void }).onSelect(0));
    expect(pickerProps(r).title).toBe('Agent');
    r.ref.current?.open();
    await act(async () => {});
    expect(pickerProps(r).title).toBe('Model');
  });
});
