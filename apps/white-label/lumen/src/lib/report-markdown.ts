// The due-diligence report as a Markdown file: it must read outside Lumen, so
// every citation link (/cite?d=<doc>&a=p<page>.<para>&q=…) becomes
// "(filename, p. N)". Every claim in it already passed Lumen's citation check.

type Citation = { documentId: string; filename: string; page: number };
type Report = {
  sections?: Array<{ heading: string; bodyMd: string; citations: Citation[] }>;
  redFlags?: Array<{ title: string; severity: 'high' | 'medium' | 'low'; filename?: string; citations: Citation[] }>;
};

const SEVERITY = { high: 'High', medium: 'Medium', low: 'Low' } as const;
const CITE = /\[[^\]]*\]\(\/cite\?d=([^&)]+)&a=p(\d+)\.\d+[^)]*\)/g;

export function reportMarkdown(title: string, report: Report): string {
  const names = new Map<string, string>();
  for (const s of report.sections ?? []) for (const c of s.citations) names.set(c.documentId, c.filename);
  for (const f of report.redFlags ?? []) for (const c of f.citations) names.set(c.documentId, c.filename);
  const out = [`# ${title}`, ''];
  const flags = report.redFlags ?? [];
  if (flags.length) {
    out.push('## Red flags', '');
    for (const f of flags) out.push(`- **${SEVERITY[f.severity]}**: ${f.title} (${f.filename ?? f.citations[0]?.filename ?? 'document'}${f.citations[0] ? `, p. ${f.citations[0].page}` : ''})`);
    out.push('');
  }
  for (const s of report.sections ?? []) {
    const body = s.bodyMd.replace(CITE, (_, d: string, page: string) => `(${names.get(d) ?? 'document'}, p. ${page})`);
    out.push(`## ${s.heading}`, '', body.trim(), '');
  }
  return `${out.join('\n').trim()}\n`;
}
