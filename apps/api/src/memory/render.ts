/**
 * The files of the read-only copy (pure): page slugs, the source tokens a body
 * cites, and each page's markdown file (a YAML header and the body).
 */
import type { MemoryCopyDir, MemoryPageType } from '@kortix/api-contract';
import { MEMORY_COPY_DIR } from '@kortix/api-contract/sandbox-layout';
import { spaceSlug } from '@kortix/shared';

/** The copy folder of each page type. */
export const TYPE_FOLDERS: Record<MemoryPageType, string> = {
  people: 'people',
  decisions: 'decisions',
  workstreams: 'workstreams',
  playbooks: 'playbooks',
  note: 'notes',
};

const TOKEN_RE = /⟦(\d+)⟧/g;

/**
 * File names per page, unique per layer: the ASCII title slug, else
 * `page-<first 8 of page_id>`; a clash takes `-<first 6 of page_id>`. Pages
 * oldest first, so a page keeps its name while newer pages come and go.
 */
export function pageSlugs(pages: readonly { pageId: string; title: string; createdAt: Date }[]): Map<string, string> {
  const ordered = [...pages].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.pageId < b.pageId ? -1 : 1));
  const taken = new Set<string>();
  const slugs = new Map<string, string>();
  for (const page of ordered) {
    const base = spaceSlug(page.title) || `page-${page.pageId.slice(0, 8)}`;
    let slug = base;
    if (taken.has(slug)) slug = `${base}-${page.pageId.slice(0, 6)}`;
    if (taken.has(slug)) slug = `${base}-${page.pageId.toLowerCase()}`;
    taken.add(slug);
    slugs.set(page.pageId, slug);
  }
  return slugs;
}

export const copyPath = (dir: MemoryCopyDir, type: MemoryPageType, slug: string) =>
  `${MEMORY_COPY_DIR}/${dir}/${TYPE_FOLDERS[type]}/${slug}.md`;

/** Each ⟦n⟧ as `[label]`; a number with no source renders nothing. */
export function resolveTokens(body: string, labels: ReadonlyMap<number, string>): string {
  return body.replace(TOKEN_RE, (_token, n: string) => {
    const label = labels.get(Number(n));
    return label === undefined ? '' : `[${label}]`;
  });
}

/** A YAML scalar: JSON's double-quoted string is valid YAML and escapes `:`, `#` and newlines. */
const yaml = (value: string | null) => (value === null ? 'null' : JSON.stringify(value));

export interface RenderedPage {
  pageId: string;
  type: MemoryPageType;
  title: string;
  summary: string;
  body: string;
  updatedAt: Date;
  updatedBy: string | null;
  sources: readonly { number: number; label: string; sessionId: string | null }[];
}

/** The whole file of one page in the copy. */
export function renderPageMarkdown(page: RenderedPage): string {
  const labels = new Map(page.sources.map((source) => [source.number, source.label]));
  const header = [
    '---',
    `title: ${yaml(page.title)}`,
    `type: ${page.type}`,
    `summary: ${yaml(page.summary)}`,
    `updated_at: ${yaml(page.updatedAt.toISOString())}`,
    `updated_by: ${yaml(page.updatedBy)}`,
    `page_id: ${yaml(page.pageId)}`,
    page.sources.length === 0 ? 'sources: []' : 'sources:',
    ...page.sources.map((source) => `  - {n: ${source.number}, label: ${yaml(source.label)}, thread: ${yaml(source.sessionId)}}`),
    '---',
  ];
  const body = resolveTokens(page.body, labels).replace(/\s+$/, '');
  return `${header.join('\n')}\n\n# ${page.title.replace(/\s+/g, ' ')}\n\n${body ? `${body}\n` : ''}`;
}
