import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MobileCardImage } from './card-images';

test('download previews use the current store artwork, not the retired app posters', () => {
  const html = renderToStaticMarkup(<MobileCardImage />);
  for (const shot of ['01', '02', '03']) {
    expect(html).toContain(encodeURIComponent(`/images/mobile-app/store-${shot}.webp`));
  }
  expect(html).not.toContain('app-1.png');
});
