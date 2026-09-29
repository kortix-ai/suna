import { DisclosureTrigger } from '@/components/ui/disclosure';
import { cn } from '@/lib/utils';
import { CaretRightIcon } from '@phosphor-icons/react';
import type { ReactNode } from 'react';

export function ChainStepTrigger({
  icon,
  label,
  trailing,
  status,
}: {
  icon: ReactNode;
  label: ReactNode;
  trailing?: ReactNode;
  status?: string;
}) {
  return (
    <DisclosureTrigger>
      <div
        data-status={status}
        className={cn(
          'text-foreground/80 hover:text-foreground',
          'flex w-full cursor-pointer items-center gap-3',
          'text-left text-sm leading-[1.5] transition-colors',
        )}
      >
        {icon}
        {label}
        {trailing}
        <CaretRightIcon
          className={cn(
            'text-muted-foreground/40 size-3.5 flex-none',
            'transition-transform group-data-[state=open]/step:rotate-90',
          )}
        />
      </div>
    </DisclosureTrigger>
  );
}
