import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ToolPart } from '@/ui';

import { ToolSurfaceContext } from '@/features/session/tool/shared/infrastructure';
import { AgentStatusTool } from './agent-status-tool';

// Representative test for the whole agent + task family (Task 3): every file
// in the family was converted to the same BasicTool shell, so one file
// exercised in both surfaces stands in for the other ten near-identical
// conversions rather than duplicating this test 11 times.

function makePart(output: string): ToolPart {
  return {
    type: 'tool',
    tool: 'agent_status',
    callID: 'call-1',
    state: {
      status: 'completed',
      input: {},
      output,
      metadata: {},
    },
  } as unknown as ToolPart;
}

const OUTPUT = [
  '**task-abc12345** Write the report — completed',
  '**task-def67890** Fix the failing test — in_progress',
].join('\n');

describe('AgentStatusTool joins the shared BasicTool shell', () => {
  test('inline surface renders the standard compact row, not bespoke chrome', () => {
    const html = renderToStaticMarkup(<AgentStatusTool part={makePart(OUTPUT)} />);

    // Grammar: inline row = flex items-center gap-1.5 py-0.5 text-xs text-muted-foreground/70.
    expect(html).toContain('items-center');
    expect(html).toContain('gap-1.5');
    expect(html).toContain('py-0.5');
    expect(html).toContain('text-muted-foreground/70');

    // Title comes from the shared trigger, not a hand-rolled <Layers> header.
    expect(html).toContain('Agent status');

    // The inline row is the label alone. The trailing metadata cluster
    // (duration, badge, accessory) was removed from the inline surface: in a
    // chain of activity steps it read as chrome hanging off the right edge
    // rather than information. The badge still renders on the panel surface —
    // asserted in the panel test below, so the "Badge chip, not hand-rolled
    // span" guarantee is still covered.
    expect(html).not.toContain('2 tasks');
  });

  // Task 16 REWRITE: the panel surface is no longer a sticky `px-4 pt-4 pb-3`
  // header over an always-open body — it is a `bg-popover rounded-md border`
  // disclosure row, closed unless the caller seeds it open. The grammar pinned
  // below is the row's: one line, title + badge + chevron, body behind the
  // disclosure. (A detail holding three calls used to stack three page headers.)
  test('panel surface renders a closed disclosure row, badge on the row', () => {
    const html = renderToStaticMarkup(
      <ToolSurfaceContext.Provider value="panel">
        <AgentStatusTool part={makePart(OUTPUT)} />
      </ToolSurfaceContext.Provider>,
    );

    // Grammar: panel row = bg-popover rounded-md border, px-3 py-2.5, min-h-11.
    expect(html).not.toContain('sticky');
    expect(html).toContain('bg-popover border-border overflow-hidden rounded-md border');
    expect(html).toContain('min-h-11 w-full items-center gap-2.5 px-3 py-2.5');
    expect(html).toContain('text-sm font-medium');
    expect(html).toContain('Agent status');

    // The task count still renders as a Badge chip (variant="muted"), not a
    // hand-rolled `bg-muted rounded px-1.5 py-0.5` span — it just sits in the
    // row's trailing slot now instead of a header's top-right corner.
    expect(html).toContain('2 tasks');
    expect(html).toContain('bg-muted/50');

    // Closed: the task rows are behind the disclosure, not on screen.
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('Write the report');
  });

  test('panel surface opened: the task rows are the body, nothing is dropped', () => {
    const html = renderToStaticMarkup(
      <ToolSurfaceContext.Provider value="panel">
        <AgentStatusTool part={makePart(OUTPUT)} defaultOpen />
      </ToolSurfaceContext.Provider>,
    );

    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('Write the report');
    expect(html).toContain('Fix the failing test');
  });
});
