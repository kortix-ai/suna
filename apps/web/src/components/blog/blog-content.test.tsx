/**
 * Characterization for `BlogContent`, written before the unreferenced
 * `PostTags` helper was removed. The blog renderer is the SEO surface; these
 * tests pin the block variants and the duplicate-block key handling it must
 * keep rendering identically.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'bun:test';

import { createElement } from 'react';
import { BlogContent, type Block } from './blog-content';

function html(blocks: Block[]) {
  return renderToStaticMarkup(createElement(BlogContent, { blocks }));
}

describe('BlogContent', () => {
  test('renders the plain variants to semantic HTML with inline rich text', () => {
    const out = html([
      { type: 'lead', text: 'Opening **bold** line' },
      { type: 'h2', text: 'A heading' },
      { type: 'p', text: 'Body with `code` and [a link](https://example.test/docs).' },
      { type: 'ul', items: ['one', 'two'] },
      { type: 'code', code: 'pnpm i' },
      { type: 'callout', text: 'Watch out' },
    ]);
    expect(out).toContain('<h2');
    expect(out).toContain('<strong');
    expect(out).toContain('<code');
    expect(out).toContain('<a'); // the markdown link renders as an anchor
    expect(out).toContain('https://example.test/docs');
    expect(out).toContain('<li');
    expect(out).toContain('<pre');
    expect(out).toContain('Watch out');
  });

  test('the same block twice gets distinct keys instead of colliding', () => {
    // blockContent keys on `type:content`; a duplicated paragraph must not
    // produce two identical React keys.
    const blocks: Block[] = [
      { type: 'p', text: 'Same text' },
      { type: 'p', text: 'Same text' },
    ];
    const out = html(blocks);
    expect(out.match(/Same text/g)).toHaveLength(2);
    expect(out).not.toContain('Warning:'); // no duplicate-key React warning
  });

  test('logos and compare blocks render their rows', () => {
    const out = html([
      { type: 'logos', label: 'Works with', items: [{ domain: 'example.test', name: 'Example' }] },
      {
        type: 'compare',
        them: 'Them',
        rows: [{ dimension: 'Speed', them: 'slow', kortix: 'fast', lean: 'kortix' }],
      },
    ]);
    expect(out).toContain('Works with');
    expect(out).toContain('Example');
    expect(out).toContain('Speed');
    expect(out).toContain('fast');
  });
});
