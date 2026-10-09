/**
 * FilePreview renders a .json file pretty-printed while it is below
 * `JSON_PRETTY_PRINT_MAX_CHARS`, and raw once it is at or above it (the
 * parse + stringify would run synchronously on the JS thread). The renderer
 * is the code WebView, so the assertions read the HTML it feeds it.
 */
import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { JSON_PRETTY_PRINT_MAX_CHARS, TEXT_TRUNCATE_DISPLAY_BYTES } from '@/lib/files/preview-limits';

type HostProps = React.PropsWithChildren<Record<string, unknown>>;
const host = (name: string) => ({ children, ...props }: HostProps) => React.createElement(name, props, children);
const none = () => null;

const platform = { OS: 'android' };
const webviewSources: unknown[] = [];

mock.module('react-native', () => ({
  Platform: platform,
  View: host('view'),
  Image: host('image'),
  ScrollView: host('scroll'),
  useWindowDimensions: () => ({ width: 400, height: 800 }),
}));
mock.module('react-native-webview', () => ({
  WebView: ({ source }: { source?: { uri?: string; html?: string } }) => {
    webviewSources.push(source);
    return React.createElement('webview', { uri: source?.uri, htmlLength: source?.html?.length ?? 0 });
  },
}));
mock.module('nativewind', () => ({ useColorScheme: () => ({ colorScheme: 'dark' }) }));
mock.module('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
mock.module('expo-file-system/legacy', () => ({}));
mock.module('@/components/markdown/mermaid/MermaidBlock', () => ({ MermaidBlock: none }));
mock.module('@/components/ui/text', () => ({ Text: host('text') }));
mock.module('@/components/ui/icon', () => ({ Icon: none }));
mock.module('@/components/kortix/kortix-loader', () => ({ KortixLoader: none }));
mock.module('@/components/kortix/selectable-markdown', () => ({ SelectableMarkdownText: host('markdown') }));
mock.module('@/lib/utils/theme', () => ({
  THEME: {
    light: { background: 'light-bg', foreground: 'light-fg', card: 'light-card', border: 'light-border', destructive: 'light-destructive', muted: 'light-muted', mutedForeground: 'light-muted-fg', accent: { blue: 'blue' } },
    dark: { background: 'dark-bg', foreground: 'dark-fg', card: 'dark-card', border: 'dark-border', destructive: 'dark-destructive', muted: 'dark-muted', mutedForeground: 'dark-muted-fg', accent: { blue: 'blue' } },
  },
  withAlpha: (color: string) => color,
}));
mock.module('@/lib/utils/mono-font', () => ({ MONO_FONT_FAMILY: 'mono' }));
mock.module('@/lib/logger', () => ({ log: { error: none, warn: none } }));
mock.module('@/lib/utils/open-link', () => ({ openLink: async () => {} }));
mock.module('@/lib/utils/html-embed', () => ({
  HTML_SANITIZER_SCRIPT: '',
  decidePreviewNavigation: () => 'allow',
  escapeForInlineScript: (s: string) => s,
}));
mock.module('@/lib/icons', () => ({ WarningCircleIcon: none, FileTextIcon: none }));
mock.module('@/lib/files/hooks', () => ({
  useSandboxFileContent: none,
  useSandboxFileBlob: none,
  blobToDataURL: none,
}));

let FilePreview: typeof import('./FilePreviewRenderers').FilePreview;
let FilePreviewType: typeof import('./FilePreviewRenderers').FilePreviewType;
beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  ({ FilePreview, FilePreviewType } = await import('./FilePreviewRenderers'));
});

let tree: ReactTestRenderer | undefined;
afterEach(() => {
  act(() => tree?.unmount());
  tree = undefined;
  webviewSources.length = 0;
});

const renderPreview = (content: string) =>
  act(() => {
    tree = create(<FilePreview content={content} fileName="data.json" previewType={FilePreviewType.JSON} size={content.length} />);
  });

/** The single code WebView's HTML (the only WebView a .json preview mounts). */
const html = (): string => {
  const sources = webviewSources.filter((s): s is { html: string } => !!(s as { html?: string }).html);
  expect(sources).toHaveLength(1);
  return sources[0].html;
};

/** The code the WebView HTML embeds: `var codeStr = "…"` is a JSON string literal. */
const embeddedCode = (): string => {
  const match = html().match(/var codeStr = (.*);\n/);
  expect(match).toBeTruthy();
  return JSON.parse(match![1]);
};

describe('FilePreview JSON pretty-print boundary (JSON_PRETTY_PRINT_MAX_CHARS)', () => {
  test('a small .json file is pretty-printed (parsed, 2-space indent) in the code WebView', () => {
    renderPreview('{"b":1,"a":{"c":[2,3]}}');
    // Pretty-printed: the parsed object with one key per line, 2-space indent.
    expect(embeddedCode()).toBe('{\n  "b": 1,\n  "a": {\n    "c": [\n      2,\n      3\n    ]\n  }\n}');
    // The highlight.js language is json.
    expect(html()).toContain('"json"');
  });

  test('invalid JSON is shown as-is, not pretty-printed', () => {
    const raw = '{"b":1, oops';
    renderPreview(raw);
    expect(embeddedCode()).toBe(raw);
  });

  test('a .json file of exactly JSON_PRETTY_PRINT_MAX_CHARS renders raw (no parse, no re-indent)', () => {
    // Exactly at the limit: still under the text-truncate threshold, over the
    // pretty-print one — the raw bytes survive untouched.
    const content = '{"k":"' + 'v'.repeat(JSON_PRETTY_PRINT_MAX_CHARS - 8) + '"}';
    expect(content.length).toBe(JSON_PRETTY_PRINT_MAX_CHARS);
    renderPreview(content);
    expect(embeddedCode()).toBe(content); // raw, one line
  });

  test('a .json file past the text-truncate threshold is truncated first: the notice shows and the slice is not pretty-printed', () => {
    const content = '{"k":"' + 'v'.repeat(JSON_PRETTY_PRINT_MAX_CHARS - 7) + '"}';
    expect(content.length).toBe(JSON_PRETTY_PRINT_MAX_CHARS + 1);
    renderPreview(content);
    // The 200 KB display slice, shown as-is (the cut slice is not valid JSON).
    expect(embeddedCode()).toBe(content.slice(0, TEXT_TRUNCATE_DISPLAY_BYTES));
    expect(tree!.root.findAllByType('text' as never).some((n) => String(n.props.children).includes('Showing the first'))).toBe(true);
  });
});
