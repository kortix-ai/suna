// The accepted redlines of a contract review, applied to the contract: the text a new
// version of the document holds. A DOCX keeps its own package (styles, numbering,
// headers); only the paragraphs an accepted change touches are rewritten, as plain text
// in the paragraph's first-run formatting. A PDF or TXT has no DOCX to edit, so the new
// version is a DOCX written from the document's anchored text.

import JSZip from 'jszip';
import { markdownDocx } from './markdown-docx';

export interface Change {
  from: string;
  to: string;
}

export interface Applied {
  blob: Blob;
  filename: string;
  applied: number;
  /** The `from` text of each change the document no longer contains. */
  missing: string[];
}

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
// A clause number at the start of added text: "3.4 ", "12 ".
const CLAUSE = /^\d+(\.\d+)*\.?\s/;
const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unesc = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** The paragraph's text, from its `<w:t>` runs. */
export function paragraphText(p: string): string {
  return [...p.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((m) => unesc(m[1])).join('');
}

/**
 * Apply one change to a paragraph's text: `null` when `from` is not in it. A change
 * whose `to` is `from` plus a new numbered clause adds that clause as its own paragraph.
 */
export function applyToText(text: string, c: Change): { text: string; added?: string } | null {
  const at = text.indexOf(c.from);
  if (at >= 0) {
    const tail = c.to.startsWith(c.from) ? c.to.slice(c.from.length).trim() : null;
    if (tail && CLAUSE.test(tail)) return { text, added: tail };
    return { text: text.slice(0, at) + c.to + text.slice(at + c.from.length) };
  }
  // The same words with other spacing (a line break in the source).
  if (flat(text).includes(flat(c.from))) return applyToText(flat(text), { from: flat(c.from), to: c.to });
  return null;
}

/**
 * Number each added clause after the numbered paragraph before it. The review numbers a
 * new clause as if every suggested clause were accepted; a subset would skip numbers
 * (1, 2, 3, 5). Original paragraphs keep their numbers.
 */
export function renumberAdded(paras: Array<{ text: string; added: boolean }>): string[] {
  let prev: number[] | null = null;
  return paras.map(({ text, added }) => {
    const m = CLAUSE.exec(text);
    if (!m) return text;
    const parts = m[0].trim().replace(/\.$/, '').split('.').map(Number);
    if (!added || !prev || prev.length < parts.length) {
      prev = parts;
      return text;
    }
    const next = [...prev.slice(0, parts.length - 1), prev[parts.length - 1] + 1];
    prev = next;
    const dot = m[0].trim().endsWith('.') ? '.' : '';
    return `${next.join('.')}${dot} ${text.slice(m[0].length)}`;
  });
}

const ADDED = '\u0000lumen-added\u0000';

function rebuild(p: string, text: string): string {
  const open = /^<w:p(?:\s[^>]*)?>/.exec(p)?.[0] ?? '<w:p>';
  const ppr = /<w:pPr>[\s\S]*?<\/w:pPr>/.exec(p)?.[0] ?? '';
  const rpr = /<w:r(?:\s[^>]*)?>\s*(<w:rPr>[\s\S]*?<\/w:rPr>)/.exec(p)?.[1] ?? '';
  return `${open}${ppr}<w:r>${rpr}<w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
}

/** Apply the changes to a DOCX's `word/document.xml`. */
export function applyToDocumentXml(xml: string, changes: Change[]): { xml: string; applied: number; missing: string[] } {
  let out = xml;
  let applied = 0;
  const missing: string[] = [];
  for (const c of changes) {
    let done = false;
    out = out.replace(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g, (p) => {
      if (done) return p;
      const r = applyToText(paragraphText(p), c);
      if (!r) return p;
      done = true;
      return r.added ? `${p}${rebuild(p, ADDED + r.added)}` : rebuild(p, r.text);
    });
    if (done) applied += 1;
    else missing.push(c.from);
  }
  const ps = [...out.matchAll(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)].map((m) => m[0]);
  const texts = renumberAdded(ps.map((p) => {
    const t = paragraphText(p);
    return t.startsWith(ADDED) ? { text: t.slice(ADDED.length), added: true } : { text: t, added: false };
  }));
  let i = 0;
  out = out.replace(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g, (p) => {
    const t = texts[i++];
    return paragraphText(p).startsWith(ADDED) ? rebuild(p, t) : p;
  });
  return { xml: out, applied, missing };
}

/** The new version: the source's bytes with the accepted changes in. */
export async function applyChanges(
  source: { bytes: ArrayBuffer; filename: string; mime: string; paras: Array<{ text: string }> },
  changes: Change[],
): Promise<Applied> {
  if (source.mime === DOCX) {
    const zip = await JSZip.loadAsync(source.bytes);
    const doc = zip.file('word/document.xml');
    if (!doc) throw new Error('This Word file has no document body');
    const r = applyToDocumentXml(await doc.async('string'), changes);
    zip.file('word/document.xml', r.xml);
    const blob = await zip.generateAsync({ type: 'blob', mimeType: DOCX });
    return { blob, filename: source.filename, applied: r.applied, missing: r.missing };
  }
  const rows = source.paras.map((p) => ({ text: p.text, added: false }));
  let applied = 0;
  const missing: string[] = [];
  for (const c of changes) {
    const i = rows.findIndex((row) => applyToText(row.text, c));
    if (i < 0) {
      missing.push(c.from);
      continue;
    }
    const r = applyToText(rows[i].text, c)!;
    if (r.added) rows.splice(i + 1, 0, { text: r.added, added: true });
    else rows[i] = { ...rows[i], text: r.text };
    applied += 1;
  }
  const paras = renumberAdded(rows);
  // markdownDocx reads "#" and "- " at a line start as Markdown: contract text is plain.
  const md = paras.map((t) => t.replace(/^(#|- )/, '​$1')).join('\n\n');
  return { blob: await markdownDocx(md), filename: source.filename.replace(/\.[^.]+$/, '') + '.docx', applied, missing };
}
