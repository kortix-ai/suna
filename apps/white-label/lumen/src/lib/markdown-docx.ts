// A Markdown report as a .docx, built in the browser from the result Lumen already
// checked. The sandbox's own report.docx is never served: it predates the check.
// Covers what reportMarkdown writes: #/## headings, "- " items, paragraphs, **bold**.

import JSZip from 'jszip';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function runs(text: string, size?: number, bold = false) {
  const sz = size ? `<w:sz w:val="${size}"/>` : '';
  return text
    .split(/(\*\*[^*]+\*\*)/)
    .filter(Boolean)
    .map((t) => {
      const b = bold || /^\*\*.*\*\*$/.test(t);
      const body = b && !bold ? t.slice(2, -2) : t;
      return `<w:r><w:rPr>${b ? '<w:b/>' : ''}${sz}</w:rPr><w:t xml:space="preserve">${esc(body)}</w:t></w:r>`;
    })
    .join('');
}

export function documentXml(md: string): string {
  const paras = md.split(/\n\s*\n|\n(?=#|- )/).map((b) => b.trim()).filter(Boolean).map((line) => {
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) return `<w:p><w:pPr><w:spacing w:before="240" w:after="120"/></w:pPr>${runs(h[2], h[1].length === 1 ? 36 : 28, true)}</w:p>`;
    if (line.startsWith('- ')) return `<w:p><w:pPr><w:ind w:left="360" w:hanging="240"/></w:pPr>${runs(`• ${line.slice(2)}`)}</w:p>`;
    return `<w:p>${runs(line.replace(/\s*\n\s*/g, ' '))}</w:p>`;
  });
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paras.join('')}</w:body></w:document>`;
}

export function markdownDocx(md: string): Promise<Blob> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', documentXml(md));
  return zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
}
