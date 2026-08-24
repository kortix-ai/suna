import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { ProviderLogo } from './provider-branding';

const render = (props: React.ComponentProps<typeof ProviderLogo>) =>
  renderToStaticMarkup(<ProviderLogo {...props} />);

/**
 * `xs` exists for one job: a provider mark sitting INLINE on a line of 13px
 * text — the command palette's model group headings. Those shipped `small`,
 * a 32px `bg-muted` tile, which is 2.5× the heading's cap height and read as a
 * row of its own instead of a label on the rows below it.
 */
describe('ProviderLogo xs', () => {
  test('is a 16px bare mark — no avatar tile', () => {
    const html = render({ providerID: 'anthropic', size: 'xs' });
    expect(html).toContain('size-4');
    expect(html).toContain('bg-transparent');
    expect(html).not.toContain('bg-muted');
  });

  test('the tiled sizes keep their tile', () => {
    for (const size of ['small', 'default', 'large'] as const) {
      const html = render({ providerID: 'anthropic', size });
      expect(html).toContain('bg-muted');
      expect(html).not.toContain('size-4"');
    }
  });

  test('the initials fallback keeps its tile even at xs', () => {
    // Two bare letters at 9px read as debris, not as a logo.
    const html = render({ providerID: 'some-brand-new-provider', name: 'Brand New', size: 'xs' });
    expect(html).toContain('bg-muted');
    expect(html).toContain('BN');
  });
});
