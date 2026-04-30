import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { blogSource } from '@/lib/source';
import defaultMdxComponents from 'fumadocs-ui/mdx';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';

export async function generateStaticParams() {
  return blogSource.getPages().map((page) => ({
    slug: page.slugs[0] ?? page.slugs.join('/'),
  }));
}

export async function generateMetadata(props: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await props.params;
  const page = blogSource.getPage([slug]);
  if (!page) return {};

  const data = page.data as any;
  const title = `${page.data.title} | Kortix`;
  const description = data.description ?? 'Kortix — the autonomous company operating system.';
  const canonical = `https://www.kortix.com/blog/${slug}`;

  return {
    title,
    description,
    alternates: { canonical },
    openGraph: {
      title,
      description,
      url: canonical,
      type: 'article',
      publishedTime: data.date ? new Date(data.date).toISOString() : undefined,
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
    },
  };
}

export default async function BlogPostPage(props: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await props.params;
  const page = blogSource.getPage([slug]);
  if (!page) notFound();

  const data = page.data as any;
  const MDX = data.body;
  const date = data.date ? new Date(data.date) : null;

  return (
    <main className="min-h-screen bg-background">
      <article className="max-w-2xl mx-auto px-6 md:px-10 pt-24 md:pt-32 pb-20">
        {/* Back link */}
        <Link
          href="/blog"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-10"
        >
          <ArrowLeft className="size-3.5" />
          Blog
        </Link>

        {/* Header */}
        <header className="mb-10">
          {date && (
            <time
              className="text-xs text-muted-foreground/60 block mb-3"
              dateTime={date.toISOString()}
            >
              {date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}
            </time>
          )}
          <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight text-foreground leading-tight">
            {page.data.title}
          </h1>
          {data.description && (
            <p className="mt-3 text-lg text-muted-foreground leading-relaxed">
              {data.description}
            </p>
          )}
        </header>

        <hr className="border-border mb-10" />

        {/* Body */}
        <div className="prose prose-sm prose-neutral dark:prose-invert max-w-none prose-headings:font-semibold prose-headings:tracking-tight prose-a:text-foreground prose-a:underline prose-a:underline-offset-2 prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-sm prose-code:font-normal prose-pre:bg-muted prose-pre:border prose-pre:border-border">
          <MDX components={{ ...defaultMdxComponents }} />
        </div>

        <hr className="border-border mt-14 mb-8" />

        {/* Footer CTA */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <p className="text-sm text-muted-foreground">
            Kortix is open source.{' '}
            <a
              href="https://github.com/kortix-ai/suna"
              target="_blank"
              rel="noopener noreferrer"
              className="text-foreground underline underline-offset-2"
            >
              GitHub
            </a>
            {' · '}
            <a
              href="https://kortix.com"
              className="text-foreground underline underline-offset-2"
            >
              kortix.com
            </a>
          </p>
          <Link
            href="/blog"
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="size-3.5" />
            All posts
          </Link>
        </div>
      </article>
    </main>
  );
}
