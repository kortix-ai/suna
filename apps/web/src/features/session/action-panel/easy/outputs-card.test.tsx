import { TooltipProvider } from '@/components/ui/tooltip';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { OutputRows } from './outputs-card';

describe('OutputRows display (W3/W11)', () => {
  test('title wins over filename; kind label rides right; fresh mark shows', () => {
    const html = renderToStaticMarkup(
      // The row's hover DownloadButton (Task 14) renders a `Hint`, which needs
      // a `TooltipProvider` ancestor — the app root supplies one in `layout.tsx`;
      // a static render needs its own.
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

  test('row download affordance: DownloadButton renders only when the output has a path', () => {
    const withPath = renderToStaticMarkup(
      <TooltipProvider>
        <OutputRows
          outputs={[{ callID: 'c1', name: 'a.pdf', kind: 'file', path: 'a.pdf' }]}
          onOpenOutput={() => {}}
        />
      </TooltipProvider>,
    );
    expect(withPath).toContain('Download');

    const withoutPath = renderToStaticMarkup(
      <TooltipProvider>
        <OutputRows
          outputs={[{ callID: 'c2', name: 'Generated image', kind: 'image' }]}
          onOpenOutput={() => {}}
        />
      </TooltipProvider>,
    );
    expect(withoutPath).not.toContain('Download');
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
