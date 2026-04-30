import type { Metadata } from 'next';
import Link from 'next/link';
import { getAllPosts } from '@/lib/blog';

export const metadata: Metadata = {
  title: 'Blog — Kortix',
  description: 'Thoughts on autonomous AI, the future of work, and building Kortix.',
};

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

export default function BlogIndexPage() {
  const posts = getAllPosts();

  return (
    <div className="min-h-screen bg-white dark:bg-zinc-950">
      <div className="max-w-2xl mx-auto px-6 py-16">
        {/* Header */}
        <div className="mb-12">
          <Link href="/" className="text-sm text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 transition-colors">
            ← Kortix
          </Link>
          <h1 className="mt-4 text-3xl font-bold text-zinc-900 dark:text-zinc-100">Blog</h1>
          <p className="mt-2 text-zinc-500 dark:text-zinc-400">
            Thoughts on autonomous AI, the future of work, and building Kortix.
          </p>
        </div>

        {/* Post list */}
        {posts.length === 0 ? (
          <p className="text-zinc-500">No posts yet.</p>
        ) : (
          <ul className="space-y-8">
            {posts.map((post) => (
              <li key={post.slug}>
                <Link href={`/blog/${post.slug}`} className="group block">
                  <time className="text-sm text-zinc-400 dark:text-zinc-500">
                    {formatDate(post.date)}
                  </time>
                  <h2 className="mt-1 text-xl font-semibold text-zinc-900 dark:text-zinc-100 group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors leading-snug">
                    {post.title}
                  </h2>
                  {post.description && (
                    <p className="mt-1 text-zinc-500 dark:text-zinc-400 text-sm leading-relaxed line-clamp-2">
                      {post.description}
                    </p>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
