/**
 * MermaidBlock shows the diagram once the queue resolves, and the regular code
 * block until then — or forever when Mermaid rejects the source. The renderer
 * host is the test's fake: the real shared queue (the module the cache fix
 * changed) answers from `handleMessage` exactly as the WebView page posts, and
 * the sent scripts prove what the queue asked the renderer to render.
 */
import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

const host = (name: string) => ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
  React.createElement(name, props, children ?? null);
const none = () => null;

const webviewSources: { uri?: string; html?: string }[] = [];

mock.module('react-native', () => ({
  Pressable: host('pressable'),
  View: host('view'),
  useWindowDimensions: () => ({ width: 400, height: 800 }),
}));
mock.module('react-native-webview', () => ({
  WebView: ({ source }: { source?: { uri?: string; html?: string } }) => {
    webviewSources.push(source ?? {});
    return React.createElement('webview', { htmlLength: source?.html?.length ?? 0 });
  },
}));
mock.module('react-native-gesture-handler', () => ({ ScrollView: host('scroll') }));
mock.module('expo-clipboard', () => ({ setStringAsync: async () => {} }));
mock.module('@/components/ui/button', () => ({ Button: host('button') }));
mock.module('@/components/ui/dialog', () => ({
  Dialog: host('dialog'),
  DialogClose: host('dialogclose'),
  DialogContent: host('dialogcontent'),
  DialogTitle: host('dialogtitle'),
}));
mock.module('@/components/ui/icon', () => ({ Icon: none }));
mock.module('@/lib/haptics', () => ({ haptics: { tap: () => {}, success: () => {} } }));
mock.module('@/lib/icons', () => ({ CopyIcon: null, XIcon: null }));
mock.module('@/lib/logger', () => ({ log: { error: () => {} } }));
mock.module('@/lib/markdown/markdown-layout', () => ({ RADIUS: { lg: 12, md: 8 }, web: (n: number) => n }));
mock.module('@/lib/utils/theme', () => ({
  THEME: { light: { background: '#fff' }, dark: { background: '#000' } },
  withAlpha: (color: string) => color,
}));
mock.module('@/lib/code-theme', () => ({ languageLabel: () => 'mermaid' }));
mock.module('@/lib/highlight/shiki', () => ({ ensureLanguage: async () => {} }));
mock.module('@/lib/highlight/use-code-tokens', () => ({ useCodeTokens: () => null }));
mock.module('../code-block', () => ({ CodeBlock: host('codeblock') }));
mock.module('../copy-button', () => ({ CopyButton: none }));
mock.module('../markdown-theme', () => ({ markdownPalette: () => ({ border: '#ccc', strong: '#000' }) }));
mock.module('./MermaidRendererHost', () => ({ MermaidRendererPortal: none }));

const DIAGRAM_SVG = '<svg viewBox="0 0 100 50"><g></g></svg>';
// Distinct per test: the shared queue caches outcomes for the whole process.
const DIRECTIVE_CHART = '%%{init: {"theme":"base"}}%%\ngraph TD;A-->B';
const FRONT_MATTER_CHART = '---\ntitle: t\n---\ngraph TD;A-->B';
const GARBAGE_CHART = 'hello world';

let MermaidBlock: typeof import('./MermaidBlock').MermaidBlock;
let mermaidRenderQueue: typeof import('./mermaid-render-queue').mermaidRenderQueue;
beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  ({ MermaidBlock } = await import('./MermaidBlock'));
  ({ mermaidRenderQueue } = await import('./mermaid-render-queue'));
});

let tree: ReactTestRenderer | undefined;
afterEach(() => {
  act(() => tree?.unmount());
  tree = undefined;
  webviewSources.length = 0;
});

const sent: { id: number; chart: string }[] = [];
const inject = (script: string) => {
  const match = /^window\.__kortixMermaidRender\((.*)\);true;$/.exec(script);
  if (!match) throw new Error(`unexpected script ${script}`);
  sent.push(JSON.parse(match[1]));
};

const isNode = (name: string) => (node: { type: unknown }) => node.type === name;
const codeblocks = () => tree!.root.findAll((n) => isNode('codeblock')(n)).length;
const webviews = () => tree!.root.findAll((n) => isNode('webview')(n)).length;
/** The diagram card mounts its WebView once its row has a width: fake the layout event. */
const fireLayout = () =>
  act(() => {
    const node = tree!.root.find(
      (n) => isNode('view')(n) && typeof (n.props as { onLayout?: unknown }).onLayout === 'function'
    );
    (node.props as { onLayout: (event: { nativeEvent: { layout: { width: number } } }) => void }).onLayout({
      nativeEvent: { layout: { width: 350 } },
    });
  });
const renderBlock = (chart: string) =>
  act(() => {
    tree = create(<MermaidBlock chart={chart} language="mermaid" isDark={false} />);
  });
/** The fake renderer answers the one pending request, as the page would post. */
const answer = (svg: string) => {
  const request = sent[sent.length - 1];
  mermaidRenderQueue.handleMessage(JSON.stringify({ id: request.id, svg }));
  return act(async () => {});
};

describe('MermaidBlock', () => {
  test('a directive-first chart renders a diagram, not the code block', async () => {
    renderBlock(DIRECTIVE_CHART);
    // Until the diagram has rendered, the block is the regular code block.
    expect(codeblocks()).toBe(1);

    mermaidRenderQueue.attach(inject);
    // The queue asked the renderer to render the chart it received: no client
    // gate rejected the directive-first source.
    expect(sent[sent.length - 1].chart).toBe(DIRECTIVE_CHART);
    await answer(DIAGRAM_SVG);
    fireLayout();

    expect(codeblocks()).toBe(0);
    expect(webviews()).toBe(1);
    // The diagram shows in the static display page the app renders SVGs with.
    expect(webviewSources[0].html).toContain('mermaid-container');
    expect(webviewSources[0].html).toContain(DIAGRAM_SVG);
  });

  test('a front-matter chart renders a diagram, not the code block', async () => {
    renderBlock(FRONT_MATTER_CHART);
    mermaidRenderQueue.attach(inject);
    expect(sent[sent.length - 1].chart).toBe(FRONT_MATTER_CHART);
    await answer(DIAGRAM_SVG);
    fireLayout();

    expect(codeblocks()).toBe(0);
    expect(webviews()).toBe(1);
  });

  test('garbage source still ends as a code block through the renderer failure mapping', async () => {
    renderBlock(GARBAGE_CHART);
    mermaidRenderQueue.attach(inject);
    expect(sent[sent.length - 1].chart).toBe(GARBAGE_CHART);
    mermaidRenderQueue.handleMessage(
      JSON.stringify({ id: sent[sent.length - 1].id, error: 'UnknownDiagramError: No diagram type detected' })
    );
    await act(async () => {});

    expect(codeblocks()).toBe(1);
    expect(webviews()).toBe(0);
  });
});
