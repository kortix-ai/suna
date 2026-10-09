/**
 * An ```openui fence in chat markdown renders as a generative-UI block, not as
 * code. `FencedCode` reads the raw first word of the info string, so `openui`,
 * `openui-lang` and `openui-vN` all route; every other fence stays a code block.
 * The block's markdown fallback is one stable function per theme, and it keeps
 * the message's remote-image policy.
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

const ImagesContext = React.createContext<string>('placeholder');
const FENCE = /^```([^\n]*)\n([\s\S]*?)\n```\s*$/;

mock.module('react-native', () => ({
  StyleSheet: { flatten, create: (s: unknown) => s, absoluteFill: {} },
  View: host('view'),
  Text: host('rntext'),
  Pressable: host('pressable'),
  Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android },
  UIManager: { hasViewManagerConfig: () => false },
  LogBox: { ignoreLogs: noop },
  useWindowDimensions: () => ({ width: 400, height: 800, fontScale: 1 }),
}));
mock.module('react-native-uitextview', () => ({ UITextView: host('uitextview') }));
mock.module('react-native-gesture-handler', () => ({ ScrollView: host('gh-scroll') }));
mock.module('expo-linear-gradient', () => ({ LinearGradient: host('linear-gradient') }));
mock.module('react-native-reanimated', () => ({ default: { View: host('animated-view') }, Easing: { bezier: () => 0 }, Keyframe: class { duration() { return this; } } }));
mock.module('@gorhom/bottom-sheet', () => ({ BottomSheetModal: none, BottomSheetView: none, TouchableOpacity: none }));
mock.module('@/components/kortix/sheet', () => ({ KortixBottomSheetModal: none }));
mock.module('@expensify/react-native-live-markdown/src/MarkdownTextInput', () => ({ default: none }));
mock.module('expo-haptics', () => ({}));
mock.module('expo-clipboard', () => ({}));
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
// The renderer stub runs the real `fence` rule for a fenced block, and reports
// the image policy for anything else.
mock.module('react-native-markdown-display', () => ({
  default: ({ rules, children }: { rules: { fence: (node: unknown) => React.ReactNode }; children: string }) => {
    const match = FENCE.exec(children);
    if (match) return <>{rules.fence({ key: 'fence', content: `${match[2]}\n`, sourceInfo: match[1] })}</>;
    return React.createElement('markdown', { images: React.useContext(ImagesContext) }, children);
  },
  MarkdownIt: () => ({ use: () => ({}) }),
}));
mock.module('@/components/markdown/code-block', () => ({
  CodeBlock: host('code-block'),
  fenceCode: (content: string) => content.replace(/\n$/, ''),
  // The real one maps aliases; this stub drops anything after a dash, as an alias map might.
  fenceLanguage: (info: string) => (info.trim().split(/\s+/)[0] ?? '').split('-')[0],
}));
mock.module('@/components/markdown/inline-code', () => ({ InlineCode: host('inline-code') }));
mock.module('@/components/markdown/math', () => ({ BlockMath: none, InlineMath: host('inline-math') }));
mock.module('@/components/markdown/mermaid/MermaidBlock', () => ({ MermaidBlock: none }));
mock.module('@/components/markdown/markdown-image', () => ({
  MarkdownImage: none,
  MarkdownImageGallery: none,
  MarkdownImagesContext: ImagesContext,
}));
mock.module('@/lib/markdown/markdown-image', () => ({ groupImageBlocks: (blocks: string[]) => blocks.map((text, index) => ({ kind: 'markdown', index, text })), imageSourceKey: String }));
mock.module('@/lib/utils/open-link', () => ({ openLink: async () => {} }));
mock.module('@/components/genui/genui-message-block', () => ({ GenuiMessageBlock: host('genui-block') }));

let SelectableMarkdownText: typeof import('./selectable-markdown').SelectableMarkdownText;
beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  ({ SelectableMarkdownText } = await import('./selectable-markdown'));
});

let tree: ReactTestRenderer | undefined;
afterEach(() => {
  act(() => tree?.unmount());
  tree = undefined;
});

type RenderMarkdown = (markdown: string) => React.ReactNode;

function render(text: string, options: { isDark?: boolean; remoteImages?: 'load' | 'placeholder' } = {}) {
  act(() => {
    tree = create(
      <SelectableMarkdownText isDark={options.isDark ?? false} remoteImages={options.remoteImages}>
        {text}
      </SelectableMarkdownText>,
    );
  });
  return tree!.root;
}

const blocks = (root: ReturnType<typeof render>) => root.findAll((n) => n.type === ('genui-block' as never));
const codeBlocks = (root: ReturnType<typeof render>) => root.findAll((n) => n.type === ('code-block' as never));

describe('openui fences in chat markdown', () => {
  test('an ```openui fence renders the generative-UI block with its code and version, not a code block', () => {
    const root = render('```openui\nroot = Stack([a])\na = Badge("Hi")\n```');
    const [block] = blocks(root);
    expect(block?.props.code).toBe('root = Stack([a])\na = Badge("Hi")');
    expect(block?.props.version).toBe(1);
    expect(block?.props.isStreaming).toBe(false);
    expect(codeBlocks(root)).toHaveLength(0);
  });

  test('`openui-lang` and `openui-v2` route on the raw tag, even where the language name is normalized', () => {
    expect(blocks(render('```openui-lang\nroot = Stack([])\n```'))[0]?.props.version).toBe(1);
    expect(blocks(render('```openui-v2 extra words\nroot = Stack([])\n```'))[0]?.props.version).toBe(2);
  });

  test('any other fence stays a code block', () => {
    const root = render('```ts\nconst a = 1;\n```');
    expect(blocks(root)).toHaveLength(0);
    expect(codeBlocks(root)[0]?.props.code).toBe('const a = 1;');
  });

  test('the markdown fallback is one stable function per theme', () => {
    const light1 = blocks(render('```openui\nroot = Stack([])\n```'))[0]?.props.renderMarkdown;
    const light2 = blocks(render('```openui\nroot = Badge("x")\n```'))[0]?.props.renderMarkdown;
    const dark = blocks(render('```openui\nroot = Stack([])\n```', { isDark: true }))[0]?.props.renderMarkdown;
    expect(typeof light1).toBe('function');
    expect(light1).toBe(light2);
    expect(dark).not.toBe(light1);
  });

  test('the fallback renders markdown under the message image policy, and nothing for an empty string', () => {
    const renderMarkdown = blocks(render('```openui\nroot = Stack([])\n```', { remoteImages: 'load' }))[0]?.props
      .renderMarkdown as RenderMarkdown;
    expect(renderMarkdown('')).toBeNull();
    act(() => {
      tree = create(<ImagesContext.Provider value="load">{renderMarkdown('**Pick:** A')}</ImagesContext.Provider>);
    });
    const markdown = tree!.root.findAll((n) => n.type === ('markdown' as never));
    expect(markdown.map((n) => n.props.children)).toEqual(['**Pick:** A']);
    expect(markdown[0]?.props.images).toBe('load');
  });

  test('an openui fence inside a fallback renders as code, so a fallback never re-enters generative UI', () => {
    const renderMarkdown = blocks(render('```openui\nroot = Stack([])\n```'))[0]?.props.renderMarkdown as RenderMarkdown;
    act(() => {
      tree = create(<>{renderMarkdown('```openui\nroot = Badge("x")\n```')}</>);
    });
    expect(blocks(tree!.root)).toHaveLength(0);
    expect(codeBlocks(tree!.root)[0]?.props.code).toBe('root = Badge("x")');
  });
});
