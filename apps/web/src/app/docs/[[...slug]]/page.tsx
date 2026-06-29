import { source } from '@/lib/source';
import defaultMdxComponents from 'fumadocs-ui/mdx';
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from 'fumadocs-ui/page';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

export default async function Page(props: { params: Promise<{ slug?: string[] }> }) {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  const MDX = (page.data as any).body;

  return (
    <DocsPage toc={(page.data as any).toc} full={(page.data as any).full}>
      <DocsTitle>{page.data.title}</DocsTitle>
      {page.data.description && <DocsDescription>{page.data.description}</DocsDescription>}
      <DocsBody>
        <MDX components={{ ...defaultMdxComponents }} />
      </DocsBody>
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
  };
}
