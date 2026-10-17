/**
 * Copy under an assistant turn writes what a reader can paste: a generative UI
 * block becomes its markdown (through the real SDK converter), and a reply
 * without one is copied unchanged. Run with `bun test --isolate`.
 */
import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

type HostProps = React.PropsWithChildren<Record<string, unknown>>;
const host = (name: string) => ({ children, ...props }: HostProps) => React.createElement(name, props, children);
const none = () => null;

const copied: string[] = [];

mock.module('react-native', () => ({ View: host('view') }));
mock.module('react-native-reanimated', () => ({
  default: { View: host('animated-view') },
  useSharedValue: <T,>(value: T) => React.useRef({ value }).current,
  useAnimatedStyle: (style: () => unknown) => style(),
  withSpring: (to: unknown) => to,
}));
mock.module('expo-clipboard', () => ({ setStringAsync: async (text: string) => void copied.push(text) }));
mock.module('nativewind', () => ({ useColorScheme: () => ({ colorScheme: 'light' }) }));
mock.module('@/components/ui/button', () => ({ Button: host('button') }));
mock.module('@/components/ui/icon', () => ({ Icon: none }));
mock.module('@/lib/icons', () => ({ CheckIcon: none, CopyIcon: none }));
mock.module('@/lib/session/turn-meta', () => ({ turnDurationMs: () => null, turnEndedAt: () => null }));
mock.module('@/lib/utils/theme', () => ({ THEME: { light: { mutedForeground: 'gray' }, dark: { mutedForeground: 'gray' } } }));
mock.module('./session-turn-meta', () => ({
  SessionTurnMeta: none,
  TURN_ACTION_HIT_SLOP: {},
  TURN_ACTION_ICON_SIZE: 17,
}));

let TurnActions: typeof import('./turn-actions').TurnActions;
beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  ({ TurnActions } = await import('./turn-actions'));
});

let tree: ReactTestRenderer | undefined;
afterEach(() => {
  act(() => tree?.unmount());
  tree = undefined;
  copied.length = 0;
});

async function copy(response: string): Promise<string | undefined> {
  act(() => {
    tree = create(<TurnActions response={response} turn={{} as never} />);
  });
  const button = tree!.root.findByProps({ testID: 'session-turn-copy' });
  await act(async () => {
    await (button.props.onPress as () => Promise<void>)();
  });
  return copied[0];
}

describe('TurnActions copy', () => {
  test('a reply with a generative UI block copies as markdown, not OpenUI source', async () => {
    const reply = 'Done.\n\n```openui\nroot = Stack([b])\nb = Badge("shipped")\n```';
    const text = await copy(reply);
    expect(text).toBe('Done.\n\n[shipped]');
  });

  test('a reply without a block copies as the identical string', async () => {
    const reply = 'Plain **markdown** reply.\n\n```ts\nconst a = 1;\n```';
    expect(await copy(reply)).toBe(reply);
  });
});
