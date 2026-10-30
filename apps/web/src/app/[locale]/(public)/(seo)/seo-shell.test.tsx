import { expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { renderToStaticMarkup } from 'react-dom/server';

// Keep the shell real; its navbar and footer have their own provider contracts.
mock.module('@/components/home/navbar', () => ({
  Navbar: () => <nav aria-label="Site navigation" />,
}));
mock.module('@/components/home/footer', () => ({ default: () => <footer /> }));

const { SeoShell } = await import('./seo-shell');

test('the fixed navbar owns the titlebar, not the page content', () => {
  const window = new Window();
  try {
    window.document.body.innerHTML = renderToStaticMarkup(
      <SeoShell><main>SEO content</main></SeoShell>,
    );
    const navbarWrapper = window.document.querySelector('nav')?.parentElement;
    expect(navbarWrapper?.classList.contains('fixed')).toBe(true);
    expect(navbarWrapper?.getAttribute('data-kx-titlebar-owner')).toBe('');
    expect(window.document.querySelectorAll('[data-kx-titlebar-owner]').length).toBe(1);
    expect(window.document.querySelector('main')?.textContent).toBe('SEO content');
    expect(window.document.querySelector('main')?.hasAttribute('data-kx-titlebar-owner')).toBe(false);
  } finally {
    window.happyDOM.abort();
  }
});
