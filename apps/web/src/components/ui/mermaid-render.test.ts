import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { MERMAID_CONFIG, removeMermaidRenderArtifacts } from './mermaid-render';

const RENDERER_SOURCE = readFileSync(new URL('./mermaid-renderer.tsx', import.meta.url), 'utf8');

/** A document with a few named nodes; records which ones were removed. */
function fakeDocument(ids: string[]) {
  const removed: string[] = [];
  const nodes = new Map(ids.map((id) => [id, { remove: () => removed.push(id) }]));
  return {
    doc: { getElementById: (id: string) => (nodes.get(id) ?? null) as unknown as HTMLElement },
    removed,
  };
}

describe('Mermaid render errors stay inside the diagram', () => {
  test('Mermaid does not draw its own error diagram into the page', () => {
    expect(MERMAID_CONFIG.suppressErrorRendering).toBe(true);
    expect(MERMAID_CONFIG.securityLevel).toBe('strict');
  });

  test('cleanup removes only the nodes created for this render', () => {
    const { doc, removed } = fakeDocument([
      'app-root',
      'message-with-syntax-error-text',
      'mermaid-1',
      'dmermaid-1',
      'mermaid-2',
    ]);

    removeMermaidRenderArtifacts(doc, 'mermaid-1');

    expect(removed.sort()).toEqual(['dmermaid-1', 'mermaid-1']);
  });

  test('cleanup is a no-op when the render left nothing behind', () => {
    const { doc, removed } = fakeDocument(['app-root']);

    removeMermaidRenderArtifacts(doc, 'mermaid-9');

    expect(removed).toEqual([]);
  });

  test('the renderer never sweeps the whole document', () => {
    expect(RENDERER_SOURCE).not.toContain('document.querySelectorAll');
    expect(RENDERER_SOURCE).not.toContain('setInterval');
  });
});
