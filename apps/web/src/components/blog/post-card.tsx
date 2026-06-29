import Link from 'next/link';

import { BlogCover } from '@/components/blog/blog-cover';
import { PostByline } from '@/components/blog/post-byline';
import { Badge } from '@/components/ui/badge';
import type { Post } from '@/lib/blog';
import { cn } from '@/lib/utils';

export function PostCard({ post, featured = false }: { post: Post; featured?: boolean }) {
  return (
    <Link
      href={post.url}
      className={cn(
        'group border-border/60 bg-card hover:border-border flex flex-col overflow-hidden rounded-2xl border transition-colors',
        featured && 'md:flex-row',
      )}
    >
      <BlogCover
        logos={post.data.coverLogos ?? []}
        withKortix={post.data.coverKortix ?? true}
        className={cn(
          'shrink-0',
          featured ? 'aspect-[16/10] md:aspect-auto md:w-1/2' : 'aspect-[16/9]',
        )}
      />
      <div className={cn('flex flex-1 flex-col p-6', featured && 'md:justify-center md:p-8')}>
        {post.data.tags.length > 0 && (
          <div className="mb-3 flex flex-wrap gap-1.5">
            {post.data.tags.slice(0, 3).map((tag) => (
              <Badge key={tag} size="sm" variant="secondary">
                {tag}
              </Badge>
            ))}
          </div>
        )}
        <h3
          className={cn(
            'text-foreground group-hover:text-foreground font-medium tracking-tight transition-colors',
            featured ? 'text-2xl md:text-3xl' : 'text-lg',
          )}
        >
          {post.data.title}
        </h3>
        {post.data.description && (
          <p
            className={cn(
              'text-muted-foreground mt-2',
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
