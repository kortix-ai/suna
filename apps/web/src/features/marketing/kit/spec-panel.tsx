import { cn } from '@kortix/ui';

/**
 * A small spec sheet in the code panel's frame (three square window marks,
 * then the title): key on the left, value on the right, one row each.
 */
export function SpecPanel({
  title,
  rows,
  className,
}: {
  title: string;
  rows: readonly { k: string; v: string }[];
  className?: string;
}) {
  return (
    <div className={cn('border-border bg-background flex flex-col rounded-sm border', className)}>
      <div className="border-border flex items-center gap-3 border-b px-4 py-3">
        <span aria-hidden className="flex items-center gap-1.5">
          <span className="bg-primary/80 size-2.5" />
          <span className="bg-primary/50 size-2.5" />
          <span className="bg-primary/30 size-2.5" />
        </span>
        <span className="text-muted-foreground font-mono text-xs">{title}</span>
      </div>
      <dl className="divide-y px-5">
        {rows.map((row) => (
          <div key={row.k} className="grid grid-cols-1 gap-1 py-4 sm:grid-cols-3 sm:gap-4">
            <dt className="text-muted-foreground text-sm">{row.k}</dt>
            <dd className="text-foreground text-sm text-pretty sm:col-span-2">{row.v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
