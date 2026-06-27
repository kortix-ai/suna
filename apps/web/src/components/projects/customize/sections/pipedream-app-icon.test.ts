import { describe, expect, test } from 'bun:test';
import { appSearchQueryFromSlug, pickAppIconBySlug } from './pipedream-app-icon';

describe('appSearchQueryFromSlug', () => {
  test('de-slugifies multi-word slugs so the name search matches', () => {
    expect(appSearchQueryFromSlug('google_sheets')).toBe('google sheets');
    expect(appSearchQueryFromSlug('microsoft_outlook')).toBe('microsoft outlook');
  });

  test('leaves single-word slugs untouched', () => {
    expect(appSearchQueryFromSlug('notion')).toBe('notion');
    expect(appSearchQueryFromSlug('github')).toBe('github');
  });
});

describe('pickAppIconBySlug', () => {
  const apps = [
    { slug: 'google_sheets', imgSrc: 'https://cdn/google_sheets.png' },
    { slug: 'google_drive', imgSrc: 'https://cdn/google_drive.png' },
    { slug: 'no_logo', imgSrc: null },
  ];

  test('returns the exact slug match logo, not a fuzzy neighbour', () => {
    expect(pickAppIconBySlug(apps, 'google_sheets')).toBe('https://cdn/google_sheets.png');
  });

  test('returns null when the slug is absent', () => {
    expect(pickAppIconBySlug(apps, 'slack')).toBeNull();
  });

  test('returns null when the matched app has no logo', () => {
    expect(pickAppIconBySlug(apps, 'no_logo')).toBeNull();
  });

  test('returns null for an undefined page (still loading)', () => {
    expect(pickAppIconBySlug(undefined, 'google_sheets')).toBeNull();
  });
});
