import { describe, expect, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';

import { DocsSidebarFooter } from './docs-controls';

/**
 * The sidebar's bottom row.
 *
 * It replaced fumadocs' `links` + `themeSwitch` slots, which render into a
 * container whose classes are hardcoded in the package —
 * `border bg-fd-secondary/50 … rounded-lg` — with no prop to turn any of it
 * off. This row owns its own markup, so the border and the tint are gone by
 * construction rather than by an override.
 *
 * `ThemeToggle` renders null until it mounts (it reads next-themes' client-only
 * `theme` to mark the active segment), so a static render shows the link only.
 * That is the half this file can assert; the toggle's own presentation is
 * pinned by its `variant="minimal"` branch.
 */
const render = () =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={{}} onError={() => {}}>
      <DocsSidebarFooter />
    </NextIntlClientProvider>,
  );

describe('DocsSidebarFooter', () => {
  test('links out to the repo, in a new tab, with a label', () => {
    const markup = render();

    expect(markup).toContain('href="https://github.com/kortix-ai/suna"');
    expect(markup).toContain('target="_blank"');
    // The mark is a decoration; the accessible name is on the anchor.
    expect(markup).toContain('aria-label="Kortix on GitHub"');
  });

  test("the mark is the app's own GitHub icon, not a phosphor glyph", () => {
    // `features/icon/icons/github.tsx` — the same one `docs-page-actions.tsx`
    // uses, so one GitHub glyph appears across the docs. Phosphor marks carry
    // a 256-unit viewBox; this one is 24.
    const markup = render();

    expect(markup).toContain('<title>Github</title>');
    expect(markup).toContain('viewBox="0 0 24 24"');
    expect(markup).not.toContain('viewBox="0 0 256 256"');
  });

  test('the row draws no border and no tint — that was the whole complaint', () => {
    const markup = render();

    expect(markup).not.toContain('border');
    expect(markup).not.toContain('bg-fd-secondary');
    expect(markup).not.toContain('rounded-lg');
  });
});
