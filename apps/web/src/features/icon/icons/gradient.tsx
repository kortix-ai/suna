'use client';

import { cn } from '@/lib/utils';

export const Gradient = ({ className }: { className?: string }) => {
  return (
    <div
      className={cn('size-4 h-4 w-4 rounded-sm', className)}
      style={{
        background:
          'linear-gradient(180deg, #F7D6FF 0%, #005686 100%), linear-gradient(180deg, #FFFFFF 0%, #060046 100%), linear-gradient(130deg, #00FFA3 0%, #1A003C 100%), linear-gradient(307deg, #FF0000 0%, #3300C6 100%), radial-gradient(50% 72% at 50% 50%, #004584 0%, #00FFB2 100%), radial-gradient(100% 140% at 100% 0%, #5ED500 0%, #2200AA 100%)',
        backgroundBlendMode: 'soft-light, overlay, difference, difference, color-burn, normal',
      }}
    />
  );
};
