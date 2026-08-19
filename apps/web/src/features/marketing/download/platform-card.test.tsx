import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { MOBILE_CARD, MOBILE_ROWS, MOBILE_STATUS } from './content';
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
  status: MOBILE_STATUS,
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

describe('the mobile card while both apps are unreleased', () => {
  test('offers nobody a way to try the app', () => {
    // iOS is on TestFlight and Android on a Play internal track. Both listings
    // exist and neither is publicly installable, so a link is a dead end.
    expect(mobileCard).not.toContain('apps.apple.com');
    expect(mobileCard).not.toContain('play.google.com');
    expect(mobileCard).not.toContain('<a ');
    expect(mobileCard).not.toContain('Download');
  });

  test('says so on every row, not once at the top', () => {
    // A single header chip is missable next to two named platforms; a visitor
    // scanning for "Android" has to land on the answer where they are looking.
    expect(mobileCard.match(new RegExp(MOBILE_STATUS, 'g'))).toHaveLength(mobileRows.length);
    expect(mobileRows).toHaveLength(2);
  });

  test('still names both platforms, so the plan is legible', () => {
    expect(mobileCard).toContain('iPhone and iPad');
    expect(mobileCard).toContain('Android');
  });

  test('keeps the row height the desktop card sets, so the seams line up', () => {
    // Both cards sit in one grid row and `mt-auto` bottom-aligns their lists. A
    // bare Badge is h-5 against the magic-sm button's h-9/sm:h-8 opposite it,
    // which would drag every seam in this card out of alignment.
    expect(mobileCard).toContain('h-9');
    expect(mobileCard).toContain('sm:h-8');
  });
});

describe('a row that does have a build', () => {
  const linked = renderToStaticMarkup(
    <PlatformCard
      image={null}
      title="Desktop app"
      description="…"
      rows={[{ id: 'macos', label: 'macOS', meta: 'Universal · 195 MB', href: '/download/macos', Mark }]}
      filled="macos"
    />,
  );

  test('still renders the Download link', () => {
    expect(linked).toContain('href="/download/macos"');
    expect(linked).toContain('Download');
    expect(linked).toContain('aria-label="Download Kortix for macOS"');
  });

  test('does not pick up a status chip', () => {
    expect(linked).not.toContain(MOBILE_STATUS);
  });
});
