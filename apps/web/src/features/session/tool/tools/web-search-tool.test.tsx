import { describe, expect, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ToolPart } from '@/ui';

import { WebSearchTool } from './web-search-tool';

// Task 8: web search card rebuilt as a flat "Web sources" list — no
// per-domain Disclosure accordions, no per-query expand/collapse.

// WebSearchTool calls `useTranslations('hardcodedUi')` unconditionally (for
// its "Web Search" trigger label) — see memory-search-tool.test.tsx for the
// same requirement.
const HARDCODED_UI_MESSAGES = {
  hardcodedUi: {
    componentsSessionToolRenderers: {
      line3806JsxTextWebSearch: 'Web Search',
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

function render(node: ReactNode) {
  return renderToStaticMarkup(withProviders(node));
}

function completedSearchPart(sources: Array<{ title: string; url: string }>) {
  return {
    id: 'p1',
    callID: 'c1',
    tool: 'web_search',
    type: 'tool',
    state: {
      status: 'completed',
      input: { query: 'marko kraemer' },
      output: JSON.stringify({ results: sources }),
    },
  } as unknown as ToolPart;
}

describe('WebSearchTool', () => {
  test('renders every source as a flat row — no disclosure groups', () => {
    const html = render(
      <WebSearchTool
        part={completedSearchPart([
          { title: 'LinkedIn — Marko', url: 'https://linkedin.com/in/marko' },
          { title: 'Kortix founder', url: 'https://markokraemer.com' },
          { title: 'GitHub', url: 'https://github.com/markokraemer' },
        ])}
        defaultOpen
      />,
    );
    expect(html).toContain('LinkedIn — Marko');
    expect(html).toContain('Kortix founder');
    expect(html).toContain('GitHub');
    // The old per-domain accordion rendered a "N results" count — gone.
    expect(html).not.toContain('results');
  });
});
