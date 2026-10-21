import { describe, expect, test } from 'bun:test';
import JSZip from 'jszip';
import { applyChanges, applyToDocumentXml, paragraphText } from '../../src/lib/apply-changes';

const P = (text: string, rpr = '<w:rPr><w:b/></w:rPr>') =>
  `<w:p><w:pPr><w:jc w:val="both"/></w:pPr><w:r>${rpr}<w:t xml:space="preserve">${text.slice(0, 10)}</w:t></w:r><w:r><w:t>${text.slice(10)}</w:t></w:r></w:p>`;
const body = (...ps: string[]) => `<w:document><w:body>${ps.join('')}</w:body></w:document>`;

describe('accepted changes into a new version of the contract', () => {
  test('a changed term is rewritten in its paragraph, keeping the paragraph and first-run formatting', () => {
    const xml = body(P('4.1 The obligations last seven (7) years from disclosure.'), P('4.2 Other text.'));
    const r = applyToDocumentXml(xml, [{ from: 'seven (7) years', to: 'three (3) years' }]);
    expect(r).toMatchObject({ applied: 1, missing: [] });
    const paras = [...r.xml.matchAll(/<w:p>[\s\S]*?<\/w:p>/g)].map((m) => m[0]);
    expect(paragraphText(paras[0])).toBe('4.1 The obligations last three (3) years from disclosure.');
    expect(paras[0]).toContain('<w:jc w:val="both"/>');
    expect(paras[0]).toContain('<w:b/>');
    expect(paragraphText(paras[1])).toBe('4.2 Other text.');
  });

  test('a missing clause is added as its own paragraph after its anchor, which stays as it was', () => {
    const anchor = '3.3 The Recipient may disclose where lawful.';
    const r = applyToDocumentXml(body(P(anchor), P('4.1 Term.')), [{ from: anchor, to: `${anchor} 3.4 Nothing restricts residual knowledge.` }]);
    const texts = [...r.xml.matchAll(/<w:p>[\s\S]*?<\/w:p>/g)].map((m) => paragraphText(m[0]));
    expect(texts).toEqual([anchor, '3.4 Nothing restricts residual knowledge.', '4.1 Term.']);
  });

  test('a change whose text is gone is reported, not guessed', () => {
    const r = applyToDocumentXml(body(P('1.1 Something else entirely.')), [{ from: 'ten (10) days', to: 'thirty (30) days' }]);
    expect(r).toMatchObject({ applied: 0, missing: ['ten (10) days'] });
  });

  test('a PDF or TXT source becomes a DOCX version written from its text', async () => {
    const out = await applyChanges(
      { bytes: new ArrayBuffer(0), filename: 'dpa-lattice.pdf', mime: 'application/pdf', paras: [{ text: '4.1 At least ten (10) days notice.' }, { text: '# not a heading' }] },
      [{ from: 'ten (10) days', to: 'thirty (30) days' }],
    );
    expect(out).toMatchObject({ filename: 'dpa-lattice.docx', applied: 1, missing: [] });
    const xml = await (await JSZip.loadAsync(await out.blob.arrayBuffer())).file('word/document.xml')!.async('string');
    expect(xml).toContain('4.1 At least thirty (30) days notice.');
    expect(xml).not.toContain('<w:sz w:val="36"/>'); // "#" stayed text, not a heading
  });
});
