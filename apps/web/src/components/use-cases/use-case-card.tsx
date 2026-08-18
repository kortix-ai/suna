import Image from 'next/image';
import Link from 'next/link';

import { InlineMeta } from '@/components/ui/inline-meta';
import { KortixAsterisk } from '@/components/ui/kortix-asterisk';
import { formatPostDate, type Post } from '@/lib/blog';
import { cn } from '@/lib/utils';
import { USE_CASE_COVERS } from './covers';

/**
 * Cover art with three tiers, most specific first:
 *  1. a custom per-slug cover component (USE_CASE_COVERS) — put anything here;
 *  2. the frontmatter `cover` image;
 *  3. a branded gradient placeholder.
 */
export function UseCaseCover({
  post,
  featured,
  className,
}: {
  post: Post;
  featured?: boolean;
  className?: string;
}) {
  const Custom = USE_CASE_COVERS[post.slug];
  if (Custom) {
    return (
      <div className={cn('bg-muted relative overflow-hidden', className)}>
        <Custom post={post} featured={featured} />
      </div>
    );
  }
  if (post.data.cover) {
    return (
      <div className={cn('bg-muted relative overflow-hidden', className)}>
        <Image
          src={post.data.cover}
          alt={post.data.title}
          fill
          className="object-cover"
          sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
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

/**
 * One entry in the use-case catalog. Deliberately chrome-free: the thumbnail
 * carries the only border on the page, and the text sits directly on the page
 * background. A card border around every cell would double every line the grid
 * already draws with whitespace.
 *
 * No author avatar here — a case study is about the company and the loop, not
 * about who wrote it up. The byline belongs on the article itself.
 */
export function UseCaseCard({ post }: { post: Post }) {
  const archetype = post.data.tags[0];

  return (
    <Link
      href={post.url}
      className={cn(
        'group focus-visible:ring-ring flex flex-col rounded-md',
        'focus-visible:ring-offset-background focus-visible:ring-2 focus-visible:ring-offset-4 focus-visible:outline-none',
      )}
    >
      <UseCaseCover
        post={post}
        className="border-border/60 group-hover:border-border aspect-[4/3] w-full shrink-0 rounded-md border transition-colors"
      />

      <div className="mt-4 flex flex-1 flex-col">
        {archetype && (
          <span className="text-muted-foreground/70 mb-2 font-mono text-xs tracking-wider uppercase">
            {archetype}
          </span>
        )}

        {/* Transparent-by-default underline: the rule is always laid out, so
            revealing it on hover shifts nothing. */}
        <h3 className="text-foreground group-hover:decoration-foreground/40 text-base leading-snug font-medium tracking-tight underline decoration-transparent decoration-1 underline-offset-[3px] transition-colors">
          {post.data.title}
        </h3>

        {post.data.description && (
          <p className="text-muted-foreground mt-2 line-clamp-2 text-sm leading-relaxed">
            {post.data.description}
          </p>
        )}

        <InlineMeta className="mt-4">
          <time dateTime={post.data.date}>{formatPostDate(post.data.date)}</time>
          {`${post.readingTime} min read`}
        </InlineMeta>
      </div>
    </Link>
  );
}
