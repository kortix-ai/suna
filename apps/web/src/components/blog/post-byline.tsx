import { PostAuthorAvatar } from '@/components/blog/post-author-avatar';
import { InlineMeta } from '@/components/ui/inline-meta';
import { formatPostDate, type Author } from '@/lib/blog';
import { cn } from '@/lib/utils';

/**
 * Author + date + reading time. The full variant heads an article and gets a
 * size-10 avatar plus the author's role; the compact variant sits at the foot
 * of a list card, where a size-6 avatar keeps it a meta line rather than a
 * second focal point.
 */
export function PostByline({
  author,
  date,
  readingTime,
  compact = false,
  className,
}: {
  author: Author;
  date: string;
  readingTime: number;
  compact?: boolean;
  className?: string;
}) {
  return (
    <div className={cn('flex items-center', compact ? 'gap-2.5' : 'gap-3', className)}>
      <PostAuthorAvatar author={author} size={compact ? 'sm' : 'lg'} />
      {compact ? (
        // One line in cards: the author's name reads as the first meta item, so
        // it shares the separator rhythm instead of stacking a second row.
        <InlineMeta className="min-w-0">
          <span className="text-foreground/80 font-medium">{author.name}</span>
          <time dateTime={date}>{formatPostDate(date)}</time>
          {`${readingTime} min read`}
        </InlineMeta>
      ) : (
        <div className="min-w-0">
          <div className="text-foreground text-sm font-medium">{author.name}</div>
          <InlineMeta className="mt-0.5">
            {author.role ? author.role : null}
            <time dateTime={date}>{formatPostDate(date)}</time>
            {`${readingTime} min read`}
          </InlineMeta>
        </div>
      )}
    </div>
  );
}
