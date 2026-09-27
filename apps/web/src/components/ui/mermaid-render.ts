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
