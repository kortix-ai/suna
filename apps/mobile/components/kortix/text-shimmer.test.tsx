/**
 * TextShimmer: iOS keeps the masked gradient sweep; Android pulses the opacity
 * of ONE text, because `RNCMaskedView` redraws an offscreen layer every frame
 * the band moves, and a burst of running tools draws several shimmers at once.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

type HostProps = React.PropsWithChildren<Record<string, unknown>>;
const host = (name: string) => ({ children, ...props }: HostProps) => React.createElement(name, props, children);

const platform = { OS: 'android' };
const repeats: unknown[][] = [];
let reduceMotion = false;

mock.module('react-native', () => ({
  Platform: platform,
  StyleSheet: { create: (styles: unknown) => styles, absoluteFill: {} },
  View: host('view'),
}));
mock.module('@/components/kortix/kortix-loader', () => ({ KortixLoader: host('lottie') }));
mock.module('@react-native-masked-view/masked-view', () => ({ default: host('masked-view') }));
mock.module('expo-linear-gradient', () => ({ LinearGradient: host('linear-gradient') }));
mock.module('nativewind', () => ({ useColorScheme: () => ({ colorScheme: 'light' }) }));
mock.module('@/components/ui/text', () => ({ Text: host('text') }));
mock.module('@/lib/utils/theme', () => ({
  THEME: {
    light: { foreground: 'black', mutedForeground: 'gray' },
    dark: { foreground: 'white', mutedForeground: 'silver' },
  },
  withAlpha: (color: string, alpha: number) => `${color}@${alpha}`,
}));
mock.module('@/lib/session/activity', () => ({
  SHIMMER: { sweepMs: 2000, holdMs: 500, spreadPerChar: 2 },
  shimmerBandCenter: () => 0,
  shimmerSpread: (text: string, perChar: number) => text.length * perChar,
}));
mock.module('react-native-reanimated', () => ({
  default: { View: host('animated-view') },
  Easing: { linear: 'linear', ease: 'ease', inOut: (easing: unknown) => easing },
  cancelAnimation: () => {},
  useAnimatedStyle: () => ({}),
  useReducedMotion: () => reduceMotion,
  useSharedValue: (value: unknown) => React.useRef({ value }).current,
  withRepeat: (...args: unknown[]) => {
    repeats.push(args);
    return {};
  },
  withSequence: (...args: unknown[]) => args,
  withTiming: (...args: unknown[]) => args,
}));

let TextShimmer: typeof import('./text-shimmer').TextShimmer;
let ToolMotionContext: typeof import('./text-shimmer').ToolMotionContext;
let RunningLoader: typeof import('./text-shimmer').RunningLoader;
beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  ({ TextShimmer, ToolMotionContext, RunningLoader } = await import('./text-shimmer'));
});

let tree: ReactTestRenderer | undefined;
beforeEach(() => {
  repeats.length = 0;
  reduceMotion = false;
  platform.OS = 'android';
});
afterEach(() => {
  if (tree) act(() => tree?.unmount());
  tree = undefined;
});

const render = (label: string, props: Record<string, unknown> = {}) =>
  React.createElement(TextShimmer as unknown as React.ComponentType<Record<string, unknown>>, props, label);
const measure = () =>
  act(() => tree!.root.findAllByType('text' as never)[0].props.onLayout?.({ nativeEvent: { layout: { width: 80 } } }));
const types = () => tree!.root.findAll(() => true).map((node: { type: unknown }) => String(node.type));

describe('TextShimmer on Android', () => {
  test('draws one text with an opacity pulse and no mask or gradient', () => {
    act(() => {
      tree = create(render('Working'));
    });
    measure();
    expect(types()).not.toContain('masked-view');
    expect(types()).not.toContain('linear-gradient');
    expect(types()).toContain('animated-view');
    expect(tree!.root.findAllByType('text' as never)).toHaveLength(1);
    expect(repeats).toHaveLength(1);
    expect(repeats[0][1]).toBe(-1);
  });

  test('a label change updates the same instance and does not restart the pulse', () => {
    act(() => {
      tree = create(render('Reading'));
    });
    act(() => tree!.update(render('Writing')));
    expect(tree!.root.findAllByType('text' as never)).toHaveLength(1);
    expect(tree!.root.findByType('text' as never).props.children).toBe('Writing');
    expect(repeats).toHaveLength(1);
  });

  test('reduce motion draws the text and starts no animation', () => {
    reduceMotion = true;
    act(() => {
      tree = create(render('Working'));
    });
    expect(repeats).toHaveLength(0);
    expect(tree!.root.findAllByType('text' as never)).toHaveLength(1);
  });
});

describe('TextShimmer on iOS', () => {
  test('keeps the masked gradient sweep once the label is measured', () => {
    platform.OS = 'ios';
    act(() => {
      tree = create(render('Working'));
    });
    expect(types()).not.toContain('masked-view');
    measure();
    expect(types()).toContain('masked-view');
    expect(types()).toContain('linear-gradient');
  });
});

describe('a tool row in a finished turn (motion off)', () => {
  const still = (child: React.ReactElement) =>
    React.createElement(ToolMotionContext.Provider, { value: false }, child);

  for (const os of ['android', 'ios']) {
    test(`${os}: TextShimmer draws the same text with no animation, mask or gradient`, () => {
      platform.OS = os;
      act(() => {
        tree = create(still(render('Running command')));
      });
      measure();
      expect(repeats).toHaveLength(0);
      expect(types()).not.toContain('masked-view');
      expect(types()).not.toContain('linear-gradient');
      expect(tree!.root.findByType('text' as never).props.children).toBe('Running command');
    });
  }

  test('RunningLoader keeps its box but draws no Lottie', () => {
    act(() => {
      tree = create(still(React.createElement(RunningLoader, { size: 12 })));
    });
    expect(types()).not.toContain('lottie');
    expect(tree!.root.findByType('view' as never).props.style).toEqual({ width: 12, height: 12 });
  });

  test('RunningLoader draws the Lottie while motion is on', () => {
    act(() => {
      tree = create(React.createElement(RunningLoader, { size: 12 }));
    });
    expect(types()).toContain('lottie');
  });
});
