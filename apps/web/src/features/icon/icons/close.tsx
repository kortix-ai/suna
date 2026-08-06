'use client';

import { cn } from '@/lib/utils';
import { XIcon } from '@phosphor-icons/react';

export const Close = ({ className, ...props }: React.ComponentProps<typeof XIcon>) => {
  return <XIcon className={cn('size-4 stroke-1', className)} {...props} />;
};
