import {
  absoluteUrl,
  getPublicContentRecords,
  resolvePublicMarkdown,
  type PublicContentKind,
} from '@/lib/seo/public-content';
import { siteMetadata } from '@/lib/site-metadata';

const SECTION_LABELS: Record<PublicContentKind, string> = {
  marketing: 'Core pages',
  docs: 'Documentation',
  blog: 'Blog',
  'use-case': 'Use cases',
};

export function renderLlmsTxt(): string {
  const records = getPublicContentRecords();
  const sections: string[] = [];
  for (const kind of Object.keys(SECTION_LABELS) as PublicContentKind[]) {
    const items = records.filter((record) => record.kind === kind && record.markdownPath);
    if (!items.length) continue;
    if (sections.length) sections.push('');
    sections.push(
      `## ${SECTION_LABELS[kind]}`,
      ...items.map(
        (item) =>
          `- [${item.title}](${absoluteUrl(item.markdownPath!)}): ${item.description ?? `Official ${kind} content.`}`,
      ),
    );
  }

  return [
    '# Kortix',
    '',
    `> ${siteMetadata.description}`,
    '',
    `Canonical site: ${siteMetadata.url}`,
    `Full corpus: ${absoluteUrl('/llms-full.txt')}`,
    `Structured content index: ${absoluteUrl('/api/ai')}`,
    '',
    ...sections,
    '',
  ].join('\n');
}

export function renderLlmsFullTxt(): string {
  const documents = getPublicContentRecords().flatMap((record) => {
    if (!record.markdownPath) return [];
    const path = record.markdownPath.replace(/^\/markdown\//, '').split('/');
    const resolved = resolvePublicMarkdown(path);
    if (!resolved) return [];
    return [`<!-- ${record.markdownPath} -->\n\n${resolved.markdown.trim()}`];
  });

  return [
    '# Kortix full public content corpus',
    '',
    `> ${siteMetadata.description}`,
    '',
    ...documents.flatMap((document, index) => (index ? ['', '---', '', document] : [document])),
    '',
  ].join('\n');
}
