import type { ToolPart } from '@/ui';
import { describe, expect, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ToolSurfaceContext } from '@/features/session/tool/shared/infrastructure';
import { hitPreview, MemorySearchTool } from './memory-search-tool';

// memory-search on the shared grammar: `BasicTool` shell, no bespoke chrome,
// and each hit FOLDED behind its own identity line rather than laid out flat.
//
// This file used to check the opposite — that every hit field rendered at once
// on a row of flat `bg-muted/20 rounded-sm` chrome. The fold replaced that, so
// the assertions inverted with it: the identity line (source/type, id,
// confidence, `hitPreview`'s first 80 chars) is what must be ON screen, and the
// body it hides — the tail of the content, the files, `OutputBlock`'s own
// `bg-muted/20` — is what must NOT be. A search answers with a list; five hits
// are five rows, not five documents.
//
// Note on the harness ceiling: these are all INVERSE assertions, and that is
// the most this file can prove. The positive open-state case — open a hit,
// see the full content and `docs/pricing.md` — is structurally unobtainable
// here. `renderToStaticMarkup` produces a string, not a document: there is no
// DOM to click and no effects run, so a `FoldedSection` can never be opened
// after its initial render — and the hit rows pass no `defaultOpen`, with no
// prop on `MemorySearchTool` to reach in and set one, so they cannot be asked
// to start open either. Both routes to an open hit are closed. So
// "the body is absent when closed" is the ceiling, and opening a hit is left
// to the Playwright journey and the acceptance shots.

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

    // The hit's identity line is the scannable part and stays: where it came
    // from, its id, its score, and the opening line of what it says.
    expect(html).toContain('competitor pricing notes');
    expect(html).toContain('LTM / note');
    expect(html).toContain('mem_204');
    expect(html).toContain('86');
    expect(html).toContain('User previously flagged that Acme undercuts');
    expect(html).toContain('1 result');
  });

  // Task 20: a search answers with a list, so each hit folds its body behind
  // its own line. Five hits are five rows, not five documents.
  test('inline surface: each hit folds its body behind its identity line', () => {
    const html = renderToStaticMarkup(
      withProviders(
        <MemorySearchTool
          part={makePart({ query: 'competitor pricing notes' }, SEARCH_OUTPUT)}
          defaultOpen
        />,
      ),
    );

    expect(html).toContain('aria-expanded="false"');
    // The preview stops at 80 chars, so the tail of the content and the hit's
    // files only exist inside the fold.
    expect(html).not.toContain('finalizing the comparison');
    expect(html).not.toContain('docs/pricing.md');
    // The markdown body is what folded away — `OutputBlock`'s surface is gone.
    expect(html).not.toContain('bg-muted/20');
  });

  // Task 16 REWRITE: the panel surface is a closed-by-default disclosure row,
  // not a sticky page header over an open body. The title assertion is the
  // point of this test and stays on the row; the result body needs the row
  // opened, which is what a single-call detail passes.
  test('panel surface: disclosure row, title reflects search kind', () => {
    const html = renderToStaticMarkup(
      withProviders(
        <ToolSurfaceContext.Provider value="panel">
          <MemorySearchTool
            part={makePart({ query: 'competitor pricing notes' }, SEARCH_OUTPUT)}
            defaultOpen
          />
        </ToolSurfaceContext.Provider>,
      ),
    );

    expect(html).not.toContain('sticky');
    expect(html).toContain('bg-popover border-border overflow-hidden rounded-md border');
    expect(html).toContain('text-sm font-medium');
    expect(html).toContain('LTM Search');
    expect(html).toContain('User previously flagged that Acme undercuts');
  });

  test('panel surface: closed by default, the results stay behind the row', () => {
    const html = renderToStaticMarkup(
      withProviders(
        <ToolSurfaceContext.Provider value="panel">
          <MemorySearchTool part={makePart({ query: 'competitor pricing notes' }, SEARCH_OUTPUT)} />
        </ToolSurfaceContext.Provider>,
      ),
    );

    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('LTM Search');
    expect(html).not.toContain('User previously flagged that Acme undercuts');
  });
});

// The folded hit's only name. These entries carry no title field, so this line
// is all a reader has to decide whether to open one.
describe('hitPreview', () => {
  test('takes the first non-empty line, not the whole body', () => {
    expect(hitPreview('\n\nFirst line\nsecond line\nthird')).toBe('First line');
  });

  test('a long line is truncated with an ellipsis so the row stays one line', () => {
    const line = 'x'.repeat(200);
    const preview = hitPreview(line);
    expect(preview).toHaveLength(80);
    expect(preview.endsWith('…')).toBe(true);
  });

  test('a short single-line memory is shown whole', () => {
    expect(hitPreview('User prefers dark mode')).toBe('User prefers dark mode');
  });
});
