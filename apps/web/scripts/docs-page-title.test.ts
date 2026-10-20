import { beforeAll, expect, test } from 'bun:test';
import { buildBlumeDocs } from './blume-docs.mjs';

// Assert the HTML readers receive, including Blume's shared title template.
beforeAll(() => buildBlumeDocs(), 120_000);
for (const [page, title] of [
  ['index.html', 'Docs - Kortix'],
  ['quickstart/index.html', 'Quickstart - Kortix'],
]) {
  test(`built docs title: ${page}`, async () => {
    const html = Bun.file(new URL(`../public/docs/${page}`, import.meta.url));
    let actual = '';
    await new HTMLRewriter()
      .on('title', { text(chunk) { actual += chunk.text; } })
      .transform(new Response(html))
      .text();
    expect(actual).toBe(title);
  });
}
