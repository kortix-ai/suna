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
