import { TooltipProvider } from '@/components/ui/tooltip';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { OutputItem } from '../shared/derive-panels';
import { OutputRows, OutputsCard } from './outputs-card';

/** A minimal file output — defaults to a plausible scaffolding-free file so
 * callers only need to override what the test cares about. */
function out(overrides: Partial<OutputItem> & Pick<OutputItem, 'name'>): OutputItem {
  return { callID: `c-${overrides.name}`, kind: 'file', path: overrides.name, ...overrides } as OutputItem;
}

function renderOutputRows(outputs: OutputItem[]): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <OutputRows outputs={outputs} onOpenOutput={() => {}} />
    </TooltipProvider>,
  );
}

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
