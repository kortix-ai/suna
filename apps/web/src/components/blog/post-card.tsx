import { useTranslations } from 'next-intl';
import Image from 'next/image';
import Link from 'next/link';

import { PostByline } from '@/components/blog/post-byline';
import { Badge } from '@/components/ui/badge';
import type { Post } from '@/lib/blog';
import { cn } from '@/lib/utils';

/** Cover image, or a clean branded gradient when a post has none. */
function Cover({ post, className }: { post: Post; className?: string }) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  if (post.data.cover) {
    return (
      <div className={cn('bg-muted relative overflow-hidden', className)}>
        <Image
          src={post.data.cover}
          alt={post.data.title}
          fill
          className="object-cover transition-transform duration-500 group-hover:scale-[1.03]"
          sizes={tI18nHardcoded.raw('autoComponentsBlogPostCardJsxAttrSizesMaxWidth768pxed275b7f')}
        />
      </div>
    );
  }
  return (
    <div
      className={cn(
        'from-muted/70 via-background to-primary/[0.07] relative overflow-hidden bg-gradient-to-br',
        className,
      )}
    >
      <div className="absolute inset-0 bg-[url('/grain-texture.png')] bg-repeat opacity-[0.12]" />
      <div className="absolute inset-0 flex items-center justify-center">
        <span className="text-muted-foreground/45 text-xs font-medium tracking-[0.25em] uppercase">
          Kortix
        </span>
      </div>
    </div>
  );
}

export function PostCard({ post, featured = false }: { post: Post; featured?: boolean }) {
  return (
    <Link
      href={post.url}
      className={cn(
        'group border-border/60 bg-card hover:border-border flex flex-col overflow-hidden rounded-2xl border transition-colors',
        featured && 'md:flex-row',
      )}
    >
      <Cover
        post={post}
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
