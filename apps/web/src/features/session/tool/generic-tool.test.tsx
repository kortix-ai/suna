import type { ToolPart } from '@/ui';
import { describe, expect, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ToolSurfaceContext } from '@/features/session/tool/shared/infrastructure';
import { GenericTool, parseToolName } from './generic-tool';

// `ToolOutputFallback` renders the output through `UnifiedMarkdown`, which
// calls `useTranslations` — the provider is what makes the open row renderable
// at all, not a message this test asserts on.
function withProviders(node: ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={{}} onError={() => {}}>
      {node}
    </NextIntlClientProvider>
  );
}

// `GenericTool` is the fallback renderer for every tool with no bespoke card —
// which is exactly where MCP tools land. Its member rows now sit DIRECTLY
// under a group row narrated by `humanizeToolName` ("Used Create Issue · 2
// times"), so a title that still read `Mcp  Linear  Create Issue` put a
// correctly humanized parent above a raw wire identifier in the same list.
describe('parseToolName', () => {
  test('an MCP `__` identifier is humanized, not word-split into itself', () => {
    const { display } = parseToolName('mcp__linear__create_issue');
    expect(display).toBe('Create Issue');
    expect(display).not.toContain('Mcp');
    expect(display).not.toContain('  ');
  });

  test('a `/`-namespaced tool keeps its server chip and its humanized leaf', () => {
    expect(parseToolName('linear/create_issue')).toEqual({
      server: 'linear',
      display: 'Create Issue',
    });
  });

  // Regression guard for the names that already rendered correctly.
  test('plain and snake_case names are unchanged', () => {
    expect(parseToolName('read')).toEqual({ server: null, display: 'Read' });
    expect(parseToolName('apply_patch')).toEqual({ server: null, display: 'Apply Patch' });
    expect(parseToolName('some-future-tool')).toEqual({
      server: null,
      display: 'Some Future Tool',
    });
  });

  // `oc-` is an alias prefix the registry adds, not part of the tool's name —
  // `humanizeToolName` strips it, so the row no longer reads "Oc Session Read".
  test('the `oc-` registry alias prefix never reaches the title', () => {
    expect(parseToolName('oc-session_read').display).toBe('Session Read');
  });
});

// Task 20 verification: `GenericTool` is the MCP fallback, so it is the view
// most likely to appear on the panel for a tool nobody wrote a card for. It
// must inherit the task-16 disclosure row with no work of its own — nothing
// here is rebuilt, this pins that inheritance.
describe('GenericTool on the panel surface', () => {
  const part = {
    type: 'tool',
    tool: 'mcp__linear__create_issue',
    callID: 'call-1',
    state: {
      status: 'completed',
      input: { title: 'Fix the seam', team: 'JAY' },
      output: 'Created issue JAY-1',
      metadata: {},
    },
  } as unknown as ToolPart;

  test('renders the shared panel row, humanized, closed, with the payload behind it', () => {
    const html = renderToStaticMarkup(
      withProviders(
        <ToolSurfaceContext.Provider value="panel">
          <GenericTool part={part} />
        </ToolSurfaceContext.Provider>,
      ),
    );

    // The task-16 row surface, not a header + always-open body.
    expect(html).toContain('bg-popover border-border overflow-hidden rounded-md border');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('sticky');

    // The trigger reads as a sentence, not as a wire identifier.
    expect(html).toContain('Create Issue');
    expect(html).not.toContain('mcp__linear__create_issue');
    expect(html).not.toContain('Mcp');

    // Closed means closed: the output is not in the markup.
    expect(html).not.toContain('Created issue JAY-1');
  });

  test('opened, the row shows the tool output', () => {
    const html = renderToStaticMarkup(
      withProviders(
        <ToolSurfaceContext.Provider value="panel">
          <GenericTool part={part} defaultOpen />
        </ToolSurfaceContext.Provider>,
      ),
    );

    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('Created issue JAY-1');
  });
});
