import { describe, expect, test } from 'bun:test';

import { SLUG_RE } from '../constants';
import { slugifySlug } from '../slug';

describe('slugifySlug', () => {
  test('lowercases and slugifies a display name', () => {
    expect(slugifySlug('Release Notes', 'skill')).toBe('release-notes');
  });

  test('collapses separator runs and trims edge separators', () => {
    expect(slugifySlug('  Weekly -- Digest!!  ', 'skill')).toBe('weekly-digest');
  });

  test('keeps digits, dots and underscores that SLUG_RE allows', () => {
    expect(slugifySlug('Deploy_v2.0', 'skill')).toBe('deploy_v2.0');
  });

  test('drops characters SLUG_RE forbids', () => {
    expect(slugifySlug('a/b c:d', 'skill')).toBe('a-b-c-d');
  });

  test('caps at 128 characters so the result matches SLUG_RE', () => {
    const slug = slugifySlug('x'.repeat(300), 'skill');
    expect(slug.length).toBeLessThanOrEqual(128);
    expect(SLUG_RE.test(slug)).toBe(true);
  });

  test('falls back when nothing usable remains', () => {
    expect(slugifySlug('   ', 'skill')).toBe('skill');
    expect(slugifySlug('///', 'skill')).toBe('skill');
  });
});
