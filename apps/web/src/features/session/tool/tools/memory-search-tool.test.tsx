import { describe, expect, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ToolPart } from '@/ui';

import { ToolSurfaceContext } from '@/features/session/tool/shared/infrastructure';
import { MemorySearchTool } from './memory-search-tool';

// Task 5: memory-search rebuilt on the grammar (BasicTool + ToolSection +
// flat bg-muted/20 rounded-sm rows). Content-preservation check — every hit
// field (source/type, id, confidence, content, files) still renders.

// MemorySearchTool calls `useTranslations('hardcodedUi')` unconditionally
// (for its "% conf" suffix) — see show-tool.test.tsx for the same
// requirement.
const HARDCODED_UI_MESSAGES = {
  hardcodedUi: {
    componentsSessionToolRenderers: {
      line2011JsxTextConf: '% conf',
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

function makePart(input: Record<string, unknown>, output: string): ToolPart {
  return {
    type: 'tool',
    tool: 'memory_search',
    callID: 'call-1',
    state: {
      status: 'completed',
      input,
      output,
      metadata: {},
    },
  } as unknown as ToolPart;
}

const SEARCH_OUTPUT = JSON.stringify({
  query: 'competitor pricing notes',
  source: 'ltm',
  results: [
    {
      id: 'mem_204',
      type: 'note',
      source: 'ltm',
      confidence: 0.86,
      content:
        'User previously flagged that Acme undercuts on annual billing discounts — check before finalizing the comparison.',
      files: ['docs/pricing.md'],
    },
  ],
});

describe('MemorySearchTool joins the shared BasicTool shell', () => {
  test('inline surface: no bespoke sky label/gradient chrome, hit content preserved', () => {
    const html = renderToStaticMarkup(
      withProviders(
        <MemorySearchTool
          part={makePart({ query: 'competitor pricing notes' }, SEARCH_OUTPUT)}
          defaultOpen
        />,
      ),
    );

    expect(html).not.toContain('rounded-2xl');
    expect(html).not.toContain('shadow-sm');
    expect(html).not.toContain('bg-gradient');
    expect(html).not.toContain('sky-');

    expect(html).toContain('bg-muted/20');
    expect(html).toContain('competitor pricing notes');
    expect(html).toContain('User previously flagged that Acme undercuts');
    expect(html).toContain('mem_204');
    expect(html).toContain('86');
    expect(html).toContain('docs/pricing.md');
    expect(html).toContain('1 result');
  });

  test('panel surface: standard sticky header, title reflects search kind', () => {
    const html = renderToStaticMarkup(
      withProviders(
        <ToolSurfaceContext.Provider value="panel">
          <MemorySearchTool
            part={makePart({ query: 'competitor pricing notes' }, SEARCH_OUTPUT)}
          />
        </ToolSurfaceContext.Provider>,
      ),
    );

    expect(html).toContain('sticky');
    expect(html).toContain('text-sm font-medium');
    expect(html).toContain('LTM Search');
    expect(html).toContain('User previously flagged that Acme undercuts');
  });
});
