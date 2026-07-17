import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  BasicTool,
  BoundActivateContext,
  ToolSurfaceContext,
} from '@/features/session/tool/shared/infrastructure';

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

describe('BasicTool inline surface — activate context vs defaultOpen', () => {
  const activate = () => {};

  test('defaultOpen renders the body inline even when an activate context is bound', () => {
    // The regression: chat binds BoundActivateContext for every tool row, and
    // the activate branch discarded `defaultOpen` — collapsing `show`'s
    // carousel to a bare "Show · N items" line with no content anywhere inline.
    const html = renderToStaticMarkup(
      <BoundActivateContext.Provider value={activate}>
        <BasicTool trigger={{ title: 'Show', subtitle: '4 items' }} defaultOpen>
          <div>carousel body</div>
        </BasicTool>
      </BoundActivateContext.Provider>,
    );
    expect(html).toContain('carousel body');
  });

  test('without defaultOpen the activate row still wins (no inline body)', () => {
    const html = renderToStaticMarkup(
      <BoundActivateContext.Provider value={activate}>
        <BasicTool trigger={{ title: 'Read', subtitle: 'file.ts' }}>
          <div>file contents</div>
        </BasicTool>
      </BoundActivateContext.Provider>,
    );
    expect(html).not.toContain('file contents');
  });
});
