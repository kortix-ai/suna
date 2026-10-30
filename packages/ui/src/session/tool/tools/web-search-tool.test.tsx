import { toolCallBlock } from '@kortix/sdk';
import type { ToolPart } from '../../../internal/session-types';
import { describe, expect, test } from 'bun:test';
import { IntlTestProvider } from '../../../test-utils/intl';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { WebSearchTool } from './web-search-tool';

// Task 8: web search card rebuilt as a flat "Web sources" list — no
// per-domain Disclosure accordions, no per-query expand/collapse.
//
// The trigger row no longer calls `useTranslations` — it dropped the literal
// "Web Search" label entirely (the query itself is the row; the magnifying
// glass icon already says "search"). `IntlTestProvider` stays only
// because `render()` is a shared helper other tests in this file may extend.
const HARDCODED_UI_MESSAGES = {};

function withProviders(node: ReactNode) {
  return (
    <IntlTestProvider locale="en" messages={HARDCODED_UI_MESSAGES} onError={() => {}}>
      {node}
    </IntlTestProvider>
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
        call={toolCallBlock(completedSearchPart([
          { title: 'LinkedIn — Marko', url: 'https://linkedin.com/in/marko' },
          { title: 'Kortix founder', url: 'https://markokraemer.com' },
          { title: 'GitHub', url: 'https://github.com/markokraemer' },
        ]))}
        defaultOpen
      />,
    );
    expect(html).toContain('LinkedIn — Marko');
    expect(html).toContain('Kortix founder');
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
        call={toolCallBlock(completedSearchPart([
          { title: 'Kortix SDK repo', url: 'https://github.com/kortix-ai/sdk' },
          { title: 'Suna repo', url: 'https://github.com/kortix-ai/suna' },
        ]))}
        defaultOpen
      />,
    );
    expect(html).toContain('Kortix SDK repo');
    expect(html).toContain('Suna repo');
    // The trigger's own count is legitimate; only a PER-DOMAIN group label
    // inside the list body would be the regression this test guards against.
    expect(html).toContain('2 results');
    expect(sourceListBody(html)).not.toContain('results');
  });

  // KRTX-3016: a batch whose every query failed (a provider quota) rendered
  // "N searches" over an empty card. Each failed query now shows its error.
  test('a failed batch shows each query and its error, never an empty card', () => {
    const part = {
      id: 'p2',
      callID: 'c2',
      tool: 'web_search',
      type: 'tool',
      state: {
        status: 'completed',
        input: { query: ['desk cable tray', 'monitor riser'] },
        output: JSON.stringify({
          batch_mode: true,
          total_queries: 2,
          results: [
            { query: 'desk cable tray', success: false, error: 'Error: 432 Error: {"message":"Search is over its plan quota"}' },
            { query: 'monitor riser', success: false, error: 'Error: 432 Error: {"message":"Search is over its plan quota"}' },
          ],
        }),
      },
    } as unknown as ToolPart;
    const html = render(<WebSearchTool call={toolCallBlock(part)} defaultOpen />);
    expect(html).toContain('2 searches');
    expect(html).toContain('desk cable tray');
    expect(html).toContain('monitor riser');
    expect(html).toContain('over its plan quota');
    // KRTX-3022: the same failure is said once, then the searches it stopped.
    expect(html.split('over its plan quota').length - 1).toBe(1);
  });

  // KRTX-3022: Kortix's own answer for a provider limit reads as one plain
  // sentence, with the status in the chip and no raw JSON.
  test("a provider limit on Kortix's key reads as Kortix's sentence, not the provider's JSON", () => {
    const error =
      'Error: 503 Error: {"error":"tool_unavailable","service":"tavily","upstream_status":432,"message":"Web search is unavailable right now: Kortix\'s account with the provider is over its usage limit. This is not a limit on your account, and there is nothing to change on your side."}';
    const part = {
      id: 'p3',
      callID: 'c3',
      tool: 'web_search',
      type: 'tool',
      state: {
        status: 'completed',
        input: { query: ['desk cable tray', 'monitor riser'] },
        output: JSON.stringify({
          batch_mode: true,
          total_queries: 2,
          results: [
            { query: 'desk cable tray', success: false, error },
            { query: 'monitor riser', success: false, error },
          ],
        }),
      },
    } as unknown as ToolPart;
    const html = render(<WebSearchTool call={toolCallBlock(part)} defaultOpen />);
    expect(html).toContain('Web search is unavailable right now');
    expect(html).toContain('not a limit on your account');
    expect(html).toContain('>503<');
    expect(html).not.toContain('tool_unavailable');
    expect(html).not.toContain('{');
    expect(html).toContain('desk cable tray');
    expect(html).toContain('monitor riser');
  });

  test('different failures in one batch each keep their own line', () => {
    const part = {
      id: 'p4',
      callID: 'c4',
      tool: 'web_search',
      type: 'tool',
      state: {
        status: 'completed',
        input: { query: ['a query', 'b query'] },
        output: JSON.stringify({
          batch_mode: true,
          total_queries: 2,
          results: [
            { query: 'a query', success: false, error: 'Error: 400 Error: {"message":"Query is too long"}' },
            { query: 'b query', success: false, error: 'Error: 429 Error: {"message":"Slow down"}' },
          ],
        }),
      },
    } as unknown as ToolPart;
    const html = render(<WebSearchTool call={toolCallBlock(part)} defaultOpen />);
    expect(html).toContain('Query is too long');
    expect(html).toContain('Slow down');
  });
});
