import { cn } from '@kortix/ui';

/** A page header: a serif title, one line of context, actions on the right. */
export function PageHeader({ title, description, actions, className }: {
  title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode; className?: string;
}) {
  return (
    <div className={cn('flex flex-wrap items-end justify-between gap-3', className)}>
      <div className="min-w-0">
        <h1 className="font-display text-3xl tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function PageBody({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn('mx-auto w-full max-w-5xl px-6 py-8', className)}>{children}</div>;
}
