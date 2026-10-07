/** The busy indicator's only motion is the dot matrix; its label never shimmers. */

import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

type HostProps = React.PropsWithChildren<Record<string, unknown>>;
const host = (name: string) => ({ children, ...props }: HostProps) => React.createElement(name, props, children);

mock.module('react-native', () => ({ View: host('view') }));
mock.module('react-native-reanimated', () => ({
  default: { View: host('animated-view') },
  Easing: { bezier: () => ({}) },
  FadeIn: { duration: () => ({ easing: () => ({}) }) },
  FadeOut: { duration: () => ({ easing: () => ({}) }) },
  LayoutAnimationConfig: host('layout-config'),
  withSpring: () => ({}),
}));
mock.module('@/components/kortix/text-shimmer', () => ({ TextShimmer: host('text-shimmer') }));
mock.module('@/components/ui/text', () => ({ Text: host('text') }));
mock.module('@/components/session/dot-matrix/session-dot-matrix', () => ({ SessionDotMatrix: host('dot-matrix') }));
mock.module('@/components/session/dot-matrix/use-reduce-motion', () => ({ useReduceMotion: () => false }));
mock.module('@/components/session/tool/shared/styles', () => ({
  TURN_TYPE: { sm: { lineHeight: 20 } },
  useTurnPalette: () => ({ mutedForeground: 'gray', muted70: 'gray' }),
}));
mock.module('@/lib/utils/theme', () => ({ MOTION: { duration: { moderate: 200 } } }));

let SessionBusyIndicator: typeof import('./session-busy-indicator').SessionBusyIndicator;
beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  ({ SessionBusyIndicator } = await import('./session-busy-indicator'));
});

let tree: ReactTestRenderer | undefined;
afterEach(() => {
  if (tree) act(() => tree?.unmount());
  tree = undefined;
});

describe('SessionBusyIndicator', () => {
  test('renders the dot matrix and a static label, no TextShimmer', () => {
    act(() => {
      tree = create(React.createElement(SessionBusyIndicator, { statusText: 'Reading files' }));
    });
    const types = tree!.root.findAll(() => true).map((node: { type: unknown }) => String(node.type));
    expect(types).toContain('dot-matrix');
    expect(types).not.toContain('text-shimmer');
    expect(tree!.root.findAllByType('text' as never).some((node) => node.props.children === 'Reading files')).toBe(true);
  });
});
