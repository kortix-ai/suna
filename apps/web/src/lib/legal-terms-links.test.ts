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
  /** A path under apps/web/src, or `packages/ui/src/…` for a @kortix/ui file. */
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
    file: 'packages/ui/src/internal/auth/auth-card-shell.tsx',
    expectPresent: [`href="/legal/terms"`, `href="/legal?tab=privacy"`],
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
    const abs = site.file.startsWith('packages/')
      ? join(WEB_ROOT, '../../..', site.file)
      : join(WEB_ROOT, site.file);
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
