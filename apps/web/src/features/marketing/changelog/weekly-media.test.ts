import { describe, expect, test } from 'bun:test';
import { parseWeeklyMedia } from './weekly-media';

const cover = {
  url: 'https://ke4pydspzeg0nm0o.public.blob.vercel-storage.com/changelog/cover.png',
  alt: 'A reviewed changelog cover',
  width: 1200,
  height: 630,
};
describe('reviewed weekly media', () => {
  test('keeps approved durable media and its dimensions', () => {
    expect(parseWeeklyMedia({ reviewed: true, cover })).toEqual({ cover });
  });
  test('omits drafts and malformed covers', () => {
    for (const media of [
      null,
      {},
      { cover },
      { reviewed: false, cover },
      { reviewed: true, cover: { ...cover, alt: ' ' } },
      { reviewed: true, cover: { ...cover, width: 0 } },
      { reviewed: true, cover: { ...cover, height: Infinity } },
    ])
      expect(parseWeeklyMedia(media)).toBeUndefined();
  });
  test('rejects unsafe, private, temporary and unapproved image URLs', () => {
    for (const url of [
      'javascript:alert(1)',
      'http://localhost/cover.png',
      '/cover.png',
      'https://example.com/cover.png',
      cover.url + '?token=secret',
      cover.url.replace('https://', 'https://user:pass@'),
      cover.url.replace('.png', '.svg'),
    ])
      expect(parseWeeklyMedia({ reviewed: true, cover: { ...cover, url } })).toBeUndefined();
  });
  test('only links reviewed public demos', () => {
    expect(
      parseWeeklyMedia({ reviewed: true, cover, demoUrl: 'https://www.youtube.com/watch?v=demo' })
        ?.demoUrl,
    ).toBe('https://www.youtube.com/watch?v=demo');
    expect(
      parseWeeklyMedia({ reviewed: true, cover, demoUrl: 'https://localhost/private' })?.demoUrl,
    ).toBeUndefined();
  });
});
