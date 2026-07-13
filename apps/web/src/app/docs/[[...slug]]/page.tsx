import { docsMdxComponents } from '@/components/markdown/docs-mdx-components';
import { Button } from '@/components/ui/button';
import { Icon } from '@/features/icon/icon';
import { CANONICAL_ORIGIN } from '@/lib/site-metadata';
import { source } from '@/lib/source';
import { cn } from '@/lib/utils';
import { getBreadcrumbItems } from 'fumadocs-core/breadcrumb';
import { findNeighbour } from 'fumadocs-core/server';
import { Accordion, Accordions } from 'fumadocs-ui/components/accordion';
import { Card, Cards } from 'fumadocs-ui/components/card';
import { Step, Steps } from 'fumadocs-ui/components/steps';
import { Tab, Tabs } from 'fumadocs-ui/components/tabs';
import defaultMdxComponents from 'fumadocs-ui/mdx';
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from 'fumadocs-ui/page';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Fragment } from 'react';

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

  return (
    <DocsPage
      toc={(page.data as any).toc}
      full={(page.data as any).full}
      tableOfContent={{ style: 'clerk' }}
      footer={{ enabled: false }}
      breadcrumb={{
        // Replaces the built-in breadcrumb so the same row can carry the
        // edit link: section trail on the left, "Edit on GitHub" on the right.
        component: (
          <div className="flex flex-row items-center justify-between gap-4">
            <span className="text-fd-muted-foreground flex min-w-0 items-center gap-1.5 text-sm">
              {breadcrumbs.map((item, i) => {
                const itemClassName = cn(
                  'truncate',
                  i === breadcrumbs.length - 1 && 'text-fd-primary font-medium',
                );
                return (
                  <Fragment key={i}>
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
            <Button asChild variant="outline" size="xs" className="shrink-0 gap-1.5">
              <a href={editUrl} target="_blank" rel="noreferrer noopener">
                <Icon.Github className="size-3.5" />
                Edit on GitHub
              </a>
            </Button>
          </div>
        ),
      }}
    >
      <DocsTitle>{page.data.title}</DocsTitle>
      {page.data.description && <DocsDescription>{page.data.description}</DocsDescription>}
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

  return {
    title: { absolute: title },
    description: page.data.description ?? 'Kortix developer documentation.',
    alternates: { canonical: `${CANONICAL_ORIGIN}${page.url}` },
  };
}
