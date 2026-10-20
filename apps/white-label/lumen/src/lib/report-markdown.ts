// The due-diligence report as a Markdown file: it must read outside Lumen, so
// every citation link (/cite?d=<doc>&a=p<page>.<para>&q=…) becomes
// "(filename, p. N)". The status comes from Lumen's citation check (convex/runs.ts
// ingestReport): a link whose quote is not in the source, or that the check never
// saw, reads "(filename, p. N, not found in source)". It is never a plain reference.

import { parseCite } from './cite-link';

type Status = 'verified' | 'relocated' | 'unverified';
type Citation = { documentId: string; filename: string; page: number; quote?: string; status?: Status };
type Report = {
  sections?: Array<{ heading: string; bodyMd: string; citations: Citation[] }>;
  redFlags?: Array<{ title: string; severity: 'high' | 'medium' | 'low'; filename?: string; citations: Citation[] }>;
};

const SEVERITY = { high: 'High', medium: 'Medium', low: 'Low' } as const;
const CITE = /\[[^\]]*\]\((\/cite\?[^)\s]*)\)/g;
export const NOT_FOUND = 'not found in source';

const checked = (c: Citation | undefined) => !!c && c.status !== 'unverified';

/** "(file, p. N)" for a checked citation, "(file, p. N, not found in source)" otherwise. */
function ref(filename: string, c: Citation | undefined, page?: number) {
  const p = c?.page ?? page;
  return `(${filename}${p ? `, p. ${p}` : ''}${checked(c) ? '' : `, ${NOT_FOUND}`})`;
}

/** The first citation that passed the check, else the first one (shown as not found). */
export function bestCitation<C extends { status?: Status }>(citations: C[]): C | undefined {
  return citations.find((c) => c.status !== 'unverified') ?? citations[0];
}

export function reportMarkdown(title: string, report: Report): string {
  const names = new Map<string, string>();
  for (const s of report.sections ?? []) for (const c of s.citations) names.set(c.documentId, c.filename);
  for (const f of report.redFlags ?? []) for (const c of f.citations) names.set(c.documentId, c.filename);
  const out = [`# ${title}`, ''];
  const flags = report.redFlags ?? [];
  if (flags.length) {
    out.push('## Red flags', '');
    for (const f of flags) {
      const c = bestCitation(f.citations);
      out.push(`- **${SEVERITY[f.severity]}**: ${f.title} ${ref(f.filename ?? c?.filename ?? 'document', c)}`);
    }
    out.push('');
  }
  for (const s of report.sections ?? []) {
    const body = s.bodyMd.replace(CITE, (_, href: string) => {
      const link = parseCite(href);
      if (!link) return '';
      const page = Number(/^p(\d+)/.exec(link.a)?.[1]) || undefined;
      const mine = s.citations.filter((c) => c.documentId === link.d);
      // The same quote the check saw (stored up to 300 chars), else the same page.
      const c = mine.find((x) => x.quote !== undefined && x.quote === link.q.slice(0, 300)) ?? mine.find((x) => x.page === page);
      return ref(names.get(link.d) ?? 'document', c, page);
    });
    out.push(`## ${s.heading}`, '', body.trim(), '');
  }
  return `${out.join('\n').trim()}\n`;
}
