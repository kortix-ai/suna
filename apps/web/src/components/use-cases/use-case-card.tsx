'use client';

import Image from 'next/image';
import Link from 'next/link';

import { KortixAsterisk } from '@kortix/ui/kortix-asterisk';
import { formatPostDate, type Post } from '@/lib/blog';
import { cn } from '@kortix/ui';
import { USE_CASE_COVERS } from './covers';

/**
 * Cover art with three tiers, most specific first:
 *  1. a custom per-slug cover component (USE_CASE_COVERS) — put anything here;
 *  2. the frontmatter `cover` image;
 *  3. a plain muted tile with the asterisk.
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
    <div className={cn('bg-muted relative flex items-center justify-center', className)}>
      <KortixAsterisk index={0} parentClass="size-10" />
    </div>
  );
}

/** "Finance · October 25, 2026": the archetype and the date, muted. */
function UseCaseMeta({ post, className }: { post: Post; className?: string }) {
  const archetype = post.data.tags[0];
  return (
    <p className={cn('text-muted-foreground flex items-center gap-2 text-sm', className)}>
      {archetype ? (
        <>
          <span>{archetype}</span>
          <span aria-hidden>·</span>
        </>
      ) : null}
      <time dateTime={post.data.date}>{formatPostDate(post.data.date)}</time>
    </p>
  );
}

/**
 * The lead use case (Polar blog lead, as on /blog): the two-tone title on the
 * left, the title in ink and the description under it in muted ink at the
 * same size, the cover on the right. The whole block is one link.
 */
export function UseCaseFeatured({ post }: { post: Post }) {
  return (
    <Link
      href={post.url}
      className="outline-ring grid grid-cols-1 items-center gap-10 rounded-sm focus-visible:outline-2 focus-visible:outline-offset-4 lg:grid-cols-2 lg:gap-16"
    >
      <div className="order-last lg:order-first">
        <h2 className="text-xl font-medium tracking-tight text-balance md:text-2xl">
          <span className="text-foreground">{post.data.title}</span>
          {post.data.description ? (
            <>
              {' '}
              <span className="text-muted-foreground mt-2 block line-clamp-3">{post.data.description}</span>
            </>
          ) : null}
        </h2>
        <UseCaseMeta post={post} className="mt-8" />
      </div>
      <UseCaseCover post={post} featured className="aspect-video w-full" />
    </Link>
  );
}

/**
 * One entry in the use-case catalog (Polar blog card, as on /blog): a wide
 * cover, the title, then archetype and date. The whole card is the link; the
 * title keeps its colour on hover.
 */
export function UseCaseCard({ post }: { post: Post }) {
  return (
    <Link
      href={post.url}
      className="outline-ring flex flex-col rounded-sm focus-visible:outline-2 focus-visible:outline-offset-4"
    >
      <UseCaseCover post={post} className="aspect-video w-full shrink-0" />
      <h3 className="text-foreground mt-5 text-base font-medium text-pretty">{post.data.title}</h3>
      <UseCaseMeta post={post} className="mt-2" />
    </Link>
  );
}
