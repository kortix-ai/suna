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

/** Clauses added to one anchor, in the redline's order: by their own clause number (stable for equal numbers). */
const clauseNo = (t: string) => (CLAUSE.exec(t)?.[0].trim().replace(/\.$/, '').split('.').map(Number) ?? []);
export function byClause(a: string, b: string): number {
  const x = clauseNo(a);
  const y = clauseNo(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? -1) !== (y[i] ?? -1)) return (x[i] ?? -1) - (y[i] ?? -1);
  return 0;
}

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
  // Added clauses wait by their anchor paragraph's index and go in after it in the
  // redline's order (their own clause numbers), whatever order the lawyer accepted them in.
  const adds = new Map<number, string[]>();
  for (const c of changes) {
    let done = false;
    let i = -1;
    out = out.replace(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g, (p) => {
      i += 1;
      if (done) return p;
      const r = applyToText(paragraphText(p), c);
      if (!r) return p;
      done = true;
      if (!r.added) return rebuild(p, r.text);
      adds.set(i, [...(adds.get(i) ?? []), r.added]);
      return p;
    });
    if (done) applied += 1;
    else missing.push(c.from);
  }
  let k = -1;
  out = out.replace(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g, (p) => {
    k += 1;
    return p + [...(adds.get(k) ?? [])].sort(byClause).map((t) => rebuild(p, ADDED + t)).join('');
  });
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
    if (r.added) {
      // After the anchor and any clause added to it that comes first in the redline.
      let j = i + 1;
      while (rows[j]?.added && byClause(rows[j].text, r.added) <= 0) j += 1;
      rows.splice(j, 0, { text: r.added, added: true });
    }
    else rows[i] = { ...rows[i], text: r.text };
    applied += 1;
  }
  const paras = renumberAdded(rows);
  // markdownDocx reads "#" and "- " at a line start as Markdown: contract text is plain.
  const md = paras.map((t) => t.replace(/^(#|- )/, '​$1')).join('\n\n');
  return { blob: await markdownDocx(md), filename: source.filename.replace(/\.[^.]+$/, '') + '.docx', applied, missing };
}
