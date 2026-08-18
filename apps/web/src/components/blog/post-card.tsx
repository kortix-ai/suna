import Link from 'next/link';

import { BlogCover } from '@/components/blog/blog-cover';
import { PostByline } from '@/components/blog/post-byline';
import type { Post } from '@/lib/blog';
import { cn } from '@/lib/utils';

/**
 * A post in a listing. Chrome-free by design: the cover carries the only
 * border, and the text sits on the page background. `featured` is the index
 * lead — same parts, wider media, larger type, no second visual language.
 *
 * Only the first tag renders, as a mono eyebrow. Three badges per card was the
 * single biggest source of noise in a grid of nine.
 */
export function PostCard({ post, featured = false }: { post: Post; featured?: boolean }) {
  const topic = post.data.tags[0];

  return (
    <Link
      href={post.url}
      className={cn(
        'group focus-visible:ring-ring flex flex-col rounded-md',
        'focus-visible:ring-offset-background focus-visible:ring-2 focus-visible:ring-offset-4 focus-visible:outline-none',
        featured && 'md:grid md:grid-cols-2 md:items-center md:gap-10 lg:gap-14',
      )}
    >
      <BlogCover
        logos={post.data.coverLogos ?? []}
        withKortix={post.data.coverKortix ?? true}
        className={cn(
          'border-border/60 group-hover:border-border w-full shrink-0 rounded-md border transition-colors',
          featured ? 'aspect-[16/10]' : 'aspect-[16/9]',
        )}
      />

      <div className={cn('flex flex-1 flex-col', featured ? 'mt-6 md:mt-0' : 'mt-4')}>
        {topic && (
          <span className="text-muted-foreground/70 mb-2 font-mono text-xs tracking-wider uppercase">
            {topic}
          </span>
        )}

        {/* The underline is always laid out in `transparent`, so revealing it on
            hover cannot shift the line. */}
        <h3
          className={cn(
            'text-foreground group-hover:decoration-foreground/40 font-medium tracking-tight underline decoration-transparent decoration-1 underline-offset-[3px] transition-colors',
            featured ? 'text-2xl leading-tight md:text-3xl' : 'text-base leading-snug',
          )}
        >
          {post.data.title}
        </h3>

        {post.data.description && (
          <p
            className={cn(
              'text-muted-foreground mt-3 leading-relaxed',
              featured ? 'line-clamp-3 text-base' : 'line-clamp-2 text-sm',
            )}
          >
            {post.data.description}
          </p>
        )}

        <PostByline
          author={post.author}
          date={post.data.date}
          readingTime={post.readingTime}
          compact
          className={cn('mt-5', featured && 'md:mt-6')}
        />
      </div>
    </Link>
  );
}
