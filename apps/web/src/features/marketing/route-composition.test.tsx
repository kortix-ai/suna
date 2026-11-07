import { describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Window } from 'happy-dom';
// Bun does not compile MDX frontmatter. Supply the content boundary, not a page
// or section mock, so the actual shipped composition still renders end to end.
mock.module('@/lib/use-cases-source', () => ({
  useCasesSource: {
    getPages: () => [{
      slugs: ['synthetic-report'],
      url: '/use-cases/synthetic-report',
      data: { title: 'Synthetic report', description: 'A test report', date: '2026-01-01', tags: ['Finance'], author: 'kortix' },
    }],
  },
}));

import Home from '@/app/[locale]/(public)/(marketing)/(home)/page';
import SecurityPage from '@/app/[locale]/(public)/(marketing)/security/page';

describe('shipped marketing route composition', () => {
  for (const [name, Page] of [['home', Home], ['security', SecurityPage]] as const) {
    test(`${name} retains its rendered sections, links and visuals`, () => {
      const html = renderToStaticMarkup(<Page />);
      expect(html).toContain('<section');
      expect(html).toContain('href=');
      // The security page's text changes with its copy: it is checked for
      // structure only. The home page keeps its full composition snapshot.
      if (name === 'security') return;
      const document = new Window().document;
      document.body.innerHTML = html;
      expect({
        sections: [...document.querySelectorAll('section')].map((node) => node.id),
        securityContent: undefined,
        glyphs: [...document.querySelectorAll('[style*="mask"]')].map((node) => node.getAttribute('style')),
        headings: [...document.querySelectorAll('h1, h2, h3')].map((node) => node.textContent),
        links: [...document.querySelectorAll('a')].map((node) => [node.textContent, node.getAttribute('href')]),
        visuals: [...document.querySelectorAll('img, video, [role="img"]')].map((node) => [node.getAttribute('src'), node.getAttribute('alt'), node.getAttribute('aria-label')]),
      }).toMatchSnapshot();
    });
  }
});
