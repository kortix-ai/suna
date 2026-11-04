import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { WeeklyCover } from './weekly-cover';

const cover = {
  url: 'https://ke4pydspzeg0nm0o.public.blob.vercel-storage.com/changelog/cover.png',
  alt: 'Reviewed release illustration',
  width: 1200,
  height: 630,
};
describe('WeeklyCover', () => {
  test('hides a failed cover and renders a replacement URL', async () => {
    const win = new Window({ url: 'http://localhost:3000' });
    const globals = ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'];
    const saved = globals.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperties(globalThis, {
      window: { value: win, configurable: true },
      document: { value: win.document, configurable: true },
      IS_REACT_ACT_ENVIRONMENT: { value: true, configurable: true },
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(<WeeklyCover media={{ cover }} />));
      const image = host.querySelector('img');
      if (!image) throw new Error('the initial cover did not render');
      expect(image.getAttribute('alt')).toBe(cover.alt);
      const error = document.createEvent('Event');
      error.initEvent('error', false, false);
      await act(async () => image.dispatchEvent(error));
      expect(host.querySelector('img')).toBeNull();
      expect(host.querySelector('figure')).toBeNull();

      const replacement = { ...cover, url: cover.url.replace('cover.png', 'replacement.png') };
      await act(async () => root.render(<WeeklyCover media={{ cover: replacement }} />));
      expect(host.querySelector('figure')).not.toBeNull();
      const replacementImage = host.querySelector('img');
      if (!replacementImage) throw new Error('the replacement cover did not render');
      expect(replacementImage.getAttribute('src')).toContain(encodeURIComponent(replacement.url));
      expect(replacementImage.getAttribute('alt')).toBe(replacement.alt);
    } finally {
      await act(async () => root.unmount());
      host.remove();
      await win.happyDOM.close();
      globals.forEach((key, index) => {
        const descriptor = saved[index];
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      });
    }
  });

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
