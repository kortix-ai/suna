import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { MOBILE_CARD, MOBILE_ROWS } from './content';
import { orderedMobile } from './detect-os';
import { type CardRow, PlatformCard } from './platform-card';

const Mark = () => <svg />;

/**
 * The mobile rows exactly as `/download` builds them, so this file fails when
 * the page changes, not only when the card does.
 */
const mobileRows: CardRow[] = orderedMobile('macos').map((os) => ({
  id: os,
  label: MOBILE_ROWS[os].label,
  meta: MOBILE_ROWS[os].hint,
  href: MOBILE_ROWS[os].href,
  external: true,
  Mark,
}));

const mobileCard = renderToStaticMarkup(
  <PlatformCard
    image={null}
    title={MOBILE_CARD.title}
    description={MOBILE_CARD.description}
    rows={mobileRows}
    filled={null}
  />,
);

describe('the mobile card', () => {
  test('links each canonical store listing in a new tab', () => {
    // No storefront country and no `hl=`: each store picks the visitor's region.
    expect(mobileCard).toContain('href="https://apps.apple.com/app/kortix/id6754448524"');
    expect(mobileCard).toContain(
      'href="https://play.google.com/store/apps/details?id=com.kortix.application"',
    );
    expect(mobileCard).not.toContain('/cg/');
    expect(mobileCard).not.toContain('hl=');
    expect(mobileCard.match(/target="_blank" rel="noopener noreferrer"/g)).toHaveLength(2);
  });

  test('labels the store buttons Open, with the store in the accessible name', () => {
    expect(mobileCard).toContain('aria-label="Open App Store"');
    expect(mobileCard).toContain('aria-label="Open Google Play"');
    expect(mobileCard).not.toContain('Coming soon');
  });

  test('fills the visitor\'s own store', () => {
    const onAndroid = renderToStaticMarkup(
      <PlatformCard image={null} title="" description="" rows={mobileRows} filled="android" />,
    );
    expect(onAndroid.match(/ bg-foreground /g)).toHaveLength(1);
    expect(mobileCard).not.toContain(' bg-foreground ');
  });
});

describe('a row that does have a build', () => {
  const linked = renderToStaticMarkup(
    <PlatformCard
      image={null}
      title="Desktop app"
      description="…"
      rows={[
        { id: 'macos', label: 'macOS', meta: 'Universal · 195 MB', href: '/download/macos', Mark },
      ]}
      filled="macos"
    />,
  );

  test('still renders the Download link', () => {
    expect(linked).toContain('href="/download/macos"');
    expect(linked).toContain('Download');
    expect(linked).toContain('aria-label="Download Kortix for macOS"');
  });

  test('stays a same-tab Download, not a store Open', () => {
    expect(linked).not.toContain('target="_blank"');
    expect(linked).not.toContain('aria-label="Open');
  });
});

describe('download metadata at narrow viewports', () => {
  test('shows the complete Linux size without clipping the download action', async () => {
    const { default: postcss } = await import('postcss');
    const { default: tailwindcss } = await import('@tailwindcss/postcss');
    const { chromium } = await import('playwright');
    const cssPath = `${import.meta.dir}/../../../app/globals.css`;
    const css = await postcss([tailwindcss()]).process(await Bun.file(cssPath).text(), {
      from: cssPath,
    });
    const markup = renderToStaticMarkup(
      <main className="mx-auto w-full max-w-5xl px-6">
        <PlatformCard
          image={null}
          title="Desktop app"
          description="Download the desktop app."
          rows={[
            {
              id: 'linux',
              label: 'Linux',
              meta: 'AppImage · x86_64 · 119 MB',
              href: '/download/linux',
              Mark,
            },
          ]}
          filled="linux"
        />
      </main>,
    );
    const browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH,
      args: ['--no-sandbox'],
    });
    try {
      const page = await browser.newPage();
      await page.setContent(`<style>${css.css}</style>${markup}`);
      for (const width of [320, 390, 720, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        for (const dark of [false, true]) {
          await page.evaluate(
            (value) => document.documentElement.classList.toggle('dark', value),
            dark,
          );
          const meta = page.getByText('AppImage · x86_64 · 119 MB', { exact: true });
          const bounds = await meta.evaluate((element) => {
            const range = document.createRange();
            range.selectNodeContents(element);
            const box = element.getBoundingClientRect();
            return {
              clipped: element.scrollWidth > element.clientWidth,
              textVisible: Array.from(range.getClientRects()).every(
                (rect) =>
                  rect.left >= box.left &&
                  rect.right <= box.right + 1 &&
                  rect.bottom <= box.bottom + 1,
              ),
            };
          });
          expect(bounds.clipped).toBe(false);
          expect(bounds.textVisible).toBe(true);
          expect(
            await page
              .getByRole('link', { name: 'Download Kortix for Linux' })
              .getAttribute('href'),
          ).toBe('/download/linux');
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
          ).toBe(true);
        }
      }
    } finally {
      await browser.close();
    }
  }, 60_000);
});
