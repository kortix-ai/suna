import { afterEach, beforeAll, expect, mock, test } from 'bun:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { TEXT_PREVIEW_MAX_BYTES, TEXT_TRUNCATE_DISPLAY_BYTES } from '@/lib/files/preview-limits';

type HostProps = React.PropsWithChildren<Record<string, unknown>>;
const host = (name: string) => ({ children, ...props }: HostProps) => React.createElement(name, props, children);
const none = () => null;
const MermaidBlock = host('mermaid');
let colorScheme = 'dark';
const chart = 'graph TD\n  Start --> Finish';
const readFile = mock((_url: string, _path: string | undefined, _options: { enabled: boolean }) => ({ data: chart, isLoading: false, isError: false }));

mock.module('react-native', () => ({ View: host('view'), Image: host('image'), ScrollView: host('scroll'), Platform: { OS: 'ios' }, useWindowDimensions: () => ({ width: 400, height: 800 }) }));
mock.module('react-native-webview', () => ({ WebView: host('webview') }));
mock.module('nativewind', () => ({ useColorScheme: () => ({ colorScheme }) }));
mock.module('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
mock.module('expo-file-system/legacy', () => ({}));
mock.module('@/components/markdown/mermaid/MermaidBlock', () => ({ MermaidBlock }));
mock.module('@/components/ui/text', () => ({ Text: host('text') }));
mock.module('@/components/ui/icon', () => ({ Icon: none }));
mock.module('@/components/ui/button', () => ({ Button: host('button') }));
mock.module('@/components/kortix/kortix-loader', () => ({ KortixLoader: none }));
mock.module('@/components/kortix/pressable-surface', () => ({ PressableSurface: host('pressable') }));
mock.module('@/components/kortix/selectable-markdown', () => ({ SelectableMarkdownText: host('markdown') }));
mock.module('@/lib/utils/theme', () => ({ THEME: { light: { background: '#fff', foreground: '#000', secondary: '#eee' }, dark: { background: '#000', foreground: '#fff', secondary: '#111' } }, withAlpha: (color: string) => color }));
mock.module('@/lib/utils/mono-font', () => ({ MONO_FONT_FAMILY: 'mono' }));
mock.module('@/lib/logger', () => ({ log: { error: none } }));
mock.module('@/lib/utils/open-link', () => ({ openLink: async () => {} }));
mock.module('@/lib/icons', () => ({ WarningCircleIcon: none, FileTextIcon: none, ArrowSquareOutIcon: none, FileIcon: none, FileXIcon: none, GlobeIcon: none, MusicNotesIcon: none, PlayIcon: none, WarningIcon: none }));
mock.module('@/components/session/turn/use-sandbox-image', () => ({ useSandboxImage: () => ({ phase: 'ready' }) }));
mock.module('@/contexts/SandboxContext', () => ({ useSandboxContext: () => ({ sandboxUrl: 'https://sandbox.example.test' }) }));
mock.module('@/lib/files/hooks', () => ({ useSandboxFileContent: readFile }));
mock.module('@/components/session/tool/shared/infrastructure', () => ({ HighlightedCode: host('code'), MarkdownFrontmatterCard: none, ToolMarkdown: host('markdown'), useToolNavigation: () => ({ enabled: true, openFile: none, openExternal: none }) }));
mock.module('@/components/session/tool/shared/surface', () => ({ ToolScroll: host('scroll') }));
mock.module('@/components/session/tool/shared/styles', () => ({ FONT_MEDIUM: 'medium', monoFont: 'mono', TURN_SPACE: { cardPad: 12 }, TURN_TYPE: { xs: {} }, useTurnPalette: () => ({ border: '#000', foreground80: '#000' }) }));

let files: typeof import('./FilePreviewRenderers');
let show: typeof import('../session/tool/tools/show-content-renderer');
let tree: ReactTestRenderer | undefined;
beforeAll(async () => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
  files = await import('./FilePreviewRenderers');
  show = await import('../session/tool/tools/show-content-renderer');
});
afterEach(async () => {
  await act(async () => tree?.unmount());
  tree = undefined;
  colorScheme = 'dark';
  readFile.mockClear();
});
async function render(element: React.ReactElement) {
  let mounted!: ReactTestRenderer;
  await act(async () => { mounted = create(element); });
  tree = mounted;
  return mounted.root;
}

for (const filename of ['flow.mmd', 'flow.mermaid']) {
  test(`file preview ${filename} reaches MermaidBlock`, async () => {
    const root = await render(<files.FilePreview fileName={filename} previewType={files.getFilePreviewType(filename)} content={chart} />);
    expect(root.findByType(MermaidBlock).props).toEqual({ chart, language: 'mermaid', isDark: true });
  });
}
test('truncated mermaid file renders selectable source instead of an incomplete diagram', async () => {
  const content = chart + '\n%% padding'.repeat(TEXT_PREVIEW_MAX_BYTES / 10 + 1);
  const root = await render(<files.FilePreview fileName="large.mmd" previewType={files.getFilePreviewType('large.mmd')} content={content} />);
  expect(root.findAllByType(MermaidBlock)).toHaveLength(0);
  const source = root.findAllByType('text').find(node => node.props.selectable);
  expect(source?.props.children).toBe(content.slice(0, TEXT_TRUNCATE_DISPLAY_BYTES));
  expect(root.findAllByType('text').some(node => JSON.stringify(node.props.children).includes('Download the file'))).toBe(true);
});
test('inline mermaid reaches MermaidBlock with light theme', async () => {
  colorScheme = 'light';
  const root = await render(<show.ShowContentRenderer type="mermaid" content={chart} />);
  expect(root.findByType(MermaidBlock).props).toEqual({ chart, language: 'mermaid', isDark: false });
});
for (const filename of ['flow.mmd', 'flow.mermaid']) {
  test(`file-backed show ${filename} reads and renders the diagram`, async () => {
    const path = `/workspace/${filename}`;
    const root = await render(<show.ShowContentRenderer type="file" path={path} />);
    expect(readFile).toHaveBeenCalledWith('https://sandbox.example.test', path, { enabled: true });
    expect(root.findByType(MermaidBlock).props).toEqual({ chart, language: 'mermaid', isDark: true });
    expect(root.findAllByType('code')).toHaveLength(0);
  });
}
