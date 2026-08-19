import { expect, test } from 'bun:test';

import { readFileSync } from 'node:fs';

import { join } from 'node:path';

/**
 * Terms-of-Service links must point at the stable `/legal/terms` path, which
 * the middleware permanently 308-redirects to the public Drive file. The
 * legacy `/legal?tab=terms` query form must not appear in any source link — it
 * only still works because the middleware redirects it, but new links should
 * use the stable path. Privacy and imprint stay local on `/legal?tab=…`.
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
    file: 'app/(public)/(marketing)/support/page.tsx',
    expectPresent: [`href="/legal/terms"`, `href="/legal?tab=privacy"`, `href="/legal?tab=imprint"`],
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
      expect(src.includes(forbidden), `legacy Terms link still present in ${site.file}: ${forbidden}`).toBe(false);
    }
  });
}

test('the legal page no longer renders a terms tab', () => {
  const src = readFileSync(join(WEB_ROOT, 'app/(public)/(seo)/legal/page.tsx'), 'utf8');
  expect(src.includes(`activeTab === 'terms'`), 'terms branch still in legal page').toBe(false);
  expect(src.includes(`handleTabChange('terms')`), 'terms tab button still in legal page').toBe(false);
  // privacy + imprint remain.
  expect(src.includes(`handleTabChange('privacy')`)).toBe(true);
  expect(src.includes(`handleTabChange('imprint')`)).toBe(true);
});
