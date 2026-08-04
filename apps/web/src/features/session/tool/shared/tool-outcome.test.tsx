import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  BasicTool,
  partOutcome,
  ToolOutcomeContext,
} from '@/features/session/tool/shared/infrastructure';
import type { ToolPart } from '@/ui';

function part(state: Record<string, unknown>): Pick<ToolPart, 'state'> {
  return { state } as unknown as Pick<ToolPart, 'state'>;
}

/** The real scrape_webpage contract: three URLs, one dead host. */
const SCRAPE_PARTIAL = JSON.stringify({
  total: 3,
  successful: 2,
  failed: 1,
  results: [
    { url: 'https://www.postgresql.org/docs/', success: true, content: '# Advisory locks' },
    { url: 'https://sutharjay.com', success: true, content: '# Jay Suthar' },
    { url: 'https://example.invalid', success: false, error: 'DNS lookup failed (ENOTFOUND).' },
  ],
});

const SCRAPE_TOTAL_FAILURE = JSON.stringify({
  total: 1,
  successful: 0,
  failed: 1,
  results: [{ url: 'https://example.invalid', success: false, error: 'ENOTFOUND' }],
});

/** web_search's shape: `results[]` items are QUERIES, not per-item verdicts. */
const SEARCH_OK = JSON.stringify({
  results: [
    {
      query: 'postgres advisory lock',
      results: [{ title: 'Advisory Locks', url: 'https://www.postgresql.org/docs/' }],
    },
  ],
});

describe('partOutcome', () => {
  test('a thrown call failed', () => {
    expect(partOutcome(part({ status: 'error', error: 'Error: boom' }))).toBe('failed');
  });

  test('an in-flight call has no verdict yet', () => {
    expect(partOutcome(part({ status: 'running', input: {} }))).toBe('ok');
    expect(partOutcome(part({ status: 'pending', input: {} }))).toBe('ok');
  });

  test('a call that RETURNED a plain error failed', () => {
    // The reported bug: status is `completed`, so nothing upstream flagged it
    // and the tool kept drawing its own globe.
    expect(
      partOutcome(part({ status: 'completed', output: 'Error: DNS lookup failed (ENOTFOUND).' })),
    ).toBe('failed');
  });

  test('a call that returned the {success:false} contract failed', () => {
    expect(
      partOutcome(part({ status: 'completed', output: '{"success":false,"error":"Error: boom"}' })),
    ).toBe('failed');
  });

  test('a batch with one dead host is partial, not failed', () => {
    expect(partOutcome(part({ status: 'completed', output: SCRAPE_PARTIAL }))).toBe('partial');
  });

  test('a batch where every item died is a full failure', () => {
    expect(partOutcome(part({ status: 'completed', output: SCRAPE_TOTAL_FAILURE }))).toBe('failed');
  });

  test('web_search query groups are not mistaken for per-item verdicts', () => {
    expect(partOutcome(part({ status: 'completed', output: SEARCH_OK }))).toBe('ok');
  });

  test('ordinary output is ok', () => {
    expect(partOutcome(part({ status: 'completed', output: 'Wrote 12 lines.' }))).toBe('ok');
    expect(partOutcome(part({ status: 'completed', output: '' }))).toBe('ok');
  });

  test('non-JSON output that starts with a brace does not throw', () => {
    expect(partOutcome(part({ status: 'completed', output: '{not json at all' }))).toBe('ok');
  });
});

describe('BasicTool leading icon', () => {
  const globe = <svg data-testid="globe" />;

  test('an ok step keeps the tool own icon', () => {
    const html = renderToStaticMarkup(
      <BasicTool icon={globe} trigger={{ title: 'Scrape Webpage' }} />,
    );
    expect(html).toContain('data-testid="globe"');
  });

  test('a failed step replaces the globe with the warning mark', () => {
    // This is the regression verbatim: "I still see the globe icon when
    // something fails."
    const html = renderToStaticMarkup(
      <ToolOutcomeContext.Provider value="failed">
        <BasicTool icon={globe} trigger={{ title: 'Scrape Webpage' }} />
      </ToolOutcomeContext.Provider>,
    );
    expect(html).not.toContain('data-testid="globe"');
    expect(html).toContain('data-tone="failed"');
    expect(html).toContain('text-destructive');
  });

  test('a partial step is amber, not red', () => {
    const html = renderToStaticMarkup(
      <ToolOutcomeContext.Provider value="partial">
        <BasicTool icon={globe} trigger={{ title: 'Scrape Webpage' }} />
      </ToolOutcomeContext.Provider>,
    );
    expect(html).not.toContain('data-testid="globe"');
    expect(html).toContain('data-tone="partial"');
    expect(html).toContain('text-amber-600');
  });

  test('the row stops forcing muted onto a toned icon', () => {
    // The colour lives on the icon, but TOOL_ROW_CLASS paints every leading
    // svg from the row and that descendant selector outranks it. The `:not`
    // is what keeps the red red — without it the icon swaps but stays grey.
    const html = renderToStaticMarkup(
      <ToolOutcomeContext.Provider value="failed">
        <BasicTool icon={globe} trigger={{ title: 'Scrape Webpage' }} />
      </ToolOutcomeContext.Provider>,
    );
    expect(html).toContain('svg:not([data-tone])]:text-muted-foreground');
  });
});
