import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { UseCaseMdxImage } from './use-case-mdx-image';

describe('UseCaseMdxImage', () => {
  it('renders no element without a source', () => {
    expect(renderToStaticMarkup(<UseCaseMdxImage />)).toBe('');
  });

  it('uses an empty alt value for decorative images', () => {
    const markup = renderToStaticMarkup(<UseCaseMdxImage src="/diagram.png" />);

    expect(markup).toContain('alt=""');
    expect(markup).toContain('loading="lazy"');
  });

  it('preserves a meaningful alt value', () => {
    const markup = renderToStaticMarkup(
      <UseCaseMdxImage src="/diagram.png" alt="Agent workflow diagram" />,
    );

    expect(markup).toContain('alt="Agent workflow diagram"');
  });
});
