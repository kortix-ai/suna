import { expect, test } from 'bun:test';

import { readFileSync } from 'node:fs';

import { join } from 'node:path';

/**
 * Terms-of-Service links must point at the stable `/legal/terms` path, which
 * the middleware permanently 308-redirects to the Terms tab (`/legal?tab=terms`).
 * The tab query form must not appear in any source link: new links use the
 * stable path. Privacy and imprint link straight to `/legal?tab=…`.
 *
 * This is a static source scan (not a DOM test) so it catches every link site
 * at once — footer, user menu, auth footer, support page, site config —
 * without having to mount each component.
 */

const WEB_ROOT = join(import.meta.dir, '..');

type LinkSite = {
  /** Repo-relative path under apps/web/src. */
  file: string;
  /** Substrings that must each appear at least once. */
  expectPresent: string[];
  /** Substrings that must NOT appear anywhere in the file. */
  expectAbsent: string[];
};

const LINK_SITES: LinkSite[] = [
  {
    file: 'components/home/footer.tsx',
    expectPresent: [`href: '/legal/terms'`, `href: '/legal?tab=privacy'`],
    expectAbsent: [`href: '/legal?tab=terms'`],
  },
  {
    file: 'features/layout/user-menu-shared.tsx',
    expectPresent: [`href: '/legal/terms'`, `href: '/legal?tab=privacy'`],
    expectAbsent: [`href: '/legal?tab=terms'`],
  },
  {
    file: 'features/auth/auth-card-shell.tsx',
    expectPresent: [`href="/legal/terms"`, `href="/legal?tab=privacy"`],
    expectAbsent: [`href="/legal?tab=terms"`],
  },
  {
    file: 'app/[locale]/(public)/(marketing)/support/page.tsx',
    expectPresent: [
      `href="/legal/terms"`,
      `href="/legal?tab=privacy"`,
      `href="/legal?tab=imprint"`,
    ],
    expectAbsent: [`href="/legal?tab=terms"`],
  },
  {
    file: 'lib/site-config.ts',
    expectPresent: [`url: '/legal/terms'`, `url: '/legal?tab=privacy'`],
    expectAbsent: [`url: '/legal?tab=terms'`],
  },
];

for (const site of LINK_SITES) {
  test(`${site.file}: Terms -> /legal/terms, privacy/imprint local`, () => {
    const abs = join(WEB_ROOT, site.file);
    const src = readFileSync(abs, 'utf8');

    for (const needle of site.expectPresent) {
      expect(src.includes(needle), `expected to find ${needle} in ${site.file}`).toBe(true);
    }
    for (const forbidden of site.expectAbsent) {
      expect(
        src.includes(forbidden),
        `legacy Terms link still present in ${site.file}: ${forbidden}`,
      ).toBe(false);
    }
  });
}

test('the legal page renders the Terms as a tab, with no link out', () => {
  const src = readFileSync(join(WEB_ROOT, 'app/[locale]/(public)/(seo)/legal/page.tsx'), 'utf8');

  // The tab union is the contract: it names every tab the page can render.
  expect(
    src.includes(`type LegalTab = 'imprint' | 'terms' | 'privacy';`),
    'legal tab union changed',
  ).toBe(true);
  expect(src.includes(`{ id: 'imprint'`), 'imprint tab missing from the rail').toBe(true);
  expect(src.includes(`{ id: 'terms'`), 'terms tab missing from the rail').toBe(true);
  expect(src.includes(`{ id: 'privacy'`), 'privacy tab missing from the rail').toBe(true);
  expect(src.includes('<TermsOfService />'), 'terms document not rendered').toBe(true);
  // The Terms no longer live in an external Drive file: no link out of the rail.
  expect(src.includes(`href="/legal/terms"`), 'legal page still links Terms out').toBe(false);
  expect(src, 'legal page still names the Drive file').not.toContain('drive.google.com');
});
