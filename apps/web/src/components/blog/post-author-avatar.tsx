import { KortixLogo } from '@/components/ui/kortix-logo';
import { UserAvatar, type UserAvatarSize } from '@/components/ui/user-avatar';
import type { Author } from '@/lib/blog';
import { cn } from '@/lib/utils';

/**
 * Tile geometry mirrors `SIZE_MAP` in `<UserAvatar>` so a Kortix byline and a
 * human byline line up on the same baseline in the same list.
 *
 * The symbol is set to roughly 55% of the tile — the Kortix mark is an open
 * asterisk with no bounding shape, so it needs more clear space than a glyph
 * of initials to avoid reading as a smudge at size-6.
 */
const TILE: Record<UserAvatarSize, { box: string; mark: number }> = {
  xs: { box: 'size-5', mark: 11 },
  sm: { box: 'size-6', mark: 13 },
  md: { box: 'size-8', mark: 17 },
  lg: { box: 'size-10', mark: 21 },
  xl: { box: 'size-14', mark: 30 },
};

/**
 * The avatar beside a post byline.
 *
 * Kortix-authored posts get the Kortix symbol on a solid brand tile; everyone
 * else falls through to `<UserAvatar>`. Without this, `initialsFromIdentity`
 * reduces "The Kortix Team" to first-word + last-word initials — "TT" — which
 * drops the only word that identifies the brand.
 */
export function PostAuthorAvatar({
  author,
  size = 'md',
  className,
}: {
  author: Author;
  size?: UserAvatarSize;
  className?: string;
}) {
  if (!author.isKortix) {
    return (
      <UserAvatar
        email={author.email}
        name={author.name}
        avatarUrl={author.avatarUrl}
        size={size}
        className={className}
      />
    );
  }

  const tile = TILE[size] ?? TILE.md;

  return (
    <span
      // `bg-foreground`/`text-background` inverts with the theme, so the mark
      // stays legible in light and dark without a `dark:` override. The logo
      // itself is `currentColor`.
      className={cn(
        'bg-foreground text-background flex shrink-0 items-center justify-center rounded-sm',
        tile.box,
        className,
      )}
      role="img"
      aria-label={author.name}
    >
      <KortixLogo variant="icon" size={tile.mark} />
    </span>
  );
}
