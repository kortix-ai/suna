import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { DetailLayer } from './detail-view';

describe('DetailLayer a11y (W6)', () => {
  test('desktop detail is a labeled dialog', () => {
    const html = renderToStaticMarkup(
      <DetailLayer
        detail={{ key: 'k', title: 'Quarterly report', body: <div /> }}
        onBack={() => {}}
        isMobile={false}
      >
        <div>home</div>
      </DetailLayer>,
    );
    expect(html).toContain('role="dialog"');
    expect(html).not.toContain('aria-modal');
    expect(html).toContain('aria-label="Quarterly report"');
    expect(html).toContain('tabindex="-1"');
  });
});
