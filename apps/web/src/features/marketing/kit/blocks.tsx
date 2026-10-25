import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';

/**
 * The Buio content blocks the marketing pages (security, connectors, pricing,
 * enterprise) share. No cards, no radius, no fills: structure comes only from
 * `border-t` hairlines, and there are exactly two text colours.
 */

/** A hairline definition list: the term on the left half, the answer on the right. */
export function Rows({
  rows,
  className,
}: {
  rows: readonly { id?: string; k: ReactNode; v: ReactNode }[];
  className?: string;
}): ReactNode {
  return (
    <dl className={cn('border-border border-b', className)}>
      {rows.map((row, i) => (
        <div
          key={row.id ?? i}
          className="border-border grid grid-cols-1 gap-y-2 border-t py-6 lg:grid-cols-2 lg:items-baseline"
        >
          <dt className="text-foreground text-base font-medium text-pretty lg:pr-8">{row.k}</dt>
          <dd className="text-muted-foreground text-sm text-pretty">{row.v}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Items in columns, each under its own hairline. Pass the column count for `lg`
 * in `className` (`lg:grid-cols-3`). With `n` set the list is a real sequence
 * and renders as an `ol` with its step numbers.
 */
export function Cells({
  items,
  className,
}: {
  items: readonly { id?: string; n?: string; k: ReactNode; meta?: ReactNode; v: ReactNode }[];
  className?: string;
}): ReactNode {
  const List = items[0]?.n ? 'ol' : 'ul';
  return (
    <List className={cn('grid grid-cols-1 sm:grid-cols-2', className)}>
      {items.map((item, i) => (
        <li key={item.id ?? i} className="border-border border-t py-6 sm:pr-8">
          {item.n ? (
            <span className="text-muted-foreground mb-6 block text-sm tabular-nums">{item.n}</span>
          ) : null}
          <h3 className="text-foreground text-base font-medium text-pretty">{item.k}</h3>
          {item.meta ? <p className="text-muted-foreground mt-1 text-sm">{item.meta}</p> : null}
          <p className="text-muted-foreground mt-2 text-sm text-pretty">{item.v}</p>
        </li>
      ))}
    </List>
  );
}

/**
 * A sub-section inside a section (Buio): a hairline, the title in the first of
 * four columns, the content in the other three.
 */
export function SubSection({
  title,
  note,
  children,
}: {
  title: ReactNode;
  note?: ReactNode;
  children: ReactNode;
}): ReactNode {
  return (
    <div className="border-border mt-24 grid grid-cols-1 gap-y-8 border-t pt-8 lg:grid-cols-4">
      <div className="lg:pr-8">
        <h3 className="text-foreground text-base font-medium text-pretty">{title}</h3>
        {note ? <p className="text-muted-foreground mt-2 text-sm text-pretty">{note}</p> : null}
      </div>
      <div className="lg:col-span-3">{children}</div>
    </div>
  );
}

/**
 * Splits a translated headline at its first sentence end, so it renders as the
 * two-tone title (line one ink, line two muted). A one-sentence title stays
 * whole. `SectionHeading` puts a space between the lines, so the heading's
 * accessible name stays a sentence ("Start free. Pay only …"), which the
 * pricing e2e journey reads.
 */
export function splitTitle(title: string): [string, string | undefined] {
  const match = /^(.+?(?:[.!?](?=\s)|[。！？]))\s*(\S.*)$/.exec(title);
  return match ? [match[1], match[2]] : [title, undefined];
}
