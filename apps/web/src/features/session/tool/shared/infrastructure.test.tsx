import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { BasicTool, ToolSurfaceContext } from '@/features/session/tool/shared/infrastructure';

describe('BasicTool panel surface — node trigger', () => {
  test('wraps a JSX-node trigger in the standard sticky panel header', () => {
    const html = renderToStaticMarkup(
      <ToolSurfaceContext.Provider value="panel">
        <BasicTool trigger={<span>Generating slides</span>}>
          <div>body</div>
        </BasicTool>
      </ToolSurfaceContext.Provider>,
    );

    // The sticky header container (same one the object-trigger branch uses).
    expect(html).toContain('sticky');
    expect(html).toContain('top-0');
    expect(html).toContain('pt-4');
    expect(html).toContain('pb-3');

    // The title-row layout must mirror PanelTriggerTitle's own row exactly —
    // same positioning classes as the object-trigger branch, not the shrunken
    // "items-center gap-2.5" inline-style row the fallback used before the fix.
    expect(html).toContain('items-start justify-between gap-3');
    expect(html).toContain('min-w-0 flex-1');
    expect(html).toContain('text-sm font-medium');

    // The node's own content must render inside that header, not the shrunken fallback row.
    expect(html).toContain('Generating slides');
  });
});
