import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import React from 'react';
// @ts-ignore -- this app has no @types/react-test-renderer
import { act, create, type ReactTestInstance } from 'react-test-renderer';

// The chalk tile (KRTX-2732): every call site passes only chalk / size /
// fallbackText / style, so the tile is the component. Pins the rendered
// letter, the 1px border, the chalk colours from the name, and that the
// caller's style wins (DrawerNavRows overrides the border colour).

const host = (name: string) => ({ children, ...props }: any) => React.createElement(name, props, children);

mock.module('react-native', () => ({ Text: host('text'), View: host('view') }));
mock.module('nativewind', () => ({ useColorScheme: () => ({ colorScheme: 'light' }) }));
mock.module('@/components/ui/avatar', () => ({
  Avatar: host('avatar-root'),
  AvatarFallback: host('avatar-fallback'),
}));
mock.module('@/components/ui/icon', () => ({ Icon: host('icon') }));
mock.module('@/components/kortix/KortixLogo', () => ({ KortixLogo: host('kortix-logo') }));
mock.module('@/lib/icons', () => ({
  StackIcon: host('stack-icon'),
  ChatIcon: host('chat-icon'),
  LightningIcon: host('lightning-icon'),
}));
mock.module('@/lib/utils/icon-mapping', () => ({ getIconFromName: () => null }));

let Avatar: typeof import('./avatar').Avatar;
beforeAll(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  ({ Avatar } = await import('./avatar'));
});

let tree: any;
afterEach(() => {
  act(() => tree?.unmount());
  tree = undefined;
});

function render(element: React.ReactElement) {
  act(() => {
    tree = create(element);
  });
  return tree.root;
}

/** The tile's flattened style (the caller's style is last and wins). */
const tileStyle = (root: ReactTestInstance) => {
  const tile = root.findByType('avatar-root' as never);
  return Array.isArray(tile.props.style) ? Object.assign({}, ...tile.props.style) : tile.props.style;
};

const tileText = (root: ReactTestInstance): string => {
  const letter = root.findAll((n) => n.type === 'text');
  expect(letter.length).toBe(1);
  return String(letter[0]!.props.children);
};

test('the chalk tile: the fallback letter renders uppercased and size maps to width, height and radius', () => {
  const root = render(<Avatar chalk size={40} fallbackText="kortix" />);
  expect(tileText(root)).toBe('K');
  const style = tileStyle(root);
  expect(style.width).toBe(40);
  expect(style.height).toBe(40);
  expect(style.borderRadius).toBe(13); // 32% of 40, rounded
});

test('the chalk colours come from the name (entityChalk), with a 1px border', async () => {
  const { entityChalk } = await import('@/lib/ui/entity-chalk');
  const chalk = entityChalk('kortix');
  const root = render(<Avatar chalk size={40} fallbackText="kortix" />);
  const style = tileStyle(root);
  expect(style.backgroundColor).toBe(chalk.background);
  expect(style.borderColor).toBe(chalk.border);
  expect(style.borderWidth).toBe(1);
  // The letter takes the chalk foreground.
  const letter = root.findAll((n: any) => n.type === 'text')[0]!;
  expect(letter.props.style.color).toBe(chalk.foreground);
});

test("a blank name still renders the '?' fallback letter", () => {
  const root = render(<Avatar chalk size={40} fallbackText="   " />);
  expect(tileText(root)).toBe('?');
});

test("the caller's style wins: a style borderColor overrides the chalk border (DrawerNavRows)", async () => {
  const { entityChalk } = await import('@/lib/ui/entity-chalk');
  const chalk = entityChalk('kortix');
  const root = render(
    <Avatar chalk size={28} fallbackText="kortix" style={{ borderColor: '#ff005a' }} /> // hex-allowlist: test literal
  );
  const style = tileStyle(root);
  expect(style.borderColor).toBe('#ff005a'); // hex-allowlist: test literal
  expect(style.borderColor).not.toBe(chalk.border);
});
