import Link from 'fumadocs-core/link';
import type { HTMLAttributes, ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * The docs card grid.
 *
 * Same geometry as the one it replaces (`fumadocs-ui/components/card`): a
 * two-column grid on a container query, so a card in a narrow column can span
 * the full width instead of being squeezed.
 */
export function Cards({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={cn('@container grid grid-cols-2 gap-3', className)} />;
}

export interface CardProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  href?: string;
  external?: boolean;
}

/**
 * One docs card: a glyph in its own column, with the title and the
 * description beside it as one block.
 *
 * This is a local component rather than a restyle of fumadocs' card because
 * that card's chrome is hardcoded in the published package — it wraps the icon
 * in `w-fit shadow-md rounded-lg border bg-fd-muted p-1.5` and stacks it ABOVE
 * the title (`fumadocs-ui/dist/components/card.js`). Nothing reaches those
 * classes from the outside: no prop, and no selector that would not be a guess
 * at someone else's DOM. Reordering the icon and the title is not a styling
 * change at all — it is a different tree.
 *
 * So the glyph is a glyph: muted, `size-4`, level with the title, with no
 * tile, no fill, no border and no shadow around it. A card is a link in a list
 * of links, and the boxed mark made each one read as a button with a badge on
 * it.
 *
 * The card's OWN frame is unchanged from the package's — `rounded-xl border
 * bg-fd-card p-4` with the accent wash on hover — because that part was never
 * the complaint, and the docs grid should keep looking like the docs grid.
 */
export function Card({ icon, title, description, href, external, ...props }: CardProps) {
  const Root = href ? Link : 'div';

  return (
    <Root
      {...props}
      {...(href ? { href, external } : {})}
      data-card
      className={cn(
        // `not-prose`: the card sits inside the docs `.prose` scope, which
        // would otherwise style the heading and the paragraph as body copy.
        'not-prose block rounded-xl border p-4',
        'bg-fd-card text-fd-card-foreground transition-colors',
        href && 'hover:bg-fd-accent/80',
        '@max-lg:col-span-full',
        props.className,
      )}
    >
      {/* One row: the glyph, then everything that is words.
          Title and description live in ONE block beside the icon rather than
          as two siblings under it, so the description wraps under the TITLE
          and not back under the mark — the icon column stays a column. */}
      <div className="flex items-start gap-2.5">
        {/* `mt-0.5` centres a 16px glyph on the 20px first line of the title.
            `shrink-0` and `[&_svg]:size-4`: the words wrap, the mark never
            does, whatever component drew it. */}
        {icon && (
          <span className="text-fd-muted-foreground mt-0.5 flex shrink-0 items-center [&_svg]:size-4 border rounded-md bg-inherti p-2">
            {icon}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <h3 className="m-0 text-sm font-medium">{title}</h3>
          {description && (
            <p className="text-fd-muted-foreground mt-1 mb-0 text-sm">{description}</p>
          )}
          {props.children && (
            <div className="text-fd-muted-foreground prose-no-margin mt-1 text-sm empty:hidden">
              {props.children}
            </div>
          )}
        </div>
      </div>
    </Root>
  );
}
