import type { Mermaid } from 'mermaid';
/**
 * Mermaid configuration and render cleanup, kept apart from the component so
 * the contract is testable without a DOM.
 *
 * A failed render must stay inside its own diagram. `suppressErrorRendering`
 * stops Mermaid from drawing its "Syntax error in text" diagram into the page;
 * `render()` then throws and the component shows its own error state. The only
 * nodes a render may leave behind are the two it created: the SVG (`chartId`)
 * and its wrapper (`d${chartId}`). Cleanup removes those by id and nothing
 * else — a sweep that matched on text would also match any app element whose
 * content quotes that text.
 */
export const MERMAID_CONFIG = {
  startOnLoad: false,
  securityLevel: 'strict',
  suppressErrorRendering: true,
  theme: 'base',
  fontFamily: 'ui-sans-serif, system-ui, sans-serif',
  gitGraph: {
    showBranches: true,
    showCommitLabel: true,
    mainBranchName: 'main',
    rotateCommitLabel: true,
  },
} as const;

/** Remove the temporary nodes one `mermaid.render(chartId, …)` call created. */
export function removeMermaidRenderArtifacts(
  doc: Pick<Document, 'getElementById'>,
  chartId: string,
): void {
  for (const id of [chartId, `d${chartId}`]) {
    doc.getElementById(id)?.remove();
  }
}

/**
 * Rendered SVG per diagram source, least recently used first.
 *
 * Keyed by the source text itself, not a hash of it: a 32-bit hash served one
 * diagram another diagram's SVG on a collision. Capped, because every distinct
 * source a tab renders would otherwise stay for the life of the tab.
 */
export const MERMAID_SVG_CACHE_MAX = 32;
const mermaidSvgCache = new Map<string, string>();

/** The cached SVG for `source`, marked as most recently used. */
export function readCachedMermaidSvg(source: string): string | undefined {
  const svg = mermaidSvgCache.get(source);
  if (svg === undefined) return undefined;
  mermaidSvgCache.delete(source);
  mermaidSvgCache.set(source, svg);
  return svg;
}

export function cacheMermaidSvg(source: string, svg: string): void {
  mermaidSvgCache.delete(source);
  mermaidSvgCache.set(source, svg);
  if (mermaidSvgCache.size > MERMAID_SVG_CACHE_MAX) {
    const oldest = mermaidSvgCache.keys().next().value;
    if (oldest !== undefined) mermaidSvgCache.delete(oldest);
  }
}

export function zoomAtPoint(zoom: number, panOffset: { x: number; y: number },
  point: { x: number; y: number }, zoomFactor: number) {
  const newZoom = Math.max(0.1, Math.min(5, zoom * zoomFactor));
  return { zoom: newZoom, panOffset: {
    x: point.x - (point.x - panOffset.x) * (newZoom / zoom),
    y: point.y - (point.y - panOffset.y) * (newZoom / zoom),
  } };
}

let mermaidInstance: Mermaid | null = null;
export async function renderMermaidSvg(source: string, onStart: () => void): Promise<string | undefined> {
  if (!source) return;

  const cachedResult = readCachedMermaidSvg(source);
  if (cachedResult) return cachedResult;
  onStart();
  // Check for basic Mermaid syntax
  const firstLine = source.split('\n')[0].toLowerCase().trim();
  const validStarters = [
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

  const hasValidStarter = validStarters.some(
    (starter) => firstLine.startsWith(starter) || firstLine.includes(starter),
  );

  if (!hasValidStarter) {
    throw new Error(
      `Invalid diagram type. Chart must start with a valid Mermaid diagram type (e.g., graph, flowchart, sequenceDiagram, etc.). Found: "${firstLine}"`,
    );
  }

  // Use cached Mermaid instance or initialize new one
  if (!mermaidInstance) {
    const mermaid = (await import('mermaid')).default;
    await mermaid.initialize({
      ...MERMAID_CONFIG,
      gitGraph: { ...MERMAID_CONFIG.gitGraph },
    });
    mermaidInstance = mermaid;
  }

  const chartId = `mermaid-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

  let result;
  try {
    result = await mermaidInstance.render(chartId, source);
  } catch (renderError) {
    const errorMessage =
      renderError instanceof Error ? renderError.message : String(renderError);

    // Remove the temporary nodes this render created, and only those.
    removeMermaidRenderArtifacts(document, chartId);

    if (errorMessage.includes('Parse error') || errorMessage.includes('Syntax error')) {
      throw new Error(`Diagram syntax error: ${errorMessage}`);
    } else if (errorMessage.includes('UnknownDiagramError')) {
      throw new Error('unsupported_diagram_type');
    } else {
      throw new Error(`Failed to render diagram: ${errorMessage}`);
    }
  }

  cacheMermaidSvg(source, result.svg);
  return result.svg;
}
