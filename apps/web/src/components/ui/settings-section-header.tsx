import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';

/**
 * The one section header used across the Settings panel: title on the left,
 * optional description under it, one action on the right. Destructive rows use
 * this same component with a destructive-variant button in `action` — there is
 * no separate danger-zone header.
 */
export function SettingsSectionHeader({
  title,
  description,
  action,
  className,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4',
        className,
      )}
    >
      <div className="flex min-w-0 flex-col gap-1 text-base">
        <h2 className="font-regular text-foreground-strong text-base text-balance">{title}</h2>
        {description ? (
          <p className="font-regular text-foreground-weak max-w-[410px] text-sm text-pretty">
            {description}
          </p>
        ) : null}
      </div>
      {action ? (
        <div className="flex w-full min-w-0 items-center gap-4 sm:w-auto sm:justify-end">
          {action}
        </div>
      ) : null}
    </div>
  );
}
