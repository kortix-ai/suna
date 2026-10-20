// Citation checks: the authority. The agent kit runs the same rules in
// Python (agent-kit/lumen-kit/lumen_kit/core.py); agent-kit/shared/cite-vectors.json
// pins both. Lumen re-checks every citation here before a value reaches the UI.

export const MAX_QUOTE = 300;

/** NFKC, soft and line-break hyphens removed, quotes and dashes unified, whitespace collapsed. Case is kept. */
export function normalize(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/­/g, "")
    .replace(/(?<=[\p{L}\p{N}_])-[ \t]*\n\s*(?=[\p{L}\p{N}_])/gu, "")
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

export interface Citation {
  doc_id: string;
  a: string;
  quote: string;
}

export type CitationStatus = "verified" | "relocated" | "unverified";

/** A paragraph of one document, as `documentParas` stores it. */
export interface Para {
  page: number;
  para: number;
  text: string;
}

export const anchorOf = (p: { page: number; para: number }) => `p${p.page}.${p.para}`;

/**
 * verified: the quote is in the cited paragraph. relocated: it is in another
 * paragraph of the same document (the anchor is corrected). unverified: it is
 * not in the document, or the quote is empty or too long.
 */
export function verifyCitation(c: Citation, paras: readonly Para[]): { status: CitationStatus; a: string } {
  const quote = normalize(c.quote ?? "");
  if (!quote || (c.quote ?? "").length > MAX_QUOTE) return { status: "unverified", a: c.a };
  const cited = paras.find((p) => anchorOf(p) === c.a);
  if (cited && normalize(cited.text).includes(quote)) return { status: "verified", a: c.a };
  const other = paras.find((p) => normalize(p.text).includes(quote));
  return other ? { status: "relocated", a: anchorOf(other) } : { status: "unverified", a: c.a };
}
