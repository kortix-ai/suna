import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { OutputRows } from './outputs-card';

describe('OutputRows display (W3/W11)', () => {
  test('title wins over filename; kind label rides right; fresh mark shows', () => {
    const html = renderToStaticMarkup(
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
      />,
    );
    expect(html).toContain('Quarterly report');
    expect(html).not.toContain('quarterly_report_v2.pdf'); // filename lives in the detail toolbar
    expect(html).toContain('PDF');
    expect(html).toContain('Updated');
  });
});
