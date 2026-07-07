'use client';

import { KortixLogo as UiKortixLogo } from '@/components/ui/kortix-logo';

interface KortixLogoProps {
  size?: number;
  variant?: 'symbol' | 'logomark';
  className?: string;
}

/**
 * Back-compat shim over the canonical `@/components/ui/kortix-logo` —
 * `symbol` maps to `icon`, `logomark` maps to `brandmark`. New code should
 * import the ui component directly.
 */
export function KortixLogo({ size = 24, variant = 'symbol', className }: KortixLogoProps) {
  return (
    <UiKortixLogo
      size={size}
      variant={variant === 'logomark' ? 'brandmark' : 'icon'}
      className={className}
    />
  );
}
