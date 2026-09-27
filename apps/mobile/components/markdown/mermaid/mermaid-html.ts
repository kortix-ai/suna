/**
 * Pure pieces of the Mermaid renderer: web's configuration and cache key, the
 * HTML the two WebViews load, and the size of a rendered diagram.
 *
 * Web renders diagrams in the browser with `mermaid` (apps/web
 * `components/ui/mermaid-renderer.tsx`). The app runs the same Mermaid build
 * (11.15.0, `assets/mermaid/mermaid.min.webjs`) with the same configuration in
 * one hidden WebView, and shows the resulting SVG string in a static WebView.
 */

import { decidePreviewNavigation } from '@/lib/utils/html-embed';

/** Web's `mermaid.initialize` options, verbatim. */
export const MERMAID_CONFIG = {
  startOnLoad: false,
  securityLevel: 'strict',
  theme: 'base',
  fontFamily: 'ui-sans-serif, system-ui, sans-serif',
  gitGraph: {
    showBranches: true,
    showCommitLabel: true,
    mainBranchName: 'main',
    rotateCommitLabel: true,
  },
} as const;

/** A render that has not answered after this long fails, and the block shows code. */
export const MERMAID_RENDER_TIMEOUT_MS = 10_000;

/** Web's error for a diagram type Mermaid does not know; it shows the source as code. */
export const UNSUPPORTED_DIAGRAM_TYPE = 'unsupported_diagram_type';

/**
 * Web's cache key: a 32-bit string hash of the trimmed chart, base 36. The same
 * source always maps to the same rendered SVG.
 */
export function mermaidChartHash(chart: string): string {
  let hash = 0;
  const trimmed = chart.trim();
  for (let i = 0; i < trimmed.length; i++) {
    hash = (hash << 5) - hash + trimmed.charCodeAt(i);
    hash &= hash;
  }
  return hash.toString(36);
}

/**
 * Web checks the first line before it calls Mermaid, and a chart that fails the
 * check shows an error instead of a diagram. Same list, same test.
 */
const RENDER_STARTERS = [
  'graph',
  'flowchart',
  'sequencediagram',
  'sequence',
  'classdiagram',
  'class',
  'statediagram',
  'state',
  'erdiagram',
  'journey',
  'gantt',
  'pie',
  'gitgraph',
  'mindmap',
  'timeline',
  'sankey',
  'block',
  'quadrant',
  'requirement',
  'c4context',
  'c4container',
  'c4component',
  'c4dynamic',
];

export function hasRenderableMermaidStarter(chart: string): boolean {
  const firstLine = chart.trim().split('\n')[0]?.toLowerCase().trim() ?? '';
  if (!firstLine) return false;
  return RENDER_STARTERS.some((starter) => firstLine.startsWith(starter) || firstLine.includes(starter));
}

/** Maps a Mermaid exception to web's error value. */
export function mermaidErrorMessage(message: string): string {
  return /UnknownDiagramError|No diagram type detected/.test(message) ? UNSUPPORTED_DIAGRAM_TYPE : message;
}

export interface MermaidViewBox {
  width: number;
  height: number;
}

const VIEW_BOX = /viewBox="(-?[\d.eE+-]+)[ ,]+(-?[\d.eE+-]+)[ ,]+([\d.eE+-]+)[ ,]+([\d.eE+-]+)"/;

/** The size of a rendered diagram, from its root `viewBox`; null when it has none. */
export function parseMermaidViewBox(svg: string): MermaidViewBox | null {
  const match = VIEW_BOX.exec(svg);
  if (!match) return null;
  const width = Number(match[3]);
  const height = Number(match[4]);
  if (!(width > 0) || !(height > 0)) return null;
  return { width, height };
}

/**
 * Height of the diagram in a card `containerWidth` wide. Web's stylesheet sets
 * `max-width: 100% !important; height: auto !important` on Mermaid's
 * `width="100%"` SVG, so the diagram always spans the card width and keeps
 * its aspect ratio.
 */
export function mermaidDisplayHeight(viewBox: MermaidViewBox, containerWidth: number): number {
  return Math.ceil((containerWidth * viewBox.height) / viewBox.width);
}

/**
 * The hidden renderer page. Mermaid itself is injected after load (it is 3.3 MB
 * of minified JavaScript that contains `<!--`, which is unsafe inside an HTML
 * `<script>` element), then `__kortixMermaidBoot()` initializes it.
 *
 * Protocol: the app calls `__kortixMermaidRender({ id, chart })`; the page
 * posts `{ ready, version }` once, then `{ id, svg }` or `{ id, error }` per
 * request.
 */
export function rendererHtml(): string {
  return `<!doctype html>
<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body><div id="scratch" style="position:absolute;left:-10000px;top:0;width:800px"></div>
<script>
(function () {
  var seq = 0;
  function post(message) { window.ReactNativeWebView.postMessage(JSON.stringify(message)); }
  window.__kortixMermaidBoot = function () {
    try {
      window.mermaid.initialize(${JSON.stringify(MERMAID_CONFIG)});
      post({ ready: true, version: window.mermaid.version ? window.mermaid.version() : null });
    } catch (e) {
      post({ fatal: String((e && e.message) || e) });
    }
  };
  window.__kortixMermaidRender = function (request) {
    var scratch = document.getElementById('scratch');
    Promise.resolve()
      .then(function () { return window.mermaid.render('kortix-mermaid-' + (++seq), request.chart.trim(), scratch); })
      .then(function (result) { post({ id: request.id, svg: result.svg }); })
      .catch(function (e) { post({ id: request.id, error: String((e && e.message) || e) }); })
      .then(function () {
        var leftovers = document.querySelectorAll('[id^="dkortix-mermaid-"]');
        for (var i = 0; i < leftovers.length; i++) leftovers[i].remove();
        scratch.innerHTML = '';
      });
  };
})();
</script></body></html>`;
}

/**
 * `onShouldStartLoadWithRequest` for the Mermaid WebViews: only the inline
 * document loads. A link in a diagram never navigates or leaves the app.
 */
export function allowInlineDocumentLoad(request: { url: string }): boolean {
  return decidePreviewNavigation(request.url) === 'allow';
}

/** The script injected into the renderer page after it loads. */
export function rendererBootScript(mermaidSource: string): string {
  return `${mermaidSource}\n;window.__kortixMermaidBoot();true;`;
}

/** The call that asks the renderer page for one diagram. */
export function rendererRenderScript(id: number, chart: string): string {
  return `window.__kortixMermaidRender(${JSON.stringify({ id, chart })});true;`;
}

/**
 * Web's `.mermaid-container` overrides. Web writes `hsl(var(--card))` and
 * friends, but its tokens are `oklch(...)`, so every one of those values is
 * invalid at computed-value time and the property falls back to `unset`
 * (inherit). The same holds for `var(--font-geist-sans)`, which web never
 * defines. `unset` reproduces what web actually paints.
 */
const WEB_OVERRIDES = `
.mermaid-container .node { fill: unset !important; stroke: unset !important; }
.mermaid-container .cluster { fill: unset !important; stroke: unset !important; }
.mermaid-container text { fill: unset !important; font-family: unset !important; }
.mermaid-container .edgePath { stroke: unset !important; }
.mermaid-container .marker { fill: unset !important; }`;

export interface DisplayHtmlOptions {
  /** Fullscreen: the diagram fits the screen and pinch zoom is on. */
  zoomable?: boolean;
}

/**
 * A static page that shows one rendered SVG. It runs no script: Mermaid's SVG
 * is already sanitized (`securityLevel: 'strict'`), and the page only parses it.
 */
export function displayHtml(svg: string, { zoomable = false }: DisplayHtmlOptions = {}): string {
  const viewport = zoomable
    ? 'width=device-width,initial-scale=1,minimum-scale=1,maximum-scale=5,user-scalable=yes'
    : 'width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no';
  const layout = zoomable
    ? `html,body{height:100%}body{display:flex;align-items:center;justify-content:center}
.mermaid-container{width:100%}
.mermaid-container svg{max-width:100%!important;max-height:100vh!important;height:auto!important;display:block!important;margin:0 auto!important}`
    : `.mermaid-container svg{max-width:100%!important;height:auto!important;display:block!important;margin:0 auto!important}`;
  return `<!doctype html>
<html><head><meta name="viewport" content="${viewport}">
<style>html,body{margin:0;padding:0;background:transparent;-webkit-user-select:none;user-select:none}
${layout}${WEB_OVERRIDES}</style></head>
<body><div class="mermaid-container">${svg}</div></body></html>`;
}
