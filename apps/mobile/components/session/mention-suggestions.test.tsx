/**
 * Characterization for `MentionSuggestions` after the dead selection-index
 * machinery came out of the composer: the list highlights row 0 by position
 * alone (touch has no caret-driven selection; Send always picks the first
 * row) and orders rows by the canonical kind order regardless of input order.
 */
import { beforeAll, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { act, create } from "react-test-renderer";

const rows: Array<Record<string, unknown>> = [];

mock.module('react-native', () => ({
  View: ({ children }: any) => React.createElement('rn-view', null, children),
  ScrollView: ({ children }: any) => React.createElement('rn-scroll', null, children),
  StyleSheet: { hairlineWidth: 1 },
}));
mock.module('nativewind', () => ({ useColorScheme: () => ({ colorScheme: 'light' }) }));
mock.module('@/components/kortix/pressable-surface', () => ({
  PressableSurface: ({ onPress, ...props }: any) => {
    rows.push(props);
    return React.createElement('rn-press', { onPress });
  },
}));
mock.module('@/components/kortix/kortix-loader', () => ({ KortixLoader: () => null }));
mock.module('@/components/ui/text', () => ({
  Text: ({ children, ...props }: any) => React.createElement('rn-text', props, children),
}));
mock.module('@/components/ui/icon', () => ({ Icon: () => null }));
mock.module('@/components/files/FileItem', () => ({ getFileIconComponent: () => null }));
mock.module('@/lib/icons', () => ({
  ChatIcon: () => React.createElement('rn-chat'),
  FolderIcon: () => React.createElement('rn-folder'),
  RobotIcon: () => React.createElement('rn-robot'),
  SparkleIcon: () => React.createElement('rn-sparkle'),
}));
mock.module('@/lib/utils/theme', () => ({
  THEME: { light: { secondary: '#light-secondary', mutedForeground: '#light-muted' } },
  withAlpha: (color: string, alpha: number) => `${color}~${alpha}`,
}));

type Suggestions = typeof import('./MentionSuggestions').MentionSuggestions;
let MentionSuggestions: Suggestions;

beforeAll(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  ({ MentionSuggestions } = await import('./MentionSuggestions'));
});

describe('MentionSuggestions props', () => {
  test('row 0 is the highlighted one and kinds render in canonical order', () => {
    rows.length = 0;
    const items = [
      { kind: 'skill' as const, id: 's1', label: 'review' },
      { kind: 'agent' as const, id: 'a1', label: 'Planner' },
    ];
    act(() => { create(React.createElement(MentionSuggestions, { items, isLoading: false, onSelect: () => {} })); });
    expect(rows).toHaveLength(2);
    expect(rows[0].accessibilityLabel).toBe('Planner');
    expect((rows[0].style as (s: unknown) => Record<string, unknown>)({ pressed: false }).backgroundColor).toBe('#light-secondary');
    expect(rows[1].accessibilityLabel).toBe('review');
    expect((rows[1].style as (s: unknown) => Record<string, unknown>)({ pressed: false }).backgroundColor).toBe('transparent');
  });

  test('an empty list renders nothing', () => {
    let tree: { toJSON: () => unknown } | undefined;
    act(() => { tree = create(
      React.createElement(MentionSuggestions, { items: [], isLoading: false, onSelect: () => {} }),
    ); });
    expect(tree?.toJSON()).toBeNull();
  });
});
