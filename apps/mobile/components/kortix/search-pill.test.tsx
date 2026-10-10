/**
 * The search pill row of SearchListHeader: a filled, borderless `h-10`
 * `rounded-full bg-secondary px-4` pill holding a 16pt magnifier, the input,
 * and a clear affordance that only exists while there is text. An `onAdd`
 * renders the standard round "+" button.
 */
import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

type HostProps = React.PropsWithChildren<Record<string, unknown>>;
const host = (name: string) => ({ children, ...props }: HostProps) => React.createElement(name, props, children);
const none = () => null;

const icons: Array<Record<string, unknown>> = [];
const inputs: Array<Record<string, unknown>> = [];
const presses: string[] = [];

mock.module('react-native', () => ({
  View: host('view'),
  Pressable: ({ onPress, ...props }: HostProps & { onPress?: () => void }) => {
    if (onPress) presses.push('pressable');
    return React.createElement('pressable', { ...props, onPress });
  },
  TextInput: host('textinput'),
  Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android },
  StyleSheet: { flatten: (s: unknown) => s, create: (s: unknown) => s },
  useWindowDimensions: () => ({ width: 400, height: 800, fontScale: 1 }),
}));
mock.module('nativewind', () => ({ useColorScheme: () => ({ colorScheme: 'dark' }) }));
mock.module('@/lib/icons', () => ({
  PlusIcon: none,
  MagnifyingGlassIcon: none,
  XIcon: none,
}));
mock.module('@/components/ui/icon', () => ({
  Icon: ({ as, ...props }: HostProps & { as: unknown }) => {
    icons.push(props);
    return React.createElement('icon', props);
  },
}));
mock.module('@/components/ui/input', () => ({
  Input: (props: Record<string, unknown>) => {
    inputs.push(props);
    return React.createElement('input', props);
  },
}));
mock.module('@/components/ui/button', () => ({
  Button: ({ children, ...props }: HostProps) => {
    if (props.onPress) presses.push('add-button');
    return React.createElement('button', props, children);
  },
}));
mock.module('@/lib/utils/theme', () => ({
  THEME: { light: {}, dark: {} },
  withAlpha: (c: string) => c,
  MOTION: { easing: { out: [0, 0, 1, 1] }, duration: { moderate: 200 } },
}));
mock.module('@/lib/logger', () => ({ log: { error: none, warn: none, info: none } }));

let SearchListHeader: typeof import('./search-list-header').SearchListHeader;
beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  ({ SearchListHeader } = await import('./search-list-header'));
});

let tree: ReactTestRenderer | undefined;
afterEach(() => {
  act(() => tree?.unmount());
  tree = undefined;
  icons.length = 0;
  inputs.length = 0;
  presses.length = 0;
});

const render = (props: Record<string, unknown>) => {
  act(() => {
    tree = create(React.createElement(SearchListHeader, props as never));
  });
  return tree!.root.findAllByType('view' as never).map((v: { props: Record<string, unknown> }) => v.props);
};

describe('SearchListHeader search pill', () => {
  test('the input row is the standard pill: h-10, rounded-full, bg-secondary, px-4, with the magnifier at 16pt', () => {
    render({ value: '', onChangeText: none });
    const pill = render2Pill();
    expect(pill.className).toContain('h-10');
    expect(pill.className).toContain('rounded-full');
    expect(pill.className).toContain('bg-secondary');
    expect(pill.className).toContain('px-4');
    // One icon while empty: the magnifier, 16pt, muted.
    expect(icons).toHaveLength(1);
    expect(icons[0].size).toBe(16);
  });

  test('text shows the clear affordance, which resets the value; no text hides it', () => {
    render({ value: 'abc', onChangeText: (next: string) => changes.push(next) });
    // Two icons now: magnifier + clear X; the clear pressable is present.
    expect(icons).toHaveLength(2);
    expect(presses).toContain('pressable');
    const clear = tree!.root.findByType('pressable' as never);
    expect(clear.props.accessibilityLabel).toBe('Clear search');
    act(() => clear.props.onPress());
    expect(changes).toEqual(['']);
  });

  test('onAdd renders the round add button; rightAction replaces it', () => {
    render({ value: '', onChangeText: none, onAdd: () => adds.push(1) });
    expect(presses).toContain('add-button');
    const add = tree!.root.findByType('button' as never);
    expect(add.props.className).toContain('rounded-full');
    expect(add.props.accessibilityLabel).toBe('Add');

    icons.length = 0;
    presses.length = 0;
    render({ value: '', onChangeText: none, rightAction: React.createElement('custom-action') });
    expect(presses).not.toContain('add-button');
    expect(tree!.root.findByType('custom-action' as never)).toBeTruthy();
  });

  test('the default gutter is px-4 (project) and gutter="page" switches to px-5', () => {
    const rowDefault = render({ value: '', onChangeText: none })[0];
    expect(rowDefault.className).toContain('px-4');
    const rowPage = render({ value: '', onChangeText: none, gutter: 'page' })[0];
    expect(rowPage.className).toContain('px-5');
  });
});

const changes: string[] = [];
const adds: number[] = [];
/** The inner pill view: the flex-1 row that holds icon + input + clear. */
function render2Pill(): Record<string, unknown> {
  const views = tree!.root.findAllByType('view' as never) as unknown as Array<{ props: Record<string, unknown> }>;
  const pill = views.find((v) => String(v.props.className).includes('bg-secondary'));
  expect(pill).toBeTruthy();
  return pill!.props;
}
