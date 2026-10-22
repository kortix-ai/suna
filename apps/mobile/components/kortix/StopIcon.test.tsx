import { beforeAll, expect, mock, test } from 'bun:test';
import React from 'react';
import { act, create } from 'react-test-renderer';

type HostProps = React.PropsWithChildren<Record<string, unknown>>;
const host = (name: string) => ({ children, ...props }: HostProps) =>
  React.createElement(name, props, children);

mock.module('react-native-svg', () => ({ default: host('svg'), Rect: host('rect') }));
mock.module('nativewind', () => ({ cssInterop: () => {} }));

let StopIcon: typeof import('./StopIcon').StopIcon;
beforeAll(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  ({ StopIcon } = await import('./StopIcon'));
});

for (const size of [12, 32, 0, undefined]) {
  test(`StopIcon renders size ${size ?? 'default'} on both SVG dimensions`, () => {
    const rendered: { tree?: ReturnType<typeof create> } = {};
    act(() => { rendered.tree = create(<StopIcon size={size} />); });
    const tree = rendered.tree;
    if (!tree) throw new Error('Renderer did not mount');
    try {
      const svg = tree.root.find((node) => node.type === 'svg');
      expect(svg.props.width).toBe(size ?? 24);
      expect(svg.props.height).toBe(size ?? 24);
      expect(svg.props.viewBox).toBe('0 0 24 24');
    } finally {
      act(() => tree.unmount());
    }
  });
}

test('StopIcon preserves explicit SVG dimensions and forwarded props', () => {
  const rendered: { tree?: ReturnType<typeof create> } = {};
  act(() => { rendered.tree = create(<StopIcon size={12} width={18} height={20} accessibilityLabel="Stop" />); });
  const tree = rendered.tree;
  if (!tree) throw new Error('Renderer did not mount');
  try {
    const svg = tree.root.find((node) => node.type === 'svg');
    expect(svg.props.width).toBe(18);
    expect(svg.props.height).toBe(20);
    expect(svg.props.accessibilityLabel).toBe('Stop');
  } finally {
    act(() => tree.unmount());
  }
});
