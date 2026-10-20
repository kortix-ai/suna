// The one segmenter (spec D4). Lumen splits each document into pages and
// anchored paragraphs here, and writes them to Drive as Text/<docId>.md. The
// agent kit reads those anchors and never segments a document itself.

export interface Segment {
  page: number;
  /** Document-wide paragraph number: anchor `p<page>.<para>`. */
  para: number;
  text: string;
  heading?: string;
}

/** Characters per "page" of a document with no fixed pages (DOCX, TXT). */
export const SECTION_CHARS = 3000;
const MAX_PARA = 1500;
const NUMBERED = /^\(?\d+(\.\d+)*[.)]?\s+\S/;
const ENDS_SENTENCE = /[.;:!?)"'\]]$/;

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
/** A short title line: "11. Limitation of Liability", "Master Services Agreement". Not a wrapped sentence, a sub-clause or a footer. */
const isHeading = (line: string) =>
  words(line) <= 8 && line.length <= 70 && !/[.;:,-]$/.test(line) && !/[,;:]/.test(line) && !/\p{L}\.\s/u.test(line) &&
  !/^\d+\.\d/.test(line) && /^[\p{Lu}\p{N}([]/u.test(line);

/** Join wrapped lines: a line-break hyphen between letters is dropped, other breaks become one space. */
function joinLines(lines: string[]): string {
  return lines.reduce((acc, line) => (/[\p{L}]-$/u.test(acc) && /^\p{Ll}/u.test(line) ? acc.slice(0, -1) + line : acc ? `${acc} ${line}` : line), "");
}

/** Split an over-long paragraph at sentence ends. */
function splitLong(text: string): string[] {
  if (text.length <= MAX_PARA) return [text];
  const out: string[] = [];
  let cur = "";
  for (const sentence of text.split(/(?<=[.;!?])\s+(?=\p{Lu}|\()/u)) {
    if (cur && cur.length + sentence.length + 1 > MAX_PARA) {
      out.push(cur);
      cur = sentence;
    } else cur = cur ? `${cur} ${sentence}` : sentence;
  }
  if (cur) out.push(cur);
  return out;
}

/** Paragraph blocks of one page. A paragraph starts at a blank line, a numbered clause, a heading, or after a short line that ends a sentence. */
export function pageBlocks(pageText: string): string[] {
  const lines = pageText.split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim());
  const maxLen = Math.max(1, ...lines.map((l) => l.length));
  const blocks: string[][] = [];
  let cur: string[] = [];
  const flush = () => {
    if (cur.length) blocks.push(cur);
    cur = [];
  };
  for (const line of lines) {
    if (!line) {
      flush();
      continue;
    }
    const prev = cur[cur.length - 1];
    const prevEnds = prev !== undefined && ENDS_SENTENCE.test(prev);
    const startsNew =
      prev !== undefined &&
      (NUMBERED.test(line) ||
        (cur.length === 1 && isHeading(prev)) ||
        (prevEnds && (prev.length < 0.8 * maxLen || isHeading(line))));
    if (startsNew) flush();
    cur.push(line);
  }
  flush();
  return blocks.flatMap((b) => splitLong(joinLines(b)));
}

/** DOCX and TXT have no pages: group blank-line paragraphs into sections of about SECTION_CHARS. */
export function sectionsFromText(text: string): string[] {
  const sections: string[] = [];
  let cur = "";
  for (const block of text.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean)) {
    if (cur && cur.length + block.length > SECTION_CHARS) {
      sections.push(cur);
      cur = block;
    } else cur = cur ? `${cur}\n\n${block}` : block;
  }
  if (cur) sections.push(cur);
  return sections.length ? sections : [""];
}

/** Every page's paragraphs, numbered across the document, each with the heading it sits under. */
export function segment(pages: string[]): Segment[] {
  const out: Segment[] = [];
  let heading: string | undefined;
  pages.forEach((pageText, i) => {
    for (const text of pageBlocks(pageText)) {
      if (isHeading(text)) heading = text;
      out.push({ page: i + 1, para: out.length + 1, text, ...(heading ? { heading } : {}) });
    }
  });
  return out;
}

const attr = (s: string) => s.replace(/["\n]/g, "'").slice(0, 120);

/** Text/<docId>.md: one anchor comment before every paragraph. */
export function renderText(docId: string, filename: string, pages: number, paras: Segment[]): string {
  const head = `<!-- lumen:doc id=${docId} file="${attr(filename)}" pages=${pages} -->`;
  const body = paras.map(
    (p) => `<!-- lumen:a p=${p.page} n=${p.para}${p.heading ? ` h="${attr(p.heading)}"` : ""} -->\n${p.text.replace(/<!--|-->/g, "")}`,
  );
  return `${[head, ...body].join("\n\n")}\n`;
}
