import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  displayHtml,
  hasRenderableMermaidStarter,
  MERMAID_CONFIG,
  mermaidChartHash,
  mermaidDisplayHeight,
  mermaidErrorMessage,
  parseMermaidViewBox,
  rendererBootScript,
  rendererHtml,
  rendererRenderScript,
  UNSUPPORTED_DIAGRAM_TYPE,
} from './mermaid-html';

const WEB_RENDERER = readFileSync(
  path.resolve(import.meta.dir, '../../../../web/src/components/ui/mermaid-renderer.tsx'),
  'utf8',
);

describe('parity with web mermaid-renderer.tsx', () => {
  test('initialize options are web options', () => {
    const block = /mermaid\.initialize\(\{([\s\S]*?)\n\s*\}\);/.exec(WEB_RENDERER)?.[1] ?? '';
    expect(block).toContain(`securityLevel: '${MERMAID_CONFIG.securityLevel}'`);
    expect(block).toContain(`theme: '${MERMAID_CONFIG.theme}'`);
    expect(block).toContain(`fontFamily: '${MERMAID_CONFIG.fontFamily}'`);
    expect(block).toContain(`mainBranchName: '${MERMAID_CONFIG.gitGraph.mainBranchName}'`);
    expect(block).toContain('startOnLoad: false');
    expect(block).toContain('showBranches: true');
    expect(block).toContain('showCommitLabel: true');
    expect(block).toContain('rotateCommitLabel: true');
  });

  test('chart hash is web hash', () => {
    // Web: (hash << 5) - hash + charCode, |0 per step, base 36, over the trimmed chart.
    expect(mermaidChartHash('graph TD\n  A --> B')).toBe(mermaidChartHash('  graph TD\n  A --> B\n'));
    let hash = 0;
    for (const char of 'sequenceDiagram') hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
    expect(mermaidChartHash('sequenceDiagram')).toBe(hash.toString(36));
    expect(mermaidChartHash('a')).not.toBe(mermaidChartHash('b'));
  });
});

describe('hasRenderableMermaidStarter', () => {
  test('accepts web-listed diagram types, anywhere in the first line', () => {
    expect(hasRenderableMermaidStarter('flowchart LR\nA-->B')).toBe(true);
    expect(hasRenderableMermaidStarter('  sequenceDiagram')).toBe(true);
    expect(hasRenderableMermaidStarter('stateDiagram-v2')).toBe(true);
    expect(hasRenderableMermaidStarter('%% title\ngraph TD')).toBe(false);
  });

  test('rejects types web rejects before calling Mermaid', () => {
    expect(hasRenderableMermaidStarter('xychart-beta')).toBe(false);
    expect(hasRenderableMermaidStarter('')).toBe(false);
  });
});

test('mermaidErrorMessage maps unknown diagram errors to web value', () => {
  expect(mermaidErrorMessage('UnknownDiagramError: No diagram type detected')).toBe(UNSUPPORTED_DIAGRAM_TYPE);
  expect(mermaidErrorMessage('Parse error on line 2')).toBe('Parse error on line 2');
});

describe('size', () => {
  test('parses Mermaid viewBox', () => {
    expect(parseMermaidViewBox('<svg id="m1" width="100%" viewBox="-8 -8 368.25 672.5" style="max-width: 368px;">')).toEqual({
      width: 368.25,
      height: 672.5,
    });
    expect(parseMermaidViewBox('<svg viewBox="0 0 0 10">')).toBeNull();
    expect(parseMermaidViewBox('<svg>')).toBeNull();
  });

  test('the diagram spans the card width and keeps its aspect ratio', () => {
    expect(mermaidDisplayHeight({ width: 400, height: 200 }, 350)).toBe(175);
    // Web scales a small diagram up to the card width too.
    expect(mermaidDisplayHeight({ width: 100, height: 50 }, 350)).toBe(175);
  });
});

describe('pages', () => {
  test('renderer page runs web config and posts id-tagged results', () => {
    const html = rendererHtml();
    expect(html).toContain(`window.mermaid.initialize(${JSON.stringify(MERMAID_CONFIG)})`);
    expect(html).toContain('post({ id: request.id, svg: result.svg })');
    expect(html).not.toContain('<script src');
  });

  test('boot and render scripts end in true, as injectJavaScript requires', () => {
    expect(rendererBootScript('var mermaid = 1;').endsWith(';window.__kortixMermaidBoot();true;')).toBe(true);
    const script = rendererRenderScript(7, 'graph TD\n  A["</script>"] --> B');
    expect(script).toBe('window.__kortixMermaidRender({"id":7,"chart":"graph TD\\n  A[\\"</script>\\"] --> B"});true;');
  });

  test('display page embeds the SVG with web overrides and no script', () => {
    const html = displayHtml('<svg viewBox="0 0 10 10"></svg>');
    expect(html).toContain('<div class="mermaid-container"><svg viewBox="0 0 10 10"></svg></div>');
    expect(html).toContain('max-width:100%!important;height:auto!important');
    expect(html).toContain('.mermaid-container text { fill: unset !important;');
    expect(html).toContain('user-scalable=no');
    expect(html).not.toContain('<script');
  });

  test('fullscreen page enables pinch zoom', () => {
    expect(displayHtml('<svg></svg>', { zoomable: true })).toContain('maximum-scale=5,user-scalable=yes');
  });
});

test('WebViews load only the inline document', async () => {
  const { allowInlineDocumentLoad } = await import('./mermaid-html');
  expect(allowInlineDocumentLoad({ url: 'about:blank' })).toBe(true);
  expect(allowInlineDocumentLoad({ url: 'https://kortix.com' })).toBe(false);
  expect(allowInlineDocumentLoad({ url: 'javascript:alert(1)' })).toBe(false);
  expect(allowInlineDocumentLoad({ url: 'file:///etc/hosts' })).toBe(false);
});
