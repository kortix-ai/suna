import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractText, getDocumentProxy } from 'unpdf';
import { pageBlocks, renderText, sectionsFromText, segment } from '../../convex/lib/segment';

const DIST = join(import.meta.dir, '..', '..', 'demo-data', 'dist');

describe('segment', () => {
  test('wrapped PDF lines join; numbered clauses and headings start paragraphs', () => {
    const page = [
      'Master Services Agreement',
      'This Agreement is made between Example Buyer Ltd and Example Seller Inc. for the supply of',
      'services under each statement of work.',
      '11. Limitation of Liability',
      "11.1 Neither party's liability under this Agreement shall be limited or capped in amount. Each party is liable",
      'for all losses caused by its breach.',
      '11.2 Nothing excludes liability for fraud.',
    ].join('\n');
    expect(pageBlocks(page)).toEqual([
      'Master Services Agreement',
      'This Agreement is made between Example Buyer Ltd and Example Seller Inc. for the supply of services under each statement of work.',
      '11. Limitation of Liability',
      "11.1 Neither party's liability under this Agreement shall be limited or capped in amount. Each party is liable for all losses caused by its breach.",
      '11.2 Nothing excludes liability for fraud.',
    ]);
    const segs = segment([page]);
    expect(segs[3]).toEqual({ page: 1, para: 4, text: expect.stringMatching(/^11\.1 /), heading: '11. Limitation of Liability' });
  });

  test('a line-break hyphen inside a word is removed', () => {
    expect(pageBlocks('The Recip-\nient shall comply.')).toEqual(['The Recipient shall comply.']);
  });

  test('a paragraph over 1,500 characters splits at sentence ends', () => {
    const long = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} is here and it has words.`).join(' ');
    const blocks = pageBlocks(long);
    expect(blocks.length).toBeGreaterThan(1);
    expect(blocks.every((b) => b.length <= 1500)).toBe(true);
  });

  test('DOCX/TXT text becomes sections of about 3,000 characters', () => {
    const text = Array.from({ length: 30 }, (_, i) => `${i + 1}.1 ${'word '.repeat(40)}`).join('\n\n');
    const sections = sectionsFromText(text);
    expect(sections.length).toBeGreaterThan(1);
    expect(sections.every((s) => s.length <= 3300)).toBe(true);
  });

  test('the demo MSA keeps clause 11.1 whole on its page', async () => {
    const pdf = await getDocumentProxy(new Uint8Array(readFileSync(join(DIST, 'msa-brightwater-quillon.pdf'))));
    const { text } = await extractText(pdf, { mergePages: false });
    const segs = segment(text as string[]);
    const cap = segs.find((s) => s.text.startsWith('11.1 '));
    expect(cap?.text).toContain('shall be limited or capped in amount. Each party is liable for all losses caused by its breach.');
    expect(cap?.heading).toBe('11. Limitation of Liability');
    const md = renderText('doc1', 'msa "x".pdf', text.length, segs);
    expect(md.startsWith(`<!-- lumen:doc id=doc1 file="msa 'x'.pdf" pages=${text.length} -->`)).toBe(true);
    expect(md).toContain(`<!-- lumen:a p=${cap!.page} n=${cap!.para} h="11. Limitation of Liability" -->\n11.1 `);
  });
});
