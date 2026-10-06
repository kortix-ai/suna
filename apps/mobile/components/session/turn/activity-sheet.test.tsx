/**
 * The activity sheet sweeps at most one entry title: with parallel running
 * calls only the last running entry may run its `TextShimmer` loop
 * (KRTX-1638). The shimmer stand-in prints the `LoopMotionContext` it renders
 * under; the entries come from a stubbed `activitySheetEntries`.
 */
import { afterEach, beforeAll, expect, mock, test } from 'bun:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

const Box = ({ children }: React.PropsWithChildren) => React.createElement('rn-box', null, children);
const LoopMotion = React.createContext(true);
const entries = [
  { kind: 'tool', key: 'a', title: 'Reading a.ts', icon: 'file', running: true, failed: false, openable: false },
  { kind: 'tool', key: 'b', title: 'Read b.ts', icon: 'file', running: false, failed: false, openable: false },
  { kind: 'tool', key: 'c', title: 'Reading c.ts', icon: 'file', running: true, failed: false, openable: false },
  { kind: 'tool', key: 'd', title: 'Reading d.ts', icon: 'file', running: true, failed: false, openable: false },
];
const sheet = { context: { sessionId: 's-1' }, view: {}, callIds: [] };
const Shimmer = ({ children }: React.PropsWithChildren) =>
  React.createElement('rn-shimmer', { title: children, loop: React.useContext(LoopMotion) });

mock.module('react-native', () => ({ BackHandler: { addEventListener: () => ({ remove() {} }) }, Pressable: Box, View: Box }));
mock.module('react-native-reanimated', () => ({ default: { View: Box } }));
mock.module('@gorhom/bottom-sheet', () => ({ BottomSheetModal: Box, BottomSheetScrollView: Box }));
mock.module('nativewind', () => ({ useColorScheme: () => ({ colorScheme: 'light' }) }));
mock.module('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
mock.module('@kortix/sdk', () => ({ isToolPart: () => true }));
mock.module('@/components/ui/icon', () => ({ Icon: Box }));
mock.module('@/components/ui/text', () => ({ Text: Box }));
mock.module('@/components/kortix/selectable-markdown', () => ({ SelectableMarkdownText: Box }));
mock.module('@/components/kortix/sheet', () => ({ KortixBottomSheetModal: Box, SheetTitleRow: Box }));
mock.module('@/components/kortix/sheet-push', () => ({ POP_IN: null, PUSH_IN: null, SheetBackButton: Box }));
mock.module('@/components/kortix/text-shimmer', () => ({ TextShimmer: Shimmer, LoopMotionContext: LoopMotion }));
mock.module('@/components/markdown/code-block', () => ({ CodeBlockFullHeightContext: React.createContext(false) }));
mock.module('@/components/markdown/inline-code', () => ({ MarkdownActionsProvider: Box }));
mock.module('@/lib/session/session-store', () => ({ usePendingPermissions: () => [] }));
mock.module('@/lib/session/activity-sheet', () => ({ activitySheetEntries: () => entries, burstHasPendingPermission: () => false }));
mock.module('@/lib/session/activity-sheet-store', () => ({
  useActivitySheetStore: Object.assign((select: (state: unknown) => unknown) => select({ sheet, close() {} }), {
    getState: () => ({ sheet }),
  }),
}));
mock.module('@/stores/tab-store', () => ({ useTabStore: { subscribe: () => () => {} } }));
mock.module('@/components/session/tool/tool-part-renderer', () => ({ ToolPartRenderer: Box }));
mock.module('@/components/session/tool/tools/register', () => ({}));
mock.module('@/components/session/tool/shared/styles', () => ({
  FONT_MEDIUM: 'medium',
  TURN_TYPE: { sheetEntry: {} },
  useTurnPalette: () => ({}),
}));
mock.module('@/components/session/tool/shared/surface', () => ({ ToolDetailContext: React.createContext(null) }));
mock.module('@/components/session/tool/shared/connector-handoff-context', () => ({ ConnectorHandoffContext: React.createContext(null) }));
mock.module('@/components/session/tool/shared/tool-icons', () => ({ ACTIVITY_ICONS: { file: () => null } }));

let ActivitySheetHost: typeof import('./activity-sheet').ActivitySheetHost;
let tree: ReactTestRenderer | undefined;
beforeAll(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  ({ ActivitySheetHost } = await import('./activity-sheet'));
});
afterEach(async () => {
  if (tree) await act(async () => tree?.unmount());
  tree = undefined;
});

test('parallel running calls: only the last running entry sweeps', async () => {
  await act(async () => {
    tree = create(<ActivitySheetHost sessionId="s-1" />);
  });
  const shimmers = tree!.root.findAll((node) => node.type === ('rn-shimmer' as never)).map((node) => node.props);
  expect(shimmers).toEqual([
    { title: 'Reading a.ts', loop: false },
    { title: 'Reading c.ts', loop: false },
    { title: 'Reading d.ts', loop: true },
  ]);
});
