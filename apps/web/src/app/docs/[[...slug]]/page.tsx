import { docsMdxComponents } from '@/components/markdown/docs-mdx-components';
import { socialMetadata } from '@/lib/seo/metadata';
import { CANONICAL_ORIGIN } from '@/lib/site-metadata';
import { source } from '@/lib/source';
import { cn } from '@/lib/utils';
// Server components import icons from '@/lib/icons/ssr': phosphor's
// context-free SSR entry defaults to weight "regular" and silently ignores
// DEFAULT_ICON_WEIGHT (see ssr.tsx's docblock). The client-only brand marks
// under '@/features/icon/icons/*' stay inside 'use client' surfaces like
// docs-page-actions.tsx, which picks its own GitHub mark for its actions.
import { CaretLeftIcon as ChevronLeft, CaretRightIcon as ChevronRight } from '@/lib/icons/ssr';
import { getBreadcrumbItems } from 'fumadocs-core/breadcrumb';
import { findNeighbour } from 'fumadocs-core/page-tree';
import { Accordion, Accordions } from 'fumadocs-ui/components/accordion';
import { Card, Cards } from 'fumadocs-ui/components/card';
import { Step, Steps } from 'fumadocs-ui/components/steps';
import { Tab, Tabs } from 'fumadocs-ui/components/tabs';
import defaultMdxComponents from 'fumadocs-ui/mdx';
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from 'fumadocs-ui/page';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Fragment } from 'react';

import { DocsPageActions } from '../docs-page-actions';

export default async function Page(props: { params: Promise<{ slug?: string[] }> }) {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  const MDX = (page.data as any).body;
  const tree = source.getPageTree();
  const { previous, next } = findNeighbour(tree, page.url);
  const breadcrumbs = getBreadcrumbItems(page.url, tree);
  // `page.path` is the loader's virtualized path relative to the content
  // directory (e.g. `sdk/getting-started.mdx`).
  const editUrl = `https://github.com/kortix-ai/suna/blob/main/apps/web/content/docs/${page.path}`;
  // Same derivation as `sourceDocuments()` in `@/lib/seo/public-content.ts`:
  // strip the `.mdx` extension, then collapse a nested `<dir>/index` down to
  // `<dir>` (a bare `index` — the docs root — has no leading slash to strip,
  // so it passes through unchanged). `/markdown/[...path]/route.ts` 404s on
  // anything that doesn't match a `sourceDocuments('docs')` record exactly.
  const markdownSlug = page.path.replace(/\.mdx$/, '').replace(/\/index$/, '');
  const markdownPath = `/markdown/docs/${markdownSlug}.md`;
  const pageUrl = `${CANONICAL_ORIGIN}${page.url}`;

  return (
    <DocsPage
      toc={(page.data as any).toc}
      full={(page.data as any).full}
      tableOfContent={{ style: 'clerk' }}
      footer={{ enabled: false }}
      breadcrumb={{
        // Replaces the built-in breadcrumb to render the section trail in this
        // app's type and spacing. It used to also carry the "Edit on GitHub"
        // link on the right; that now lives in DocsPageActions below the
        // description, so this row is the trail and nothing else.
        component: (
          <div className="flex flex-row items-center gap-4">
            <span className="text-fd-muted-foreground flex min-w-0 items-center gap-1.5 text-sm">
              {breadcrumbs.map((item, i) => {
                const itemClassName = cn(
                  'truncate',
                  i === breadcrumbs.length - 1 && 'text-fd-primary font-medium',
                );
                return (
                  <Fragment key={item.url ?? `${item.name}`}>
                    {i !== 0 && <ChevronRight className="size-3.5 shrink-0" />}
                    {item.url ? (
                      <Link
                        href={item.url}
                        className={cn(itemClassName, 'transition-opacity hover:opacity-80')}
                      >
                        {item.name}
                      </Link>
                    ) : (
                      <span className={itemClassName}>{item.name}</span>
                    )}
                  </Fragment>
                );
              })}
            </span>
          </div>
        ),
      }}
    >
      <div className="space-y-6">
        <div className="space-y-2">
          <DocsTitle>{page.data.title}</DocsTitle>
          {page.data.description && (
            <DocsDescription className="mb-2">{page.data.description}</DocsDescription>
          )}
        </div>
        <DocsPageActions markdownPath={markdownPath} githubUrl={editUrl} pageUrl={pageUrl} />
      </div>
      <DocsBody className="text-[15px]">
        <MDX
          components={{
            ...defaultMdxComponents,
            // App-parity styling (unified-markdown look) — overrides the
            // default pre/img/headings/a while keeping fumadocs' named blocks.
            ...docsMdxComponents,
            // Rich MDX building blocks available to all docs content.
            // (Callout comes from docsMdxComponents — restyled shadowless there.)
            Accordion,
            Accordions,
            Card,
            Cards,
            Step,
            Steps,
            Tab,
            Tabs,
          }}
        />
      </DocsBody>
      {(previous || next) && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {previous && (
            <Link
              href={previous.url}
              className="hover:bg-fd-accent flex flex-col gap-1 rounded-lg border p-4 transition-colors"
            >
              <span className="text-fd-muted-foreground inline-flex items-center gap-1 text-xs">
                <ChevronLeft className="size-3.5" />
                Previous
              </span>
              <span className="text-sm font-medium">{previous.name}</span>
            </Link>
          )}
          {next && (
            <Link
              href={next.url}
              className="hover:bg-fd-accent flex flex-col items-end gap-1 rounded-lg border p-4 text-right transition-colors sm:col-start-2"
            >
              <span className="text-fd-muted-foreground inline-flex items-center gap-1 text-xs">
                Next
                <ChevronRight className="size-3.5" />
              </span>
              <span className="text-sm font-medium">{next.name}</span>
            </Link>
          )}
        </div>
      )}
    </DocsPage>
  );
}

export function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata(props: {
  params: Promise<{ slug?: string[] }>;
}): Promise<Metadata> {
  const { slug } = await props.params;
  const page = source.getPage(slug);
  if (!page) return {};

  // `absolute` opts out of the root `%s | Kortix` template so the title never
  // doubles up. The docs index frontmatter title is "Kortix", so collapse that
  // case to just "Kortix Docs" instead of "Kortix | Kortix Docs | Kortix".
  const pageTitle = page.data.title?.trim();
  const title =
    pageTitle && pageTitle.toLowerCase() !== 'kortix'
      ? `${pageTitle} – Kortix Docs`
      : 'Kortix Docs';

  const description = page.data.description ?? 'Kortix developer documentation.';
  const url = `${CANONICAL_ORIGIN}${page.url}`;
  return {
    title: { absolute: title },
    description,
    alternates: { canonical: url },
    ...socialMetadata(title, description, url),
  };
}
