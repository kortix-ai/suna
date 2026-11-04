import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { WeeklyCover } from './weekly-cover';

const cover = {
  url: 'https://ke4pydspzeg0nm0o.public.blob.vercel-storage.com/changelog/cover.png',
  alt: 'Reviewed release illustration',
  width: 1200,
  height: 630,
};
describe('WeeklyCover', () => {
  test('renders accessible responsive media with intrinsic dimensions', () => {
    const html = renderToStaticMarkup(<WeeklyCover media={{ cover }} />);
    expect(html).toContain('alt="Reviewed release illustration"');
    expect(html).toContain('width="1200"');
    expect(html).toContain('height="630"');
    expect(html).toContain('sizes="(min-width: 1024px) 50vw, 100vw"');
    expect(html).not.toContain('<figcaption');
  });
  test('links an optional demo without embedding an invented product surface', () => {
    const html = renderToStaticMarkup(
      <WeeklyCover media={{ cover, demoUrl: 'https://www.youtube.com/watch?v=demo' }} />,
    );
    expect(html).toContain('href="https://www.youtube.com/watch?v=demo"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).not.toContain('<iframe');
  });
});
