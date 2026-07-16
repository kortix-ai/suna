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

    // The task count renders as a Badge chip (variant="muted"), not a
    // hand-rolled `bg-muted rounded px-1.5 py-0.5` span.
    expect(html).toContain('2 tasks');
    expect(html).toContain('bg-muted/50');
  });

  test('panel surface renders the standard sticky large header', () => {
    const html = renderToStaticMarkup(
      <ToolSurfaceContext.Provider value="panel">
        <AgentStatusTool part={makePart(OUTPUT)} />
      </ToolSurfaceContext.Provider>,
    );

    // Grammar: panel header = sticky px-4 pt-4 pb-3, <h3> title text-sm font-medium.
    expect(html).toContain('sticky');
    expect(html).toContain('pt-4');
    expect(html).toContain('pb-3');
    expect(html).toContain('text-sm font-medium');
    expect(html).toContain('Agent status');

    // Body content (the task rows) is preserved, not dropped by the shell.
    expect(html).toContain('Write the report');
    expect(html).toContain('Fix the failing test');
  });
});
