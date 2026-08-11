import type { ToolPart } from '@/ui';
import { describe, expect, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { WebSearchTool } from './web-search-tool';

// Task 8: web search card rebuilt as a flat "Web sources" list — no
// per-domain Disclosure accordions, no per-query expand/collapse.
//
// The trigger row no longer calls `useTranslations` — it dropped the literal
// "Web Search" label entirely (the query itself is the row; the magnifying
// glass icon already says "search"). `NextIntlClientProvider` stays only
// because `render()` is a shared helper other tests in this file may extend.
const HARDCODED_UI_MESSAGES = {};

function withProviders(node: ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={HARDCODED_UI_MESSAGES} onError={() => {}}>
      {node}
    </NextIntlClientProvider>
  );
}

/** The flat source-list body only — excludes the trigger row, which now
 *  legitimately renders "N results" as the row's own count, not a per-domain
 *  group label. Scoping here is what lets both assertions coexist. */
function sourceListBody(html: string): string {
  const marker = 'data-scrollable="true"';
  const start = html.indexOf(marker);
  return start === -1 ? '' : html.slice(start);
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
          { title: 'dosco founder', url: 'https://markokraemer.com' },
          { title: 'GitHub', url: 'https://github.com/markokraemer' },
        ])}
        defaultOpen
      />,
    );
    expect(html).toContain('LinkedIn — Marko');
    expect(html).toContain('dosco founder');
    expect(html).toContain('GitHub');
    // The trigger legitimately shows "3 results" as the row's own count.
    expect(html).toContain('3 results');
    // The old per-domain accordion labeled each GROUP "N results" — that
    // must never reappear inside the list body itself.
    expect(sourceListBody(html)).not.toContain('results');
  });

  test('two sources on the same domain render as two flat rows, never a "N results" domain group', () => {
    const html = render(
      <WebSearchTool
        part={completedSearchPart([
          { title: 'dosco SDK repo', url: 'https://github.com/kortix-ai/sdk' },
          { title: 'Suna repo', url: 'https://github.com/kortix-ai/suna' },
        ])}
        defaultOpen
      />,
    );
    expect(html).toContain('dosco SDK repo');
    expect(html).toContain('Suna repo');
    // The trigger's own count is legitimate; only a PER-DOMAIN group label
    // inside the list body would be the regression this test guards against.
    expect(html).toContain('2 results');
    expect(sourceListBody(html)).not.toContain('results');
  });
});
