import { UserAvatar } from '@/components/ui/user-avatar';
import { InlineMeta } from '@/components/ui/inline-meta';
import { formatPostDate, type Author } from '@/lib/blog';
import { cn } from '@/lib/utils';

/**
 * Author + date + reading time. The full variant heads an article; the compact
 * variant (no role, smaller avatar) sits in list cards.
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
    <div className={cn('flex items-center gap-3', className)}>
      <UserAvatar
        email={author.email}
        name={author.name}
        avatarUrl={author.avatarUrl}
        size={compact ? 'sm' : 'md'}
      />
      <div className="min-w-0">
        <div
          className={cn(
            'font-medium text-foreground',
            compact ? 'text-xs' : 'text-sm',
          )}
        >
          {author.name}
        </div>
        <InlineMeta className={compact ? 'mt-0' : 'mt-0.5'}>
          {!compact && author.role ? author.role : null}
          <time dateTime={date}>{formatPostDate(date)}</time>
          {`${readingTime} min read`}
        </InlineMeta>
      </div>
    </div>
  );
}
