import { TooltipProvider } from '@/components/ui/tooltip';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { OutputItem } from '../shared/derive-panels';
import { OutputRows, OutputsCard } from './outputs-card';

/** A minimal file output — defaults to a plausible scaffolding-free file so
 * callers only need to override what the test cares about. */
function out(overrides: Partial<OutputItem> & Pick<OutputItem, 'name'>): OutputItem {
  return {
    callID: `c-${overrides.name}`,
    kind: 'file',
    path: overrides.name,
    ...overrides,
  } as OutputItem;
}

function renderOutputRows(outputs: OutputItem[], initialShowAll?: boolean): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <OutputRows outputs={outputs} onOpenOutput={() => {}} initialShowAll={initialShowAll} />
    </TooltipProvider>,
  );
}

/** 12 outputs across 4 kinds, in already-deliverable-first order — exactly the
 *  shape `groupOutputsByKind` groups (>10, mixed) and `OutputRows` folds (>8). */
const MIXED_KIND_FIXTURE: OutputItem[] = [
  { callID: 'c1', name: 'report.pdf', kind: 'file' },
  { callID: 'c2', name: 'summary.docx', kind: 'file' },
  { callID: 'c3', name: 'budget.xlsx', kind: 'file' },
  { callID: 'c4', name: 'photo1.png', kind: 'image' },
  { callID: 'c5', name: 'photo2.png', kind: 'image' },
  { callID: 'c6', name: 'photo3.png', kind: 'image' },
  { callID: 'c7', name: 'clip1.mp4', kind: 'video' },
  { callID: 'c8', name: 'clip2.mp4', kind: 'video' },
  { callID: 'c9', name: 'clip3.mp4', kind: 'video' },
  { callID: 'c10', name: 'Deck 1', kind: 'presentation' },
  { callID: 'c11', name: 'Deck 2', kind: 'presentation' },
  { callID: 'c12', name: 'Deck 3', kind: 'presentation' },
];

describe('OutputRows display (W3/W11)', () => {
  test('title wins over filename; kind label rides right; fresh mark shows', () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <OutputRows
          outputs={[
            {
              callID: 'c1',
              name: 'quarterly_report_v2.pdf',
              title: 'Quarterly report',
              kind: 'file',
              path: 'quarterly_report_v2.pdf',
              fresh: 'updated',
            },
          ]}
          onOpenOutput={() => {}}
        />
      </TooltipProvider>,
    );
    expect(html).toContain('Quarterly report');
    expect(html).not.toContain('quarterly_report_v2.pdf'); // filename lives in the detail toolbar
    expect(html).toContain('PDF');
    expect(html).toContain('Updated');
  });

  test('a row carries no hover download affordance — opening the detail is the only row action', () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <OutputRows
          outputs={[{ callID: 'c1', name: 'a.pdf', kind: 'file', path: 'a.pdf' }]}
          onOpenOutput={() => {}}
        />
      </TooltipProvider>,
    );
    expect(html).not.toContain('aria-label="Download"');
  });
});

describe('OutputIcon image thumbnails (W13)', () => {
  test('an image output without a path keeps the glyph (nothing to thumbnail)', () => {
    const html = renderToStaticMarkup(
      <OutputRows
        outputs={[{ callID: 'i1', name: 'Image', kind: 'image' }]}
        onOpenOutput={() => {}}
      />,
    );
    expect(html).not.toContain('<img');
  });

  // The thumbnail cache is populated by a client-only effect (fetch the bytes,
  // build an object URL) — a static server render can never observe the loaded
  // state, only the glyph it starts as. Loaded-state coverage is Task 21's
  // visual verification, not this file's job.
  test('an image output with a path still starts as the glyph — the thumb loads client-side', () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <OutputRows
          outputs={[{ callID: 'i2', name: 'Generated image', kind: 'image', path: 'out.png' }]}
          onOpenOutput={() => {}}
        />
      </TooltipProvider>,
    );
    expect(html).not.toContain('<img');
    expect(html).toContain('Generated image');
  });
});

describe('OutputRows folds scaffolding behind "more files" (W16)', () => {
  test('scaffolding folds behind "more files" when real deliverables exist', () => {
    const html = renderOutputRows([
      out({ name: 'report.pdf' }),
      out({ name: 'helper.json' }),
      out({ name: 'notes.json' }),
    ]);
    expect(html).toContain('report.pdf');
    expect(html).not.toContain('helper.json');
    expect(html).toContain('2 more files');
  });

  test('scaffolding-only runs still show their files', () => {
    const html = renderOutputRows([out({ name: 'a.json' }), out({ name: 'b.json' })]);
    expect(html).toContain('a.json');
    expect(html).toContain('b.json');
  });
});

describe('OutputRows rhythm matches the Context card (W5)', () => {
  /**
   * New contract, replacing the untracked `py-1.5` + no-motion rows: every row
   * in this list is `py-2` (~44px, a real touch target) and carries the same
   * transition + press scale the Context card's rows use, so the two cards
   * sharing one panel move identically. Pinned because that parity was lost
   * once already — the Context rows gained motion and these did not.
   */
  test('rows and the fold row carry the shared padding and press feedback', () => {
    const html = renderOutputRows(
      Array.from({ length: 9 }, (_, i) => out({ name: `report-${i}.pdf` })),
    );
    // Sliced per button: an assertion over the whole list would be satisfied
    // by either row type alone, and the point is that BOTH carry it.
    const firstRow = html.slice(html.indexOf('<button'), html.indexOf('</button>'));
    expect(firstRow).toContain('py-2');
    expect(firstRow).toContain('transition-[background-color,transform]');
    expect(firstRow).toContain('active:scale-[0.98]');

    // The fold row is the last button rendered. It keeps a `color` transition
    // of its own for the muted → foreground hover on its label.
    const foldRow = html.slice(html.lastIndexOf('<button'));
    expect(foldRow).toContain('1 more file');
    expect(foldRow).toContain('py-2');
    expect(foldRow).toContain('transition-[background-color,color,transform]');
    expect(foldRow).toContain('active:scale-[0.98]');
  });

  // A row's leading mark sits on a tile, not loose in the gutter — the same
  // ground the Context card's file tiles use. A thumbnail fills its own tile,
  // so that one stays bare.
  test('a non-thumbnail row gets a grounded leading tile', () => {
    expect(renderOutputRows([out({ name: 'report.pdf' })])).toContain('bg-muted/70');
  });
});

describe('OutputsCard "download all" header action (W15)', () => {
  test('two-or-more downloadable outputs → the header offers download-all', () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <OutputsCard
          outputs={[
            { callID: 'c1', name: 'a.pdf', kind: 'file', path: 'a.pdf' },
            { callID: 'c2', name: 'b.pdf', kind: 'file', path: 'b.pdf' },
          ]}
          defaultExpanded={false}
          onOpenOutput={() => {}}
        />
      </TooltipProvider>,
    );
    expect(html).toContain('aria-label="Download all"');
  });

  test('a single downloadable output → no header download-all (opening the row covers it)', () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <OutputsCard
          outputs={[{ callID: 'c1', name: 'a.pdf', kind: 'file', path: 'a.pdf' }]}
          defaultExpanded={false}
          onOpenOutput={() => {}}
        />
      </TooltipProvider>,
    );
    expect(html).not.toContain('aria-label="Download all"');
  });

  test('no outputs with a path (e.g. a bare running app) → no header download-all', () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <OutputsCard
          outputs={[{ callID: 'a1', name: 'Dashboard', kind: 'app', url: 'http://localhost:3000' }]}
          defaultExpanded={false}
          onOpenOutput={() => {}}
        />
      </TooltipProvider>,
    );
    expect(html).not.toContain('aria-label="Download all"');
  });
});

describe('OutputRows kind-group headers on the expanded list (Task 9)', () => {
  test('a mixed 12-output fixture shows one labeled header per kind, in first-appearance order', () => {
    const html = renderOutputRows(MIXED_KIND_FIXTURE, true);

    // Each header is a standalone `<p>` — capture its class list and text so
    // order, labels, and per-group padding can all be asserted from the same
    // match instead of guessing at substring positions.
    const headers = [...html.matchAll(/<p class="([^"]*)">([^<]*)<\/p>/g)];
    expect(headers.map((m) => m[2])).toEqual(['Documents', 'Images', 'Videos', 'Presentations']);

    // Every row from all 4 kinds is present — the expanded view is the WHOLE
    // list, not just the pre-fold slice.
    for (const o of MIXED_KIND_FIXTURE) expect(html).toContain(o.name);
  });

  test('group headers carry the specified rhythm; only the first skips the top pad', () => {
    const html = renderOutputRows(MIXED_KIND_FIXTURE, true);
    const headers = [...html.matchAll(/<p class="([^"]*)">([^<]*)<\/p>/g)];
    expect(headers).toHaveLength(4);

    const [firstClass, ...restClasses] = headers.map((m) => m[1]);
    for (const cls of [firstClass, ...restClasses]) {
      expect(cls).toContain('text-xs');
      expect(cls).toContain('font-medium');
      expect(cls).toContain('text-muted-foreground');
      expect(cls).toContain('px-1');
      expect(cls).toContain('pb-1');
    }
    expect(firstClass).not.toContain('pt-2');
    for (const cls of restClasses) expect(cls).toContain('pt-2');
  });

  test('the collapsed pre-fold view of the same fixture stays a flat list — no group headers', () => {
    const html = renderOutputRows(MIXED_KIND_FIXTURE); // initialShowAll defaults to false
    expect(html).not.toMatch(/<p class="[^"]*text-muted-foreground[^"]*">/);
    // Fold semantics are untouched: 8 visible, 4 behind "N more files".
    expect(html).toContain('4 more files');
  });

  test('an expanded list under the threshold (<=10) stays flat, even with mixed kinds', () => {
    const html = renderOutputRows(MIXED_KIND_FIXTURE.slice(0, 10), true);
    expect(html).not.toMatch(/<p class="[^"]*text-muted-foreground[^"]*">/);
    for (const o of MIXED_KIND_FIXTURE.slice(0, 10)) expect(html).toContain(o.name);
  });

  test('an expanded single-kind list never groups, however long', () => {
    const files = Array.from({ length: 15 }, (_, i) => ({
      callID: `f${i}`,
      name: `report-${i}.pdf`,
      kind: 'file' as const,
    }));
    const html = renderOutputRows(files, true);
    expect(html).not.toMatch(/<p class="[^"]*text-muted-foreground[^"]*">/);
  });
});
