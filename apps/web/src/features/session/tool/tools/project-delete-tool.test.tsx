import { describe, expect, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ToolPart } from '@/ui';

import { ToolSurfaceContext } from '@/features/session/tool/shared/infrastructure';
import { ProjectDeleteTool } from './project-delete-tool';

// Task 7: project-delete-tool.tsx bypassed BasicTool entirely (a hand-rolled
// `<div>` row, discovered on arrival per the Tasks 6-8 grading protocol —
// "if it bypasses BasicTool → full conversion"). This is the one genuinely
// new shape in this batch (everything else is <pre>/raw-div → OutputBlock,
// already covered by the get-mem/memory-search OutputBlock render tests), so
// it gets its own render test: content preserved, and it now renders through
// the shared row (inline) / panel header (panel) shell instead of a bespoke
// div.
const HARDCODED_UI_MESSAGES = {
  hardcodedUi: {
    componentsSessionToolRenderers: {
      line6211JsxTextWorkspaceDeleteDisabled: 'Workspace delete disabled',
    },
  },
};

function withProviders(node: ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={HARDCODED_UI_MESSAGES} onError={() => {}}>
      {node}
    </NextIntlClientProvider>
  );
}

function makePart(input: Record<string, unknown>): ToolPart {
  return {
    type: 'tool',
    tool: 'project_delete',
    callID: 'call-1',
    state: {
      status: 'completed',
      input,
      output: '',
      metadata: {},
    },
  } as unknown as ToolPart;
}

describe('ProjectDeleteTool joins the shared BasicTool shell', () => {
  test('inline surface: renders through the standard row, no bespoke div chrome, message preserved', () => {
    const html = renderToStaticMarkup(
      withProviders(<ProjectDeleteTool part={makePart({ project: 'kortix-web' })} />),
    );

    expect(html).toContain('Workspace delete disabled');
    expect(html).toContain('kortix-web');
    expect(html).not.toContain('text-muted-foreground/40 flex items-center gap-2 px-2.5 py-1 text-xs');
  });

  test('panel surface: standard sticky header, message preserved', () => {
    const html = renderToStaticMarkup(
      withProviders(
        <ToolSurfaceContext.Provider value="panel">
          <ProjectDeleteTool part={makePart({})} />
        </ToolSurfaceContext.Provider>,
      ),
    );

    expect(html).toContain('sticky');
    expect(html).toContain('text-sm font-medium');
    expect(html).toContain('Workspace');
    expect(html).toContain('Workspace delete disabled');
  });
});
