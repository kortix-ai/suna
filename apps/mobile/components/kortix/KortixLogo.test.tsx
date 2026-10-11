/**
 * KortixLogo picks one of the six brand SVGs from `variant` × `color` and
 * sizes the wide variants (logomark 5:1, text 74:22) from the square `size`.
 */
import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

type HostProps = Record<string, unknown>;
const host = (name: string) => (props: HostProps) => React.createElement(name, props);

const svgPicks: string[] = [];
const svg = (name: string) => (props: HostProps) => {
  svgPicks.push(name);
  return React.createElement('svg', props);
};

mock.module('react-native', () => ({
  View: host('view'),
  StyleSheet: { flatten: (s: unknown) => s, create: (s: unknown) => s },
  Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android },
}));
mock.module('@/assets/brand/kortix-symbol.svg', () => ({ default: svg('symbol-black') }));
mock.module('@/assets/brand/Symbol.svg', () => ({ default: svg('symbol-white') }));
mock.module('@/assets/brand/Logomark-Black.svg', () => ({ default: svg('logomark-black') }));
mock.module('@/assets/brand/Logomark-White.svg', () => ({ default: svg('logomark-white') }));
mock.module('@/assets/brand/Logomark-Text-Black.svg', () => ({ default: svg('text-black') }));
mock.module('@/assets/brand/Logomark-Text-White.svg', () => ({ default: svg('text-white') }));
mock.module('nativewind', () => ({ useColorScheme: () => ({ colorScheme: 'dark' }) }));

let KortixLogo: typeof import('./KortixLogo').KortixLogo;
beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  ({ KortixLogo } = await import('./KortixLogo'));
});

let tree: ReactTestRenderer | undefined;
afterEach(() => {
  act(() => tree?.unmount());
  tree = undefined;
  svgPicks.length = 0;
});

const render = (props: Record<string, unknown>) => {
  act(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tree = create(React.createElement(KortixLogo as any, props));
  });
  const view = tree!.root.findByType('view' as never);
  const svgEl = tree!.root.findByType('svg' as never);
  return { view: view.props as Record<string, unknown>, svg: svgEl.props as Record<string, unknown>, picked: svgPicks[svgPicks.length - 1] };
};

describe('KortixLogo variant × color', () => {
  test.each([
    ['symbol', 'dark', 'symbol-white', 1],
    ['symbol', 'light', 'symbol-black', 1],
    ['logomark', 'dark', 'logomark-white', 5],
    ['logomark', 'light', 'logomark-black', 5],
    ['text', 'dark', 'text-white', 74 / 22],
    ['text', 'light', 'text-black', 74 / 22],
  ] as const)('variant=%s color=%s renders %s at %s:1', (variant, color, asset, ratio) => {
    const { view, svg, picked } = render({ size: 24, variant, color });
    expect(picked).toBe(asset);
    // The wide variants scale width by their aspect ratio; the symbol is square.
    expect(svg.width).toBe(24 * ratio);
    expect(svg.height).toBe(24);
    // The wrapper reserves the same box (and never shrinks in a row).
    expect(view.style).toMatchObject({ width: 24 * ratio, height: 24, flexShrink: 0 });
  });
});
