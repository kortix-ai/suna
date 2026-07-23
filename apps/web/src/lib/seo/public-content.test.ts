import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { GET as getMarkdown } from '@/app/(public)/markdown/[...path]/route';
import { GET as getAgentIndex } from '@/app/(system)/api/ai/route';
import { GET as getLlmsFullTxt } from '@/app/llms-full.txt/route';
import { GET as getLlmsTxt } from '@/app/llms.txt/route';
import sitemap from '@/app/sitemap';
import { SEO_COVERAGE_MANIFEST } from '@/lib/seo/coverage-manifest';
import { renderLlmsTxt } from '@/lib/seo/llms';
import {
  absoluteUrl,
  getPublicContentRecords,
  renderPlainMarkdownFromMdx,
  resolvePublicMarkdown,
} from '@/lib/seo/public-content';
import { resetAiIndexRateLimitsForTests } from '@/lib/seo/rate-limit';
import { markdownResponse } from '@/lib/seo/response';
import { CANONICAL_ORIGIN } from '@/lib/site-metadata';

const originalUseCases = process.env.NEXT_PUBLIC_USE_CASES_ENABLED;
const UNRESOLVED_MDX_COMPONENT =
  /<\/?(?:Callout|Card|Cards|Fact|Figure|KeyFacts|Stat|StatGrid|Step|Steps)\b/;
const LINE_START_UNRESOLVED_JSX = /^\s*(?:>\s*)?(?:[-*]\s*)?<\/?[A-Z][A-Za-z0-9_.]*(?:\s|>|\/)/m;

function withoutFencedCode(markdown: string): string {
  return markdown.replace(/(^|\n)(```|~~~)[\s\S]*?(\n\2)(?=\n|$)/g, '\n');
}

function expectCleanAgentMarkdown(markdown: string, label: string): void {
  const prose = withoutFencedCode(markdown);
  expect(prose, label).not.toMatch(/^---/m);
  expect(prose, label).not.toMatch(/^\s*(?:import|export)\s/m);
  expect(prose, label).not.toMatch(UNRESOLVED_MDX_COMPONENT);
  expect(prose, label).not.toMatch(LINE_START_UNRESOLVED_JSX);
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_USE_CASES_ENABLED = 'true';
  resetAiIndexRateLimitsForTests();
});

afterEach(() => {
  if (originalUseCases === undefined) delete process.env.NEXT_PUBLIC_USE_CASES_ENABLED;
  else process.env.NEXT_PUBLIC_USE_CASES_ENABLED = originalUseCases;
});

describe('public SEO/AEO content coverage', () => {
  test('uses one non-www canonical origin and no hardcoded canonical tag', () => {
    expect(CANONICAL_ORIGIN).toBe(SEO_COVERAGE_MANIFEST.canonicalOrigin);
    const appRoot = path.join(process.cwd(), 'src', 'app');
    const files = fs
      .readdirSync(appRoot, { recursive: true })
      .filter((file): file is string => typeof file === 'string')
      .filter((file) => /\.(tsx?|jsx?)$/.test(file));
    const source = files
      .map((file) => fs.readFileSync(path.join(appRoot, file), 'utf8'))
      .join('\n');
    expect(source).not.toContain('https://www.kortix.com');
    expect(source).not.toMatch(/<link\s+rel=["']canonical["']/);
  });

  test('maps every source-backed document to unique HTML and Markdown URLs', () => {
    const records = getPublicContentRecords({ includeUseCases: true });
    const markdownRecords = records.filter((record) => record.markdownPath);
    expect(new Set(records.map((record) => record.htmlPath)).size).toBe(records.length);
    expect(new Set(markdownRecords.map((record) => record.markdownPath)).size).toBe(
      markdownRecords.length,
    );

    const counts = Object.fromEntries(
      SEO_COVERAGE_MANIFEST.markdownFamilies.map((kind) => [
        kind,
        markdownRecords.filter((record) => record.kind === kind).length,
      ]),
    );
    for (const kind of SEO_COVERAGE_MANIFEST.markdownFamilies)
      expect(counts[kind]).toBeGreaterThan(0);

    for (const record of markdownRecords) {
      const pathSegments = record.markdownPath!.replace(/^\/markdown\//, '').split('/');
      const resolved = resolvePublicMarkdown(pathSegments);
      expect(resolved?.record.htmlPath).toBe(record.htmlPath);
      expect(resolved?.markdown.length).toBeGreaterThan(20);
    }
  });

  test('serves Markdown inline as crawlable UTF-8 Markdown', async () => {
    const record = getPublicContentRecords({ includeUseCases: true }).find(
      (item) => item.kind === 'blog' && item.markdownPath,
    );
    expect(record).toBeDefined();
    const resolved = resolvePublicMarkdown(
      record!.markdownPath!.replace(/^\/markdown\//, '').split('/'),
    )!;
    const response = markdownResponse(resolved.markdown, resolved.record);

    for (const [header, value] of Object.entries(SEO_COVERAGE_MANIFEST.requiredMarkdownHeaders)) {
      expect(response.headers.get(header)).toBe(value);
    }
    expect(response.headers.get('Link')).toContain(
      `<${absoluteUrl(record!.htmlPath)}>; rel="canonical"`,
    );

    const routeResponse = await getMarkdown(
      new Request(absoluteUrl(record!.markdownPath!), {
        headers: { 'user-agent': 'ChatGPT-User/1.0' },
      }),
      {
        params: Promise.resolve({
          path: record!.markdownPath!.replace(/^\/markdown\//, '').split('/'),
        }),
      },
    );
    expect(routeResponse.status).toBe(200);
    expect(routeResponse.headers.get('Content-Type')).toBe('text/markdown; charset=utf-8');
    expect(await routeResponse.text()).toContain(`# ${record!.title}`);
  });

  test('markdown responses carry a token-budget hint', () => {
    const record = getPublicContentRecords()[0];
    const response = markdownResponse('# Title\n\nBody text.\n', record);
    expect(Number(response.headers.get('x-markdown-tokens'))).toBeGreaterThan(0);
  });

  test('renders MDX source documents as clean agent-readable Markdown', () => {
    const resolved = resolvePublicMarkdown(['docs', 'index.md']);
    expect(resolved?.markdown).toContain('Create a project, start a session, and merge your first change request');
    expect(resolved?.markdown).toContain('- [Quickstart](/docs/quickstart)');
    expectCleanAgentMarkdown(resolved!.markdown, '/markdown/docs/index.md');

    const mdx = `---
title: Sample
---

import { Callout } from 'fumadocs-ui/components/callout';

<Callout type="warn" title="Keep this warning">
  Do not drop this meaningful content.
</Callout>

<Figure caption="A truthful diagram" aspect="16/9" />

<StatGrid>
  <Stat value="3 systems" label="One agent" />
</StatGrid>
`;
    const markdown = renderPlainMarkdownFromMdx(mdx);
    expect(markdown).toContain('> **Keep this warning**');
    expect(markdown).toContain('> Do not drop this meaningful content.');
    expect(markdown).toContain('> Figure: A truthful diagram');
    expect(markdown).toContain('- **3 systems:** One agent');
    expectCleanAgentMarkdown(markdown, 'fixture');
  });

  test('all public Markdown outputs contain no unresolved MDX module syntax or JSX', () => {
    const records = getPublicContentRecords({ includeUseCases: true }).filter(
      (record) => record.markdownPath,
    );
    expect(records.length).toBeGreaterThan(0);

    for (const record of records) {
      const resolved = resolvePublicMarkdown(
        record.markdownPath!.replace(/^\/markdown\//, '').split('/'),
      );
      expect(resolved).toBeDefined();
      expectCleanAgentMarkdown(resolved!.markdown, record.markdownPath!);
    }
  });

  test('puts every public HTML and Markdown representation in the sitemap', () => {
    const urls = new Set(sitemap().map((entry) => entry.url));
    const records = getPublicContentRecords({ includeUseCases: true });
    for (const record of records) {
      expect(urls.has(absoluteUrl(record.htmlPath))).toBe(true);
      if (record.markdownPath) expect(urls.has(absoluteUrl(record.markdownPath))).toBe(true);
    }
    expect(
      [...urls].every((url) => url.startsWith(CANONICAL_ORIGIN) && !url.includes('www.')),
    ).toBe(true);
    expect(urls.has(absoluteUrl('/llms.txt'))).toBe(true);
    expect(urls.has(absoluteUrl('/llms-full.txt'))).toBe(true);
  });

  test('publishes llms indexes with all Markdown URLs and required headers', async () => {
    const llms = renderLlmsTxt();
    for (const record of getPublicContentRecords({ includeUseCases: true })) {
      if (record.markdownPath) expect(llms).toContain(absoluteUrl(record.markdownPath));
    }

    for (const response of [getLlmsTxt(), getLlmsFullTxt()]) {
      expect(response.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
      expect(response.headers.get('Content-Disposition')).toBe('inline');
      expect((await response.text()).length).toBeGreaterThan(1_000);
    }
  });
});

describe('bounded public agent index', () => {
  test('paginates a metadata-only index and clamps page size', async () => {
    const first = getAgentIndex(
      new Request('https://kortix.com/api/ai?limit=999', { headers: { 'x-real-ip': '192.0.2.1' } }),
    );
    expect(first.status).toBe(200);
    expect(first.headers.get('Cache-Control')).toContain('s-maxage=300');
    expect(first.headers.get('X-Robots-Tag')).toBe('noindex, follow');
    const body = (await first.json()) as any;
    expect(body.pagination.limit).toBe(SEO_COVERAGE_MANIFEST.maximumAgentApiPageSize);
    expect(body.data.length).toBeLessThanOrEqual(SEO_COVERAGE_MANIFEST.maximumAgentApiPageSize);
    expect(body.data[0]).not.toHaveProperty('content');
    expect(body.data[0].url).toStartWith(CANONICAL_ORIGIN);

    if (body.pagination.next_cursor) {
      const second = getAgentIndex(
        new Request(`https://kortix.com/api/ai?limit=999&cursor=${body.pagination.next_cursor}`, {
          headers: { 'x-real-ip': '192.0.2.1' },
        }),
      );
      expect(second.status).toBe(200);
      const secondBody = (await second.json()) as any;
      expect(secondBody.data[0]?.url).not.toBe(body.data[0].url);
    }
  });

  test('orders the index recency-first so freshest content leads each kind', async () => {
    const response = getAgentIndex(
      new Request('https://kortix.com/api/ai?kind=blog&limit=999', {
        headers: { 'x-real-ip': '192.0.2.4' },
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    const dates: string[] = body.data
      .map((item: any) => item.last_modified)
      .filter((value: any) => typeof value === 'string');
    expect(dates.length).toBeGreaterThan(1);
    // Blog records are recency-desc by last_modified.
    for (let index = 1; index < dates.length; index += 1) {
      expect(dates[index - 1] >= dates[index]).toBe(true);
    }
    // In the unfiltered index, no dated record ever follows an undated one.
    const unfiltered = getAgentIndex(
      new Request('https://kortix.com/api/ai?limit=999', { headers: { 'x-real-ip': '192.0.2.5' } }),
    );
    const unfilteredBody = (await unfiltered.json()) as any;
    let sawUndated = false;
    for (const item of unfilteredBody.data as any[]) {
      if (!item.last_modified) sawUndated = true;
      else expect(sawUndated).toBe(false);
    }
  });

  test('stamps docs and marketing records with a git-derived last_modified when the build manifest is present', async () => {
    // The manifest is generated by scripts/build-content-timestamps.mjs (wired
    // into next.config.ts) from the most recent git commit on each source
    // file. When present, every docs and marketing record — which previously
    // had null last_modified — should carry a real ISO timestamp so
    // recency-aware AEO retrievers no longer deprioritize 42% of the index.
    const manifestPath = path.join(
      process.cwd(),
      'src',
      'lib',
      'seo',
      'content-timestamps.json',
    );
    const hasManifest = fs.existsSync(manifestPath);
    if (!hasManifest) {
      // Fresh clone / test run without a prior build — skip rather than fail;
      // the graceful fallback to undefined is the documented prior behavior.
      console.warn(
        '[public-content.test] content-timestamps.json absent; skipping docs/marketing last_modified assertion (run `node scripts/build-content-timestamps.mjs` to generate).',
      );
      return;
    }

    const records = getPublicContentRecords({ includeUseCases: true });
    const docs = records.filter((record) => record.kind === 'docs');
    const marketing = records.filter((record) => record.kind === 'marketing');
    expect(docs.length).toBeGreaterThan(0);
    expect(marketing.length).toBeGreaterThan(0);

    // Every docs record should carry a non-null ISO 8601 last_modified.
    for (const record of docs) {
      expect(record.lastModified, `docs:${record.slug}`).toBeTruthy();
      expect(typeof record.lastModified).toBe('string');
      expect(record.lastModified).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
    // Every marketing record should carry a non-null ISO 8601 last_modified.
    for (const record of marketing) {
      expect(record.lastModified, `marketing:${record.slug}`).toBeTruthy();
      expect(typeof record.lastModified).toBe('string');
      expect(record.lastModified).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }

    // The recency-first sort should now surface docs and marketing records
    // among the dated set, not just blog + use-case. Sample the max page size
    // (50): a docs-wide refresh can legitimately stamp every docs page with
    // the same day, filling a 25-item page with docs alone.
    const unfiltered = getAgentIndex(
      new Request('https://kortix.com/api/ai?limit=50', { headers: { 'x-real-ip': '192.0.2.6' } }),
    );
    const unfilteredBody = (await unfiltered.json()) as any;
    const types = new Set((unfilteredBody.data as any[]).map((item) => item.type));
    expect(types.has('docs')).toBe(true);
    expect(types.has('marketing')).toBe(true);
  });

  test('rejects malformed pagination and enforces the documented rate limit', async () => {
    const invalid = getAgentIndex(
      new Request('https://kortix.com/api/ai?cursor=not-valid!', {
        headers: { 'x-real-ip': '192.0.2.2' },
      }),
    );
    expect(invalid.status).toBe(400);

    let response = invalid;
    for (let index = 0; index <= 120; index += 1) {
      response = getAgentIndex(
        new Request('https://kortix.com/api/ai', { headers: { 'x-real-ip': '192.0.2.3' } }),
      );
    }
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBeTruthy();
  });

  test('robots explicitly allows the machine-readable routes', () => {
    const robots = fs.readFileSync(path.join(process.cwd(), 'public', 'robots.txt'), 'utf8');
    for (const route of SEO_COVERAGE_MANIFEST.machineRoutes) {
      expect(robots).toContain(`Allow: ${route}`);
    }
    expect(robots).toContain('Allow: /markdown/');
  });
});
