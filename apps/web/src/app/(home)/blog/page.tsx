import type { Metadata } from 'next';
import Link from 'next/link';
import { blogSource } from '@/lib/source';
import { ArrowRight } from 'lucide-react';

export const metadata: Metadata = {
  title: 'Blog | Kortix',
  description: 'Perspectives on autonomous AI agents, open-source infrastructure, and building companies that run on Kortix.',
  alternates: {
    canonical: 'https://www.kortix.com/blog',
  },
  openGraph: {
    title: 'Kortix Blog',
    description: 'Perspectives on autonomous AI agents, open-source infrastructure, and building companies that run on Kortix.',
    url: 'https://www.kortix.com/blog',
  },
};

export default function BlogIndexPage() {
  const pages = blogSource.getPages().sort((a, b) => {
    const dateA = (a.data as any).date ? new Date((a.data as any).date).getTime() : 0;
    const dateB = (b.data as any).date ? new Date((b.data as any).date).getTime() : 0;
    return dateB - dateA;
  });

  return (
    <main className="min-h-screen bg-background">
      <div className="max-w-2xl mx-auto px-6 md:px-10 pt-24 md:pt-32 pb-20">
        <div className="mb-12">
          <h1 className="text-3xl font-semibold tracking-tight text-foreground">Blog</h1>
          <p className="mt-2 text-muted-foreground">
            Perspectives on autonomous agents, open-source infrastructure, and AI-operated companies.
          </p>
        </div>

        <div className="flex flex-col divide-y divide-border">
          {pages.map((page) => {
            const data = page.data as any;
            const date = data.date ? new Date(data.date) : null;
            return (
              <Link
                key={page.url}
                href={page.url}
                className="group flex flex-col gap-1.5 py-6 hover:opacity-80 transition-opacity"
              >
                <div className="flex items-center justify-between gap-4">
                  <h2 className="text-base font-medium text-foreground leading-snug">
                    {page.data.title}
                  </h2>
                  <ArrowRight className="size-4 text-muted-foreground shrink-0 group-hover:translate-x-0.5 transition-transform" />
                </div>
                {data.description && (
                  <p className="text-sm text-muted-foreground leading-relaxed line-clamp-2">
                    {data.description}
                  </p>
                )}
                {date && (
                  <time className="text-xs text-muted-foreground/60" dateTime={date.toISOString()}>
                    {date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}
                  </time>
                )}
              </Link>
            );
          })}

          {pages.length === 0 && (
            <p className="text-muted-foreground py-8 text-sm">No posts yet.</p>
          )}
        </div>
      </div>
    </main>
  );
}
