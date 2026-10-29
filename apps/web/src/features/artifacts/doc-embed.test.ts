import { describe, expect, test } from 'bun:test';

import { canEmbed, embedFromUrl, fetchEmbed, plainSummary } from './doc-embed';

const page = (over: Record<string, string | null>) => async (url: string) => ({ url, title: null, description: null, site_name: null, image_url: null, ...over });

describe('link cards', () => {
  test('any http(s) address can be a card; other text cannot', () => {
    expect(canEmbed('https://github.com/a/b/pull/12')).toBe(true);
    expect(canEmbed('https://example.com/art')).toBe(true);
    expect(canEmbed('http://example.com/a')).toBe(true);
    expect(canEmbed('example.com/a')).toBe(false);
    expect(canEmbed('https://example.com/a b')).toBe(false);
    expect(canEmbed('javascript:alert(1)')).toBe(false);
  });

  test('the URL alone names the page: its address, or a Linear issue by id and name', () => {
    expect(embedFromUrl('https://example.com/art')).toMatchObject({ title: 'example.com/art', image: '' });
    expect(embedFromUrl('https://example.com/')).toMatchObject({ title: 'example.com' });
    expect(embedFromUrl('https://linear.app/acme/issue/eng-42/fix-the-login-loop')).toMatchObject({ title: 'ENG-42 Fix the login loop' });
    expect(embedFromUrl('https://linear.app/acme/project/q4-launch-9f8e7d6c5b4a')).toMatchObject({ title: 'Q4 launch' });
  });

  test('a summary is one plain line without Markdown, HTML or comments, capped', () => {
    expect(plainSummary('## Why\n\n<!-- hidden -->Fixes **the** [login](https://x.y) loop.\n\n```ts\ncode\n```')).toBe('Why Fixes the login loop.');
    expect(plainSummary('a'.repeat(400))).toHaveLength(220);
    expect(plainSummary(null)).toBe('');
    expect(plainSummary('Every agents.&lt;name&gt; key &amp; more')).toBe('Every agents.<name> key & more');
  });
});

describe('a card from the page', () => {
  test('the page\'s title, description and image, as the API read them', async () => {
    const read = page({ title: 'Art • Studio', description: 'Original paintings.', image_url: 'https://example.com/og.png' });
    expect(await fetchEmbed('https://example.com/art', read)).toEqual({
      href: 'https://example.com/art',
      title: 'Art • Studio',
      summary: 'Original paintings.',
      image: 'https://example.com/og.png',
    });
  });

  test('a page that says nothing, or a failed read: the card the URL gives', async () => {
    expect(await fetchEmbed('https://example.com/art', page({}))).toMatchObject({ title: 'example.com/art', summary: '', image: '' });
    const failing = async () => {
      throw new Error('offline');
    };
    expect(await fetchEmbed('https://example.com/art', failing)).toMatchObject({ title: 'example.com/art' });
  });

  test('Linear is not read (its pages need a login)', async () => {
    let reads = 0;
    const read = async (url: string) => {
      reads += 1;
      return page({ title: 'Linear' })(url);
    };
    expect(await fetchEmbed('https://linear.app/acme/issue/eng-42/fix-login', read)).toMatchObject({ title: 'ENG-42 Fix login' });
    expect(reads).toBe(0);
  });
});
