/**
 * On an iOS binary without the `RNUITextView` native view, `SelectableMarkdownText`
 * renders the legacy selection fallback: a double tap on the text opens the
 * selection sheet (Select Text / Copy All), whose read-only live-markdown input
 * holds the message text. One tap does nothing.
 */
import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

type HostProps = React.PropsWithChildren<Record<string, unknown>>;
const host = (name: string) => ({ children, ...props }: HostProps) => React.createElement(name, props, children);
const none = () => null;
const noop = () => {};
const flatten = (style: unknown): Record<string, unknown> =>
  Array.isArray(style) ? Object.assign({}, ...style.map(flatten)) : ((style ?? {}) as Record<string, unknown>);

const pressables: Array<Record<string, unknown>> = [];
const markdownInputs: Array<Record<string, unknown>> = [];
const presented: number[] = [];

mock.module('react-native', () => ({
  StyleSheet: { flatten, create: (s: unknown) => s, absoluteFill: {} },
  View: host('view'),
  Text: host('rntext'),
  Pressable: ({ onPress, ...props }: HostProps & { onPress?: unknown }) => {
    pressables.push({ onPress });
    return React.createElement('pressable', props);
  },
  Platform: { OS: 'ios', select: (o: Record<string, unknown>) => o.ios },
  UIManager: { hasViewManagerConfig: () => false },
  LogBox: { ignoreLogs: noop },
  useWindowDimensions: () => ({ width: 400, height: 800, fontScale: 1 }),
}));
mock.module('react-native-uitextview', () => ({ UITextView: host('uitextview') }));
mock.module('react-native-gesture-handler', () => ({ ScrollView: host('gh-scroll') }));
mock.module('expo-linear-gradient', () => ({ LinearGradient: host('linear-gradient') }));
mock.module('react-native-reanimated', () => ({ default: { View: host('animated-view') }, Easing: { bezier: () => 0 }, Keyframe: class { duration() { return this; } } }));
mock.module('@gorhom/bottom-sheet', () => ({
  BottomSheetModal: none,
  BottomSheetView: host('bottom-sheet-view'),
  TouchableOpacity: host('bs-touchable'),
}));
// The fallback's modal: renders its content, and `present()` is observable.
mock.module('@/components/kortix/sheet', () => ({
  KortixBottomSheetModal: ({ children, ...props }: HostProps & { ref?: unknown }) =>
    React.createElement('sheet-modal', props, children),
}));
mock.module('@expensify/react-native-live-markdown/src/MarkdownTextInput', () => ({
  default: (props: Record<string, unknown>) => {
    markdownInputs.push(props);
    return React.createElement('markdown-input', { value: props.value, editable: props.editable });
  },
}));
mock.module('expo-haptics', () => ({ impactAsync: noop, notificationAsync: noop, ImpactFeedbackStyle: { Medium: 'medium' }, NotificationFeedbackType: { Success: 'success' } }));
mock.module('expo-clipboard', () => ({ setStringAsync: async () => {} }));
mock.module('nativewind', () => ({ useColorScheme: () => ({ colorScheme: 'light' }) }));
mock.module('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
mock.module('@/lib/icons', () => ({ CopyIcon: none }));
mock.module('@/lib/utils/live-markdown-config', () => ({ markdownParser: noop, lightMarkdownStyle: {}, darkMarkdownStyle: {} }));
// Any theme token path resolves; this test reads no colour value.
const tokens = (): unknown => new Proxy(() => '#000', { get: (_t, key) => (key === Symbol.toPrimitive ? () => '#000' : tokens()) });
mock.module('@/lib/utils/theme', () => ({ MOTION: { easing: { out: [0, 0, 1, 1] }, duration: { moderate: 200 } }, THEME: tokens(), withAlpha: (c: string) => c }));
mock.module('@/lib/utils/fonts', () => ({ FONT_FAMILY: { regular: 'regular', medium: 'medium', semibold: 'semibold' } }));
mock.module('@/lib/logger', () => ({ log: { error: noop, warn: noop, info: noop } }));
mock.module('@/components/ui/button', () => ({ Button: none }));
mock.module('@/components/ui/icon', () => ({ Icon: none }));
mock.module('@/components/ui/text', () => ({ Text: host('text') }));
mock.module('@kortix/shared', () => ({
  isMathFenceLanguage: () => false,
  isMermaidCode: () => false,
  prepareMarkdownForMath: (s: string) => s,
}));
mock.module('react-native-markdown-display', () => ({
  default: host('markdown'),
  MarkdownIt: () => ({ use: () => ({}) }),
}));
mock.module('@/components/markdown/code-block', () => ({ CodeBlock: none, fenceCode: String, fenceLanguage: String }));
mock.module('@/components/markdown/inline-code', () => ({ InlineCode: host('inline-code') }));
mock.module('@/components/markdown/math', () => ({ BlockMath: none, InlineMath: host('inline-math') }));
mock.module('@/components/markdown/mermaid/MermaidBlock', () => ({ MermaidBlock: none }));
mock.module('@/components/genui/genui-message-block', () => ({ GenuiMessageBlock: none }));
mock.module('@/components/markdown/markdown-image', () => ({
  MarkdownImage: none,
  MarkdownImageGallery: none,
  MarkdownImagesContext: React.createContext(null),
}));
mock.module('@/lib/markdown/markdown-image', () => ({ groupImageBlocks: (blocks: string[]) => blocks.map((text, index) => ({ kind: 'markdown', index, text })), imageSourceKey: String }));
mock.module('@/lib/markdown/safe-link', () => ({ isSafeExternalLink: () => true }));
mock.module('@/lib/utils/open-link', () => ({ openLink: async () => {} }));

let SelectableMarkdownText: typeof import('./selectable-markdown').SelectableMarkdownText;
beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  ({ SelectableMarkdownText } = await import('./selectable-markdown'));
});

let tree: ReactTestRenderer | undefined;
afterEach(() => {
  act(() => tree?.unmount());
  tree = undefined;
  pressables.length = 0;
  markdownInputs.length = 0;
  presented.length = 0;
});

const render = (text: string) =>
  act(() => {
    tree = create(<SelectableMarkdownText isDark={false}>{text}</SelectableMarkdownText>);
  });

/** The text Pressable's tap handler (the fallback's only gesture target). */
const tapTarget = (): (() => void) | undefined => pressables[0]?.onPress as (() => void) | undefined;
const texts = (tree: ReactTestRenderer) =>
  ['text', 'rntext']
    .flatMap((type) => tree.root.findAllByType(type as never))
    .map((n: { props: { children?: unknown } }) => String(n.props.children));

describe('the iOS selection fallback (no RNUITextView in the binary)', () => {
  test('one tap does not open the selection sheet', () => {
    render('hello');
    const press = tapTarget();
    expect(press).toBeTruthy();
    act(() => press?.());
    expect(texts(tree!)).not.toContain('Select Text');
  });

  test('a double tap opens the sheet: title, hint, Copy All, and the read-only live-markdown input with the text', () => {
    render('hello **world**');
    const press = tapTarget();
    act(() => {
      press?.();
      press?.();
    });
    const labels = texts(tree!);
    expect(labels).toContain('Select Text');
    expect(labels).toContain('Tap and hold text to select');
    expect(labels).toContain('Copy All');
    // The sheet's input is the live-markdown one, read-only, holding the text.
    expect(markdownInputs.length).toBeGreaterThan(0);
    const input = markdownInputs[markdownInputs.length - 1];
    expect(input.value).toBe('hello **world**');
    expect(input.editable).toBe(false);
    expect(input.multiline).toBe(true);
    expect(input.scrollEnabled).toBe(true);
  });

  test('a second double tap while the sheet is already open leaves it open (no crash)', () => {
    render('hello');
    const press = tapTarget();
    act(() => {
      press?.();
      press?.();
    });
    expect(texts(tree!)).toContain('Select Text');
    // Tap again while the sheet is open: no crash, the sheet stays.
    act(() => {
      press?.();
      press?.();
    });
    expect(texts(tree!)).toContain('Select Text');
    expect(markdownInputs.length).toBeGreaterThanOrEqual(1);
  });
});
