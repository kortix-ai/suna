'use client';

import { cn } from '@/lib/utils';
import { SmileyMeltingIcon } from '@phosphor-icons/react';

export const Personalisation = ({ className }: { className?: string }) => {
  return <SmileyMeltingIcon weight="fill" className={cn('size-4', className)} />;
};
