import { cn } from '@/lib/utils';
import type { ComponentType } from 'react';
export function FactCell({
  icon: Icon,
  label,
  value,
  mono = false,
  className,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  value: string;
  mono?: boolean;
  className?: string;
}) {
  return (
    <div className={cn('min-w-0 space-y-1', className)}>
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="flex min-w-0 items-center gap-1.5">
        <Icon className="text-muted-foreground size-4 shrink-0" />
        <span className={cn('truncate text-sm', mono && 'font-mono text-xs')} title={value}>
          {value}
        </span>
      </dd>
    </div>
  );
}
