import Link from '@/components/site-link';

import { BlogCover } from '@/components/blog/blog-cover';
import { formatPostDate, type Post } from '@/lib/blog';
import { cn } from '@/lib/utils';

/** "Field notes · October 25, 2026": the first tag and the date, muted. */
function PostMeta({ post, className }: { post: Post; className?: string }) {
  const tag = post.data.tags[0];
  return (
    <p className={cn('text-muted-foreground flex items-center gap-2 text-sm', className)}>
      {tag ? (
        <>
          <span className="capitalize">{tag}</span>
          <span aria-hidden>·</span>
        </>
      ) : null}
      <time dateTime={post.data.date}>{formatPostDate(post.data.date)}</time>
    </p>
  );
}

/**
 * The newest post (Polar blog lead): the two-tone title on the left, the
 * headline in ink and the description under it in muted ink at the same size,
 * the cover on the right. The whole block is one link.
 */
export function BlogFeaturedPost({ post }: { post: Post }) {
  return (
    <article>
      <Link
        href={post.url}
        className="group outline-ring grid grid-cols-1 items-center gap-10 rounded-sm focus-visible:outline-2 focus-visible:outline-offset-4 lg:grid-cols-2 lg:gap-16"
      >
        <div className="order-last lg:order-first">
          <h2 className="text-xl font-medium tracking-tight text-balance md:text-2xl">
            <span className="text-foreground">
              {post.data.title}
            </span>
            {post.data.description ? (
              <>
                {' '}
                <span className="text-muted-foreground mt-2 block line-clamp-3">{post.data.description}</span>
              </>
            ) : null}
          </h2>
          <PostMeta post={post} className="mt-8" />
        </div>
        <BlogCover
          logos={post.data.coverLogos ?? []}
          withKortix={post.data.coverKortix ?? true}
          className="aspect-video w-full"
        />
      </Link>
    </article>
  );
}

/** A post in the grid (Polar blog card): a wide cover, the title, then tag and date. */
export function BlogPostCard({ post }: { post: Post }) {
  return (
    <article>
      <Link
        href={post.url}
        className="group outline-ring flex flex-col rounded-sm focus-visible:outline-2 focus-visible:outline-offset-4"
      >
        <BlogCover
          logos={post.data.coverLogos ?? []}
          withKortix={post.data.coverKortix ?? true}
          className="aspect-video w-full"
        />
        <h3 className="text-foreground mt-5 text-base font-medium text-pretty">
          {post.data.title}
        </h3>
        <PostMeta post={post} className="mt-2" />
      </Link>
    </article>
  );
}
