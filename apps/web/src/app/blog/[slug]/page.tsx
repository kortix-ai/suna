import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { getAllSlugs, getPostBySlug } from '@/lib/blog';

// ─── Static params ────────────────────────────────────────────────────────────

export function generateStaticParams() {
  return getAllSlugs().map((slug) => ({ slug }));
}

// ─── Metadata ─────────────────────────────────────────────────────────────────

export async function generateMetadata(props: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await props.params;
  const post = getPostBySlug(slug);
  if (!post) return {};

  return {
    title: `${post.title} — Kortix Blog`,
    description: post.description,
    openGraph: {
      title: post.title,
      description: post.description,
      type: 'article',
      publishedTime: post.date,
    },
    twitter: {
      card: 'summary_large_image',
      title: post.title,
      description: post.description,
    },
  };
}

// ─── Page ─────────────────────────────────────────────────────────────────────

function formatDate(dateStr: string): string {
  try {
    return new Date(dateStr).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  } catch {
    return dateStr;
  }
}

export default async function BlogPostPage(props: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await props.params;
  const post = getPostBySlug(slug);
  if (!post) notFound();

  // Dynamic import of the MDX file — Next.js + withMDX bundles it as a component
  // The file name on disk may differ from the slug in frontmatter, so try both
  let PostContent: React.ComponentType | null = null;

  try {
    const mod = await import(`../../../../content/blog/${slug}.mdx`);
    PostContent = mod.default;
  } catch {
    try {
      // Try the file slug derived from the MDX slug
      const { getAllSlugs } = await import('@/lib/blog');
      const fileSlugs = getAllSlugs();
      const fileSlug = fileSlugs.find((s) => s === slug || s === post.slug);
      if (fileSlug && fileSlug !== slug) {
        const mod = await import(`../../../../content/blog/${fileSlug}.mdx`);
        PostContent = mod.default;
      }
    } catch {
      PostContent = null;
    }
  }

  if (!PostContent) notFound();

  return (
    <div className="min-h-screen bg-white dark:bg-zinc-950">
      <div className="max-w-2xl mx-auto px-6 py-16">
        {/* Back link */}
        <Link
          href="/blog"
          className="text-sm text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 transition-colors"
        >
          ← Blog
        </Link>

        {/* Post header */}
        <header className="mt-6 mb-10">
          <time className="text-sm text-zinc-400 dark:text-zinc-500">
            {formatDate(post.date)}
          </time>
          <h1 className="mt-2 text-3xl font-bold text-zinc-900 dark:text-zinc-100 leading-tight">
            {post.title}
          </h1>
          {post.description && (
            <p className="mt-3 text-lg text-zinc-500 dark:text-zinc-400 leading-relaxed">
              {post.description}
            </p>
          )}
          {post.author && (
            <p className="mt-2 text-sm text-zinc-400">By {post.author}</p>
          )}
        </header>

        {/* MDX content */}
        <article className="prose prose-zinc dark:prose-invert max-w-none">
          <PostContent />
        </article>

        {/* Footer CTA */}
        <div className="mt-16 pt-8 border-t border-zinc-100 dark:border-zinc-800">
          <p className="text-zinc-600 dark:text-zinc-400">
            <a
              href="https://kortix.com?utm_source=blog&utm_medium=article-footer&utm_campaign=blog-cta"
              target="_blank"
              rel="noopener noreferrer"
              className="font-semibold text-zinc-900 dark:text-zinc-100 hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
            >
              Try Kortix →
            </a>
            {' '}Open source. $20/mo. Works 24/7.
          </p>
        </div>
      </div>
    </div>
  );
}
