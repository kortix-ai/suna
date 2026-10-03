/**
 * Characterization for `AutoContinueSheet`'s two hand-written views: the list
 * (Off / On rows, one row per algorithm) and the algorithm detail (role,
 * description, best-for, strengths/weaknesses, how-it-works, Use). These pin
 * the fields and the light-theme colors the split into local list/detail
 * components must keep.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

mock.module('react-native', () => ({
  View: ({ children }: any) => React.createElement('rn-view', null, children),
  StyleSheet: { hairlineWidth: 1 },
  useWindowDimensions: () => ({ width: 400, height: 800 }),
}));
mock.module('@gorhom/bottom-sheet', () => ({
  BottomSheetModal: () => null,
  BottomSheetScrollView: ({ children }: any) => React.createElement('rn-scroll', null, children),
}));
mock.module('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 8 }) }));
mock.module('react-native-svg', () => ({
  default: ({ children }: any) => React.createElement('rn-svg', null, children),
  Svg: ({ children }: any) => React.createElement('rn-svg', null, children),
  Line: () => null,
}));
mock.module('@/components/kortix/sheet', () => ({
  KortixBottomSheetModal: React.forwardRef((props: any, _ref) => props.children ?? null),
  SheetBackdrop: () => null,
}));
mock.module('@/components/ui/text', () => ({
  Text: ({ children, ...props }: any) => React.createElement('rn-text', props, children),
}));
mock.module('@/components/ui/button', () => ({
  Button: ({ children, ...props }: any) => React.createElement('rn-button', props, children),
}));
mock.module('@/lib/icons', () => ({
  InfinityIcon: () => React.createElement('rn-infinity'),
  InfoIcon: () => React.createElement('rn-info'),
  CaretLeftIcon: () => React.createElement('rn-caret-left'),
  CheckIcon: () => React.createElement('rn-check'),
}));
mock.module('@/lib/utils/theme', () => ({
  THEME: {
    light: { foreground: '#light-fg', mutedForeground: '#light-muted' },
    dark: { foreground: '#dark-fg', mutedForeground: '#dark-muted' },
    accent: { purple: '#purple', green: '#green', orange: '#orange' },
  },
  withAlpha: (color: string, alpha: number) => `${color}~${alpha}`,
}));

let AutoContinueSheet: typeof import('./autocontinue').AutoContinueSheet;

beforeAll(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  ({ AutoContinueSheet } = await import('./autocontinue'));
});

const alg = {
  id: 'autowork',
  label: 'Kraemer',
  role: 'Connector',
  description: 'Fast TDD loop — reliable for clear specs',
  commandName: 'autowork',
  bestFor: 'Clear specs, coding tasks',
  strengths: ['Reliable and balanced speed/cost'],
  weaknesses: ['Can miss subtle edge cases'],
  howItWorks: 'Runs an autonomous loop until DONE, then self-reviews.',
} as React.ComponentProps<typeof AutoContinueSheet>['algorithms'][number];

const selected: unknown[] = [];
const closed: number[] = [];
let tree: ReactTestRenderer | undefined;

beforeEach(() => {
  selected.length = 0;
  closed.length = 0;
});
afterEach(async () => {
  if (tree) await act(async () => tree?.unmount());
  tree = undefined;
});

async function mount(selectedMode: 'autowork' | null) {
  await act(async () => {
    tree = create(
      <AutoContinueSheet
        visible
        onClose={() => closed.push(1)}
        selected={selectedMode}
        onSelect={(mode) => selected.push(mode)}
        algorithms={[alg]}
        isDark={false}
      />,
    );
  });
}

// The current host tree, walked for its texts and buttons.
type Node = { type: string; props: any; children?: any[] };
function nodes(root: any, out: Node[] = []): Node[] {
  if (!root || typeof root !== 'object') return out;
  out.push(root);
  for (const child of root.children ?? []) if (typeof child === 'object') nodes(child, out);
  return out;
}
const snapshot = () => nodes(tree?.toJSON() ?? null);
const nodeText = (node: Node): string => {
  const parts = (Array.isArray(node.children) ? node.children : [node.children]).filter(
    (child) => typeof child === 'string',
  );
  return parts.join('');
};
const subtreeTexts = (node: Node): string[] => nodes(node).filter((n) => n.type === 'rn-text').map(nodeText);
const texts = () => snapshot().filter((n) => n.type === 'rn-text').map(nodeText).filter(Boolean);
const textNode = (t: string) => snapshot().find((n) => n.type === 'rn-text' && nodeText(n) === t);
/** A row button by the texts it renders; a labelled button by its accessibilityLabel. */
const buttonLabeled = (label: string) =>
  snapshot().find((n) => n.type === 'rn-button' && n.props.accessibilityLabel === label);
const buttonWithTexts = (...parts: string[]) =>
  snapshot().find(
    (n) => n.type === 'rn-button' && parts.every((part) => subtreeTexts(n).includes(part)),
  );

describe('AutoContinueSheet (characterization)', () => {
  test('the list shows the Off/On rows and each algorithm, with the current palette', async () => {
    await mount(null);
    expect(texts()).toEqual([
      'AutoContinue',
      'Off',
      'Manual — you send each message',
      'On',
      'Pick an algorithm and the agent will continue on its own',
      'Algorithms',
      'Kraemer',
      'Connector',
      'Fast TDD loop — reliable for clear specs',
    ]);
    // Light palette: title in foreground, subtitles muted, the Off row hilited
    // while nothing is selected.
    expect(textNode('AutoContinue')?.props.style.color).toBe('#light-fg');
    expect(textNode('Manual — you send each message')?.props.style.color).toBe('#light-muted');
    const offRow = buttonWithTexts('Off');
    expect(offRow?.props.style.backgroundColor).toBe('#light-fg~0.03');
    expect(buttonLabeled('About Kraemer')).toBeDefined();

    // Picking Off turns AutoContinue off and closes the sheet.
    await act(async () => offRow?.props.onPress());
    expect(selected).toEqual([null]);
    expect(closed).toEqual([1]);
  });

  test('a selected mode shows "Running <label>", and the detail view shows the fields and dispatches Use', async () => {
    await mount('autowork');
    expect(texts()).toContain('Running Kraemer');

    const about = buttonLabeled('About Kraemer');
    await act(async () => about?.props.onPress());
    expect(texts()).toEqual([
      'Kraemer',
      'Use',
      'Role',
      'Connector',
      'Description',
      'Fast TDD loop — reliable for clear specs',
      'Best for',
      'Clear specs, coding tasks',
      'Strengths',
      '• Reliable and balanced speed/cost',
      'Weaknesses',
      '• Can miss subtle edge cases',
      'How it works',
      'Runs an autonomous loop until DONE, then self-reviews.',
    ]);

    // Back returns to the list without closing the sheet.
    await act(async () => buttonLabeled('Back')?.props.onPress());
    expect(texts()).toContain('AutoContinue');
    expect(closed).toEqual([]);

    // Use selects the algorithm and closes the sheet.
    await act(async () => buttonLabeled('About Kraemer')?.props.onPress());
    const use = snapshot().find(
      (n) => n.type === 'rn-button' && subtreeTexts(n).join('|') === 'Use',
    );
    await act(async () => use?.props.onPress());
    expect(selected).toEqual(['autowork']);
    expect(closed).toEqual([1]);
  });
});
