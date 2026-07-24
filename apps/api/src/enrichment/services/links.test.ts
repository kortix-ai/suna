import { describe, expect, test } from 'bun:test';
import { harvestLinks, mergeLinkHarvest, MAX_OTHER_EXTERNAL, type LinkHarvest } from './links';

const PAGE_URL = 'https://example.com/';

function html(body: string): string {
  return `<!doctype html><html><body>${body}</body></html>`;
}

function anchor(href: string): string {
  return `<a href="${href}">link</a>`;
}

function empty(): LinkHarvest {
  return { socials: [], emails: [], phones: [], otherExternal: [] };
}

describe('harvestLinks — platform classification', () => {
  const rows: Array<[string, string]> = [
    ['https://x.com/acme', 'x'],
    ['https://twitter.com/acme', 'x'],
    ['https://github.com/acme', 'github'],
    ['https://linkedin.com/company/acme', 'linkedin'],
    ['https://peerlist.io/acme', 'peerlist'],
    ['https://youtube.com/@acme', 'youtube'],
    ['https://instagram.com/acme', 'instagram'],
    ['https://dribbble.com/acme', 'dribbble'],
    ['https://behance.net/acme', 'behance'],
    ['https://bsky.app/profile/acme', 'bluesky'],
    ['https://mastodon.social/@acme', 'mastodon'],
    ['https://npmjs.com/package/acme', 'npm'],
    ['https://crunchbase.com/organization/acme', 'crunchbase'],
    ['https://producthunt.com/@acme', 'producthunt'],
    ['https://discord.gg/acme', 'discord'],
    ['https://discord.com/invite/acme', 'discord'],
    ['https://t.me/acme', 'telegram'],
    ['https://medium.com/@acme', 'medium'],
    ['https://substack.com/@acme', 'substack'],
    ['https://stackoverflow.com/users/1/acme', 'stackoverflow'],
    ['https://gitlab.com/acme', 'gitlab'],
  ];

  for (const [href, platform] of rows) {
    test(`classifies ${href} as ${platform}`, () => {
      const result = harvestLinks(html(anchor(href)), PAGE_URL);
      expect(result.socials).toEqual([{ platform, url: href }]);
    });
  }

  test('matches a social host reached through a subdomain', () => {
    const result = harvestLinks(html(anchor('https://gist.github.com/acme')), PAGE_URL);
    expect(result.socials).toEqual([{ platform: 'github', url: 'https://gist.github.com/acme' }]);
  });

  test('www is treated the same as the bare host', () => {
    const result = harvestLinks(html(anchor('https://www.github.com/acme')), PAGE_URL);
    expect(result.socials).toEqual([{ platform: 'github', url: 'https://www.github.com/acme' }]);
  });
});

describe('harvestLinks — mailto and tel', () => {
  test('extracts an email from a mailto link', () => {
    const result = harvestLinks(html(anchor('mailto:hello@example.org')), PAGE_URL);
    expect(result.emails).toEqual(['hello@example.org']);
    expect(result.socials).toEqual([]);
  });

  test('extracts an email and drops a mailto subject query', () => {
    const result = harvestLinks(
      html(anchor('mailto:hello@example.org?subject=Hi%20there')),
      PAGE_URL,
    );
    expect(result.emails).toEqual(['hello@example.org']);
  });

  test('extracts a phone number from a tel link', () => {
    const result = harvestLinks(html(anchor('tel:+1-555-123-4567')), PAGE_URL);
    expect(result.phones).toEqual(['+1-555-123-4567']);
  });
});

describe('harvestLinks — dedupe within a page', () => {
  test('dedupes the same email linked twice', () => {
    const result = harvestLinks(
      html(anchor('mailto:hello@example.org') + anchor('mailto:hello@example.org')),
      PAGE_URL,
    );
    expect(result.emails).toEqual(['hello@example.org']);
  });

  test('keeps only the first url for a platform seen twice on one page', () => {
    const result = harvestLinks(
      html(anchor('https://github.com/acme') + anchor('https://github.com/other-acme')),
      PAGE_URL,
    );
    expect(result.socials).toEqual([{ platform: 'github', url: 'https://github.com/acme' }]);
  });

  test('dedupes a repeated other-external link', () => {
    const result = harvestLinks(
      html(anchor('https://partner.example.org/') + anchor('https://partner.example.org/')),
      PAGE_URL,
    );
    expect(result.otherExternal).toEqual(['https://partner.example.org/']);
  });
});

describe('harvestLinks — tracking params and normalization', () => {
  test('strips utm and click-id params from a social link', () => {
    const result = harvestLinks(
      html(anchor('https://github.com/acme?utm_source=newsletter&utm_medium=email')),
      PAGE_URL,
    );
    expect(result.socials).toEqual([{ platform: 'github', url: 'https://github.com/acme' }]);
  });

  test('strips tracking params from an other-external link', () => {
    const result = harvestLinks(
      html(anchor('https://partner.example.org/?fbclid=abc123')),
      PAGE_URL,
    );
    expect(result.otherExternal).toEqual(['https://partner.example.org/']);
  });
});

describe('harvestLinks — exclusions', () => {
  test('drops an asset link on a social host', () => {
    const result = harvestLinks(html(anchor('https://github.com/acme/avatar.png')), PAGE_URL);
    expect(result.socials).toEqual([]);
  });

  test('drops an obvious asset link from other-external', () => {
    const result = harvestLinks(html(anchor('https://cdn.example.org/logo.png')), PAGE_URL);
    expect(result.otherExternal).toEqual([]);
  });

  test('ignores same-origin links entirely', () => {
    const result = harvestLinks(html(anchor('/about') + anchor('https://example.com/pricing')), PAGE_URL);
    expect(result).toEqual(empty());
  });

  test('ignores javascript and empty hrefs without throwing', () => {
    const result = harvestLinks(
      html('<a href="javascript:void(0)">x</a><a href="">y</a><a>z</a>'),
      PAGE_URL,
    );
    expect(result).toEqual(empty());
  });

  test('does not throw on malformed html', () => {
    expect(() => harvestLinks('<a href="https://github.com/acme"', PAGE_URL)).not.toThrow();
  });
});

describe('harvestLinks — empty page', () => {
  test('a page with no outbound links returns empty arrays', () => {
    const result = harvestLinks(html('<p>no links here</p>'), PAGE_URL);
    expect(result).toEqual(empty());
  });
});

describe('harvestLinks — other-external cap', () => {
  test('caps other-external links at the limit', () => {
    const links = Array.from({ length: MAX_OTHER_EXTERNAL + 20 }, (_, i) =>
      anchor(`https://partner-${i}.example.org/`),
    ).join('');
    const result = harvestLinks(html(links), PAGE_URL);
    expect(result.otherExternal).toHaveLength(MAX_OTHER_EXTERNAL);
  });
});

describe('mergeLinkHarvest', () => {
  test('dedupes the same profile linked from several pages', () => {
    const pageOne = harvestLinks(html(anchor('https://github.com/acme')), 'https://example.com/');
    const pageTwo = harvestLinks(
      html(anchor('https://github.com/acme')),
      'https://example.com/about',
    );

    const merged = empty();
    mergeLinkHarvest(merged, pageOne);
    mergeLinkHarvest(merged, pageTwo);

    expect(merged.socials).toEqual([{ platform: 'github', url: 'https://github.com/acme' }]);
  });

  test('the first page to link a platform wins over a later, different profile', () => {
    const pageOne = harvestLinks(html(anchor('https://github.com/acme')), 'https://example.com/');
    const pageTwo = harvestLinks(
      html(anchor('https://github.com/someone-else')),
      'https://example.com/team',
    );

    const merged = empty();
    mergeLinkHarvest(merged, pageOne);
    mergeLinkHarvest(merged, pageTwo);

    expect(merged.socials).toEqual([{ platform: 'github', url: 'https://github.com/acme' }]);
  });

  test('unions emails, phones and other-external links across pages', () => {
    const pageOne = harvestLinks(
      html(anchor('mailto:a@example.org') + anchor('https://partner-a.example.org/')),
      'https://example.com/',
    );
    const pageTwo = harvestLinks(
      html(anchor('mailto:b@example.org') + anchor('https://partner-b.example.org/')),
      'https://example.com/contact',
    );

    const merged = empty();
    mergeLinkHarvest(merged, pageOne);
    mergeLinkHarvest(merged, pageTwo);

    expect(merged.emails).toEqual(['a@example.org', 'b@example.org']);
    expect(merged.otherExternal).toEqual([
      'https://partner-a.example.org/',
      'https://partner-b.example.org/',
    ]);
  });

  test('never grows other-external past the cap across merges', () => {
    const pageOne = harvestLinks(
      html(
        Array.from({ length: MAX_OTHER_EXTERNAL }, (_, i) => anchor(`https://a-${i}.example.org/`)).join(''),
      ),
      'https://example.com/',
    );
    const pageTwo = harvestLinks(
      html(anchor('https://extra.example.org/')),
      'https://example.com/about',
    );

    const merged = empty();
    mergeLinkHarvest(merged, pageOne);
    mergeLinkHarvest(merged, pageTwo);

    expect(merged.otherExternal).toHaveLength(MAX_OTHER_EXTERNAL);
  });
});
