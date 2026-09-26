import { describe, expect, test } from 'bun:test';
import { parseWebSearchOutput } from '@kortix/sdk';

import {
  countWebSearchSources,
  webSearchSourceSegments,
  webSearchTriggerBadge,
  webSearchTriggerLabel,
} from './web-search';

// Port of apps/web `tool/tools/web-search-tool.test.tsx`: the web card is a
// flat source list — no per-domain accordions, no "N results" group labels
// inside the list. The trigger alone carries the "N results" count.

function results(sources: Array<{ title: string; url: string }>) {
  return parseWebSearchOutput(JSON.stringify({ results: sources }));
}

/** Every string the list body draws: captions and row titles. */
function listText(segments: ReturnType<typeof webSearchSourceSegments>): string {
  return segments
    .flatMap((s) => [s.caption ?? '', ...s.sources.map((src) => src.title)])
    .join('\n');
}

describe('web search list', () => {
  test('renders every source as a flat row — no disclosure groups', () => {
    const qrs = results([
      { title: 'LinkedIn — Marko', url: 'https://linkedin.com/in/marko' },
      { title: 'Kortix founder', url: 'https://markokraemer.com' },
      { title: 'GitHub', url: 'https://github.com/markokraemer' },
    ]);
    const segments = webSearchSourceSegments(qrs);
    const text = listText(segments);

    expect(text).toContain('LinkedIn — Marko');
    expect(text).toContain('Kortix founder');
    expect(text).toContain('GitHub');
    const total = countWebSearchSources(qrs);
    expect(webSearchTriggerBadge({ status: 'completed', isError: false, totalSources: total })).toBe(
      '3 results',
    );
    expect(text).not.toContain('results');
  });

  test('two sources on the same domain render as two flat rows, never a "N results" domain group', () => {
    const qrs = results([
      { title: 'Kortix SDK repo', url: 'https://github.com/kortix-ai/sdk' },
      { title: 'Suna repo', url: 'https://github.com/kortix-ai/suna' },
    ]);
    const segments = webSearchSourceSegments(qrs);
    expect(segments.flatMap((s) => s.sources)).toHaveLength(2);
    expect(listText(segments)).toContain('Kortix SDK repo');
    expect(listText(segments)).toContain('Suna repo');
    expect(
      webSearchTriggerBadge({ status: 'completed', isError: false, totalSources: countWebSearchSources(qrs) }),
    ).toBe('2 results');
    expect(listText(segments)).not.toContain('results');
  });

  test('a single-query search captions nothing; a multi-query search captions each non-empty query, humanised', () => {
    const single = webSearchSourceSegments([
      { query: 'kortix', sources: [{ title: 'Kortix', url: 'https://kortix.com' }] },
    ]);
    expect(single[0].caption).toBeUndefined();

    const multi = webSearchSourceSegments([
      { query: 'site:daytona.io Daytona sandboxes', sources: [{ title: 'Daytona', url: 'https://daytona.io' }] },
      { query: 'empty', sources: [] },
    ]);
    expect(multi[0].caption).toBe('Daytona sandboxes on daytona.io');
    expect(multi[1].caption).toBeUndefined();
  });

  test('a source without a title falls back to its URL', () => {
    const segments = webSearchSourceSegments([
      { query: 'q', sources: [{ title: '', url: 'https://example.com/a' }] },
    ]);
    expect(segments[0].sources[0].title).toBe('https://example.com/a');
  });
});

describe('web search trigger', () => {
  test('one query: the humanised query, never the engine syntax', () => {
    expect(
      webSearchTriggerLabel([{ query: 'site:daytona.io Daytona sandboxes', sources: [] }], 'ignored'),
    ).toBe('Daytona sandboxes on daytona.io');
  });

  test('several queries: "N searches"', () => {
    expect(
      webSearchTriggerLabel(
        [
          { query: 'a', sources: [] },
          { query: 'b', sources: [] },
        ],
        '',
      ),
    ).toBe('2 searches');
  });

  test('no parsed output yet: the input query, humanised', () => {
    expect(webSearchTriggerLabel([], 'site:github.com kortix')).toBe('kortix on github.com');
  });

  test('the badge is singular for one result and absent while running, on error, or with no sources', () => {
    expect(webSearchTriggerBadge({ status: 'completed', isError: false, totalSources: 1 })).toBe('1 result');
    expect(webSearchTriggerBadge({ status: 'running', isError: false, totalSources: 4 })).toBeUndefined();
    expect(webSearchTriggerBadge({ status: 'completed', isError: true, totalSources: 4 })).toBeUndefined();
    expect(webSearchTriggerBadge({ status: 'completed', isError: false, totalSources: 0 })).toBeUndefined();
  });
});
