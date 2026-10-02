/**
 * PinnedBar outside a sheet (BrowserPage, ProjectSessionsPage, the Files page)
 * renders the plain root it always rendered. Inside `SheetFill` it moves by
 * the provided shift, on the UI thread, with the same root props.
 */
import { beforeAll, describe, expect, mock, test } from 'bun:test';
import React from 'react';

// `react-test-renderer` ships no types in this workspace: type the part this test uses.
type TestNode = { type: unknown; props: Record<string, unknown>; children: unknown[] };
type ReactTestRenderer = { root: TestNode & { findByType: (type: never) => TestNode }; unmount: () => void };
const { act, create } = require('react-test-renderer') as {
  act: (fn: () => void) => void;
  create: (element: React.ReactElement) => ReactTestRenderer;
};

type HostProps = React.PropsWithChildren<Record<string, unknown>>;
const host = (name: string) => ({ children, ...props }: HostProps) => React.createElement(name, props, children);

mock.module('react-native', () => ({
  StyleSheet: { absoluteFill: { position: 'absolute' } },
  View: host('view'),
}));
mock.module('expo-linear-gradient', () => ({ LinearGradient: host('linear-gradient') }));
mock.module('react-native-reanimated', () => ({
  default: { View: host('animated-view') },
  useAnimatedStyle: (worklet: () => object) => worklet(),
}));
mock.module('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 20 }) }));
mock.module('@/lib/utils/theme', () => ({ withAlpha: (color: string, alpha: number) => `${color}@${alpha}` }));

let mod: typeof import('./pinned-bar');
beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mod = await import('./pinned-bar');
});

const render = (element: React.ReactElement) => {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(element);
  });
  return tree;
};
const barOf = (shift?: { get: () => number }) => {
  const bar = (
    <mod.PinnedBar controlHeight={40} background="bg" className="gap-2 px-4">
      <></>
    </mod.PinnedBar>
  );
  return shift ? (
    <mod.PinnedBarShiftContext.Provider value={shift as never}>{bar}</mod.PinnedBarShiftContext.Provider>
  ) : (
    bar
  );
};
// The rendered host root (react-test-renderer's root is the component).
const hostRoot = (tree: ReactTestRenderer) => {
  let node = tree.root as TestNode;
  while (typeof node.type !== 'string') node = node.children[0] as TestNode;
  return node;
};

describe('PinnedBar', () => {
  test('without a sheet: the plain root, unchanged, no transform', () => {
    const tree = render(barOf());
    const root = hostRoot(tree);
    expect(root.type).toBe('view');
    expect(root.props.className).toBe('absolute inset-x-0 bottom-0');
    expect(root.props.pointerEvents).toBe('box-none');
    // 20 safe area + 16 gap + 40 controls + 36 fade.
    expect(root.props.style).toEqual({ height: 112 });
    act(() => tree.unmount());
  });

  test('inside a SheetFill: the same root, moved by the shift', () => {
    const tree = render(barOf({ get: () => -120 }));
    const root = hostRoot(tree);
    expect(root.type).toBe('animated-view');
    expect(root.props.className).toBe('absolute inset-x-0 bottom-0');
    expect(root.props.pointerEvents).toBe('box-none');
    expect(root.props.style).toEqual([{ height: 112 }, { transform: [{ translateY: -120 }] }]);
    act(() => tree.unmount());
  });

  test('the fade and the controls row are the same either way', () => {
    const plain = render(barOf());
    const shifted = render(barOf({ get: () => 0 }));
    const kids = (tree: ReactTestRenderer) =>
      (hostRoot(tree).children as TestNode[]).map((c) => ({ type: c.type, props: { ...c.props, children: undefined } }));
    expect(kids(shifted)).toEqual(kids(plain));
    act(() => {
      plain.unmount();
      shifted.unmount();
    });
  });
});
