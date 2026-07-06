import Image from 'next/image';
import Link from 'next/link';

import { PostByline } from '@/components/blog/post-byline';
import { KortixAsterisk } from '@/components/ui/kortix-asterisk';
import type { Post } from '@/lib/blog';
import { cn } from '@/lib/utils';

/** Cover image, or a branded gradient field when a use case has none. */
function Cover({ post, className }: { post: Post; className?: string }) {
  if (post.data.cover) {
    return (
      <div className={cn('bg-muted relative overflow-hidden', className)}>
        <Image
          src={post.data.cover}
          alt={post.data.title}
          fill
          className="object-cover transition-transform duration-500 group-hover:scale-[1.03]"
          sizes="(max-width: 768px) 100vw, 768px"
        />
      </div>
    );
  }
  return (
    <div
      className={cn(
        'from-muted/60 via-background to-kortix-base/[0.08] relative overflow-hidden bg-gradient-to-br',
        className,
      )}
    >
      <div className="absolute inset-0 bg-[url('/grain-texture.png')] bg-repeat opacity-[0.12]" />
      <div className="absolute inset-0 flex items-center justify-center">
        <KortixAsterisk index={0} parentClass="size-10" />
      </div>
    </div>
  );
}

export function UseCaseCard({ post, featured = false }: { post: Post; featured?: boolean }) {
  const archetype = post.data.tags[0];

  return (
    <Link
      href={post.url}
      className={cn(
        'group border-border bg-card hover:border-foreground/20 flex flex-col overflow-hidden rounded-sm border transition-colors duration-200',
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
      <div className={cn('flex flex-1 flex-col p-6', featured && 'md:justify-center md:p-10')}>
        {archetype && (
          <div className="text-muted-foreground mb-4 flex items-center gap-2 font-mono text-xs tracking-wider uppercase">
            <KortixAsterisk index={0} parentClass="size-3.5" variant="solid" />
            {archetype}
          </div>
        )}
        <h3
          className={cn(
            'text-foreground font-medium tracking-tight',
            featured ? 'text-2xl leading-tight md:text-3xl' : 'text-lg leading-snug',
          )}
        >
          {post.data.title}
        </h3>
        {post.data.description && (
          <p
            className={cn(
              'text-muted-foreground group-hover:text-foreground/80 mt-3 transition-colors duration-200',
              featured ? 'line-clamp-3 text-base leading-relaxed' : 'line-clamp-2 text-sm',
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
          className={cn('mt-6', featured && 'md:mt-8')}
        />
      </div>
    </Link>
  );
}
