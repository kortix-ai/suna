import fs from 'node:fs';
import path from 'node:path';

import type { Block } from '@/components/blog/blog-content';
import { PRICING_PLANS } from '@/features/billing/pricing-plans';
import { BLOG_POSTS } from '@/lib/blog-posts';
import { CANONICAL_ORIGIN, siteMetadata } from '@/lib/site-metadata';

export type PublicContentKind = 'marketing' | 'blog' | 'docs' | 'use-case';

export type PublicContentRecord = {
  kind: PublicContentKind;
  slug: string;
  title: string;
  description?: string;
  htmlPath: string;
  markdownPath?: string;
  lastModified?: string;
};

type SourceDocument = PublicContentRecord & { sourcePath: string };

export const STATIC_PUBLIC_ROUTES = [
  '/',
  '/about',
  '/blog',
  '/careers',
  '/changelog',
  '/contact',
  '/developers',
  '/docs',
  '/enterprise',
  '/legal',
  '/marketplace',
  '/pricing',
  '/support',
  '/use-cases',
] as const;

const MARKETING_RECORDS: PublicContentRecord[] = [
  {
    kind: 'marketing',
    slug: 'index',
    title: siteMetadata.title,
    description: siteMetadata.description,
    htmlPath: '/',
    markdownPath: '/markdown/index.md',
  },
  {
    kind: 'marketing',
    slug: 'contact',
    title: 'Contact Kortix',
    description: 'Request a tailored Kortix walkthrough for cloud, VPC, or on-prem deployment.',
    htmlPath: '/contact',
  },
  {
    kind: 'marketing',
    slug: 'about',
    title: 'About Kortix',
    description:
      'We build self-driving companies. Humans verify, steer, and govern while agent teams do work across engineering, product, operations, finance, support, and growth.',
    htmlPath: '/about',
    markdownPath: '/markdown/about.md',
  },
  {
    kind: 'marketing',
    slug: 'legal',
    title: 'Kortix legal',
    description: 'Kortix terms of service and privacy policy.',
    htmlPath: '/legal',
  },
  {
    kind: 'marketing',
    slug: 'marketplace',
    title: 'Kortix Marketplace',
    description:
      'Browse skills, agents, and commands from every source. Add them to a Kortix project in one click.',
    htmlPath: '/marketplace',
  },
  {
    kind: 'marketing',
    slug: 'developers',
    title: 'Kortix for developers',
    description: siteMetadata.description,
    htmlPath: '/developers',
    markdownPath: '/markdown/developers.md',
  },
  {
    kind: 'marketing',
    slug: 'enterprise',
    title: 'Kortix Enterprise',
    description: PRICING_PLANS.find((plan) => plan.id === 'enterprise')?.note,
    htmlPath: '/enterprise',
    markdownPath: '/markdown/enterprise.md',
  },
  {
    kind: 'marketing',
    slug: 'pricing',
    title: 'Kortix pricing',
    description: 'Current plans and included features.',
    htmlPath: '/pricing',
    markdownPath: '/markdown/pricing.md',
  },
  {
    kind: 'marketing',
    slug: 'support',
    title: 'Kortix support',
    description: 'Support resources and contact information for Kortix.',
    htmlPath: '/support',
  },
];

export function getMarketingRecord(htmlPath: string): PublicContentRecord | undefined {
  return MARKETING_RECORDS.find((record) => record.htmlPath === htmlPath);
}

function webContentRoot(): string {
  const direct = path.join(process.cwd(), 'content');
  return fs.existsSync(direct) ? direct : path.join(process.cwd(), 'apps', 'web', 'content');
}

function listFiles(root: string, extension: '.mdx' | '.md'): string[] {
  if (!fs.existsSync(root)) return [];
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else if (entry.isFile() && entry.name.endsWith(extension)) files.push(entryPath);
    }
  };
  visit(root);
  return files.sort();
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function parseFrontmatter(source: string): Record<string, string> {
  const match = /^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/.exec(source);
  if (!match) return {};

  const result: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const field = /^([a-zA-Z][\w-]*):\s*(.*)$/.exec(line);
    if (field && field[2]) result[field[1]] = unquote(field[2]);
  }
  return result;
}

function sourceDocuments(kind: 'docs' | 'use-case'): SourceDocument[] {
  const directory = kind === 'docs' ? 'docs' : 'use-cases';
  const root = path.join(webContentRoot(), directory);

  return listFiles(root, '.mdx').flatMap((sourcePath) => {
    const source = fs.readFileSync(sourcePath, 'utf8');
    const frontmatter = parseFrontmatter(source);
    if (frontmatter.draft === 'true' && process.env.NODE_ENV === 'production') return [];

    const relative = path
      .relative(root, sourcePath)
      .replaceAll(path.sep, '/')
      .replace(/\.mdx$/, '');
    const slug = relative === 'index' ? 'index' : relative.replace(/\/index$/, '');
    const htmlPath =
      kind === 'docs' ? (slug === 'index' ? '/docs' : `/docs/${slug}`) : `/use-cases/${slug}`;
    const markdownPath = `/markdown/${directory}/${slug}.md`;
    return [
      {
        kind,
        slug,
        title: frontmatter.title || slug.split('/').at(-1)?.replaceAll('-', ' ') || slug,
        description: frontmatter.description,
        htmlPath,
        markdownPath,
        lastModified:
          kind === 'use-case' && frontmatter.date ? `${frontmatter.date}T00:00:00.000Z` : undefined,
        sourcePath,
      },
    ];
  });
}

function blogRecords(): PublicContentRecord[] {
  return BLOG_POSTS.filter((post) => process.env.NODE_ENV !== 'production' || !post.draft)
    .map((post) => ({
      kind: 'blog' as const,
      slug: post.slug,
      title: post.title,
      description: post.description,
      htmlPath: `/blog/${post.slug}`,
      markdownPath: `/markdown/blog/${post.slug}.md`,
      lastModified: `${post.date}T00:00:00.000Z`,
    }))
    .sort((a, b) => b.lastModified.localeCompare(a.lastModified));
}

export function areUseCasesPublic(): boolean {
  return process.env.NEXT_PUBLIC_USE_CASES_ENABLED === 'true';
}

export function getPublicContentRecords(
  options: { includeUseCases?: boolean } = {},
): PublicContentRecord[] {
  const includeUseCases = options.includeUseCases ?? areUseCasesPublic();
  return [
    ...MARKETING_RECORDS,
    ...blogRecords(),
    ...sourceDocuments('docs'),
    ...(includeUseCases ? sourceDocuments('use-case') : []),
  ];
}

function blocksToMarkdown(blocks: Block[]): string {
  return blocks
    .map((block) => {
      switch (block.type) {
        case 'lead':
        case 'p':
          return block.text;
        case 'h2':
          return `## ${block.text}`;
        case 'ul':
          return block.items.map((item) => `- ${item}`).join('\n');
        case 'code':
          return `\`\`\`\n${block.code}\n\`\`\``;
        case 'callout':
          return block.text
            .split('\n')
            .map((line) => `> ${line}`)
            .join('\n');
        case 'logos':
          return `${block.label ? `${block.label}\n\n` : ''}${block.items
            .map((item) => `- ${item.name} (${item.domain})`)
            .join('\n')}`;
        case 'verdict':
          return `### Choose ${block.themLabel} if\n\n${block.them}\n\n### Choose Kortix if\n\n${block.kortix}`;
        case 'compare': {
          const escapeCell = (value: string) => value.replaceAll('|', '\\|').replaceAll('\n', ' ');
          return [
            `| Dimension | ${escapeCell(block.them)} | Kortix |`,
            '| --- | --- | --- |',
            ...block.rows.map(
              (row) =>
                `| ${escapeCell(row.dimension)} | ${escapeCell(row.them)} | ${escapeCell(row.kortix)} |`,
            ),
          ].join('\n');
        }
        case 'cta':
          return `## ${block.title}${block.body ? `\n\n${block.body}` : ''}`;
      }
    })
    .join('\n\n');
}

function documentHeader(record: PublicContentRecord): string {
  return [
    `# ${record.title}`,
    record.description,
    `Canonical page: ${CANONICAL_ORIGIN}${record.htmlPath}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

function renderMarketingMarkdown(record: PublicContentRecord): string {
  const links = [
    `- [Documentation](${CANONICAL_ORIGIN}/docs)`,
    `- [Blog](${CANONICAL_ORIGIN}/blog)`,
    `- [Use cases](${CANONICAL_ORIGIN}/use-cases)`,
    `- [GitHub](https://github.com/kortix-ai/suna)`,
  ];

  if (record.slug === 'pricing' || record.slug === 'enterprise') {
    const plans = PRICING_PLANS.filter(
      (plan) => record.slug === 'pricing' || plan.id === 'enterprise',
    ).map(
      (plan) =>
        `## ${plan.name}\n\n${plan.price}${plan.unit ? ` ${plan.unit}` : ''}\n\n${plan.note}\n\n${plan.features
          .map((feature) => `- ${feature}`)
          .join('\n')}`,
    );
    return `${documentHeader(record)}\n\n${plans.join('\n\n')}`;
  }

  return `${documentHeader(record)}\n\n## Official resources\n\n${links.join('\n')}`;
}

export function resolvePublicMarkdown(pathSegments: string[]): {
  record: PublicContentRecord;
  markdown: string;
} | null {
  if (!pathSegments.length) return null;
  const last = pathSegments.at(-1);
  if (!last?.endsWith('.md')) return null;

  const markdownPath = `/markdown/${pathSegments.join('/')}`;
  const record = getPublicContentRecords().find((item) => item.markdownPath === markdownPath);
  if (!record) return null;

  if (record.kind === 'marketing') {
    return { record, markdown: `${renderMarketingMarkdown(record)}\n` };
  }

  if (record.kind === 'blog') {
    const post = BLOG_POSTS.find((item) => item.slug === record.slug);
    if (!post) return null;
    const byline = [
      `Published: ${post.date}`,
      `Author: ${post.author}`,
      `Tags: ${post.tags.join(', ')}`,
    ];
    return {
      record,
      markdown: `${documentHeader(record)}\n\n${byline.join('\n')}\n\n${blocksToMarkdown(post.blocks)}\n`,
    };
  }

  const source = sourceDocuments(record.kind).find((item) => item.markdownPath === markdownPath);
  if (!source) return null;
  return { record, markdown: fs.readFileSync(source.sourcePath, 'utf8').trimEnd() + '\n' };
}

export function absoluteUrl(pathname: string): string {
  return `${CANONICAL_ORIGIN}${pathname === '/' ? '' : pathname}`;
}
